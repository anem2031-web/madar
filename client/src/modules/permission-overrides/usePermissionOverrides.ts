import { useCallback, useEffect, useRef, useState } from 'react';
import type { PermissionCode } from '../../../../shared/permissions/catalog.ts';
import { trpc } from '../../lib/trpc.ts';

export type PermissionAccount = {
  id: string; username: string; roleCode: string; accountStatus: 'active' | 'disabled'; authVersion: number;
};
export type PermissionOverride = { permissionCode: PermissionCode; effect: 'grant' | 'deny' };
export type PermissionDetail = {
  user: PermissionAccount;
  rolePermissions: PermissionCode[];
  overrides: PermissionOverride[];
  effectivePermissions: PermissionCode[];
  editable: boolean;
};
type ForegroundActions = { begin: () => boolean; end: (options?: { skipQueuedRefresh?: boolean }) => void };

const knownReasons = new Set([
  'OVERRIDES_INVALID_INPUT', 'OVERRIDES_NOT_FOUND', 'OVERRIDES_CONFLICT', 'OVERRIDES_SELF_CHANGE',
  'OVERRIDES_REAUTH_FAILED', 'OVERRIDES_UNAVAILABLE', 'AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'AUTH_CSRF',
  'AUTH_RATE_LIMITED', 'AUTH_UNAVAILABLE', 'AUTH_INVALID_CREDENTIALS',
]);

function reason(error: unknown, write: boolean) {
  const message = error instanceof Error ? error.message : '';
  return knownReasons.has(message) ? message : write ? 'OVERRIDES_UNCERTAIN' : 'OVERRIDES_UNAVAILABLE';
}

async function timed<T>(call: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  try { return await call(controller.signal); } finally { window.clearTimeout(timer); }
}

export function usePermissionOverrides(onSessionInvalid: () => void, foregroundActions: ForegroundActions) {
  const [users, setUsers] = useState<PermissionAccount[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<PermissionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<'saved' | 'unchanged' | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const mounted = useRef(true);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const busy = useRef(false);
  const invalidRef = useRef(onSessionInvalid);
  const foregroundRef = useRef(foregroundActions);
  invalidRef.current = onSessionInvalid;
  foregroundRef.current = foregroundActions;

  const handleSessionFailure = useCallback((failure: string) => {
    if (failure === 'AUTH_REQUIRED' || failure === 'AUTH_FORBIDDEN' || failure === 'AUTH_CSRF') {
      ++listGeneration.current; ++detailGeneration.current;
      setUsers([]); setDetail(null); setSelectedId(undefined); setNotice(null);
      setLoading(false); setDetailLoading(false); setReviewRequired(false);
      invalidRef.current();
    }
  }, []);

  const clearSelection = useCallback(() => {
    ++detailGeneration.current;
    setSelectedId(undefined); setDetail(null); setDetailLoading(false); setReviewRequired(false);
    setNotice(null); setError(null);
  }, []);

  const loadList = useCallback(async (pageCursor?: string, pageHistory?: (string | undefined)[]) => {
    const current = ++listGeneration.current;
    setLoading(true); setUsers([]); setError(null);
    try {
      const page = await timed(signal => trpc.permissionOverrides.list.query({ ...(pageCursor ? { cursor: pageCursor } : {}) }, { signal }));
      if (!mounted.current || current !== listGeneration.current) return;
      setUsers(page.users); setNextCursor(page.nextCursor); setCursor(pageCursor);
      if (pageHistory) setHistory(pageHistory);
    } catch (failure) {
      if (mounted.current && current === listGeneration.current) {
        const message = reason(failure, false);
        setError(message); handleSessionFailure(message);
      }
    } finally {
      if (mounted.current && current === listGeneration.current) setLoading(false);
    }
  }, [handleSessionFailure]);

  const loadDetail = useCallback(async (userId: string) => {
    const current = ++detailGeneration.current;
    setSelectedId(userId); setDetail(null); setDetailLoading(true);
    setError(null); setNotice(null);
    try {
      const next = await timed(signal => trpc.permissionOverrides.detail.query({ userId }, { signal }));
      if (!mounted.current || current !== detailGeneration.current) return;
      setDetail(next); setReviewRequired(false);
      setUsers(accounts => accounts.map(account => account.id === next.user.id ? next.user : account));
    } catch (failure) {
      if (mounted.current && current === detailGeneration.current) {
        const message = reason(failure, false);
        setError(message); handleSessionFailure(message);
      }
    } finally {
      if (mounted.current && current === detailGeneration.current) setDetailLoading(false);
    }
  }, [handleSessionFailure]);

  useEffect(() => {
    mounted.current = true;
    void loadList();
    return () => {
      mounted.current = false;
      ++listGeneration.current; ++detailGeneration.current;
      if (busy.current) invalidRef.current();
    };
  }, [loadList]);

  const save = useCallback(async (currentPassword: string, overrides: PermissionOverride[]) => {
    if (busy.current || !detail || !detail.editable || reviewRequired) return false;
    if (!foregroundRef.current.begin()) { setError('AUTH_REQUIRED'); return false; }
    busy.current = true;
    const current = ++detailGeneration.current;
    setPending(true); setError(null); setNotice(null);
    try {
      const outcome = await timed(signal => trpc.permissionOverrides.save.mutate({
        userId: detail.user.id, expectedAuthVersion: detail.user.authVersion, currentPassword, overrides,
      }, { signal }));
      if (!mounted.current || current !== detailGeneration.current) return false;
      setDetail(outcome.detail);
      setUsers(accounts => accounts.map(account => account.id === outcome.detail.user.id ? outcome.detail.user : account));
      setNotice(outcome.changed ? 'saved' : 'unchanged');
      return true;
    } catch (failure) {
      if (!mounted.current || current !== detailGeneration.current) return false;
      const message = reason(failure, true);
      setError(message);
      if (message === 'OVERRIDES_CONFLICT' || message === 'OVERRIDES_UNCERTAIN' || message === 'OVERRIDES_UNAVAILABLE' || message === 'AUTH_UNAVAILABLE') setReviewRequired(true);
      handleSessionFailure(message);
      return false;
    } finally {
      busy.current = false;
      foregroundRef.current.end();
      if (mounted.current) setPending(false);
    }
  }, [detail, handleSessionFailure, reviewRequired]);

  return {
    users, loading, detail, selectedId, detailLoading, pending, error, notice, reviewRequired,
    page: history.length + 1, hasPrevious: history.length > 0, hasNext: !!nextCursor,
    select: (userId: string) => { if (!busy.current) void loadDetail(userId); },
    reloadDetail: () => { if (!busy.current && selectedId) void loadDetail(selectedId); },
    refresh: () => { if (!busy.current) { clearSelection(); void loadList(cursor); } },
    next: () => {
      if (busy.current || !nextCursor) return;
      clearSelection(); void loadList(nextCursor, [...history, cursor]);
    },
    previous: () => {
      if (busy.current || !history.length) return;
      clearSelection(); const previous = history[history.length - 1];
      void loadList(previous, history.slice(0, -1));
    },
    save,
  };
}
