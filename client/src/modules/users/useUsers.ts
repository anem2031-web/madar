import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '../../lib/trpc.ts';

export type ManagedUser = {
  id: string;
  username: string;
  roleId: string;
  roleCode: string;
  accountStatus: 'active' | 'disabled';
  mustChangePassword: boolean;
  authVersion: number;
};
export type ManagedRole = { id: string; code: string; name: string };
export type UserAction = 'create' | 'role' | 'disable' | 'reset';
type Outcome = { user: ManagedUser; temporaryPassword?: string; callerSessionRevoked?: boolean };

const knownReasons = new Set([
  'USERS_INVALID_INPUT', 'USERS_DUPLICATE_USERNAME', 'USERS_NOT_FOUND', 'USERS_ROLE_NOT_FOUND',
  'USERS_CONFLICT', 'USERS_ALREADY_DISABLED', 'USERS_SELF_CHANGE',
  'USERS_REAUTH_FAILED', 'USERS_UNAVAILABLE', 'AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'AUTH_CSRF',
  'AUTH_INVALID_CREDENTIALS', 'AUTH_RATE_LIMITED', 'AUTH_UNAVAILABLE',
]);

function reason(error: unknown, write: boolean) {
  const message = error instanceof Error ? error.message : '';
  return knownReasons.has(message) ? message : write ? 'USERS_UNCERTAIN' : 'USERS_UNAVAILABLE';
}

async function timed<T>(call: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  try { return await call(controller.signal); } finally { window.clearTimeout(timer); }
}

export function useUsers(onSessionInvalid: () => void, onSelfResetResult: (username: string, password: string) => void, foregroundActions: {
  begin: () => boolean; end: (options?: { skipQueuedRefresh?: boolean }) => void;
}) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [roles, setRoles] = useState<ManagedRole[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<UserAction | null>(null);
  const [secret, setSecret] = useState<{ username: string; password: string } | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const busy = useRef(false);
  const onInvalidRef = useRef(onSessionInvalid);
  const onSelfResetRef = useRef(onSelfResetResult);
  const foregroundRef = useRef(foregroundActions);
  onInvalidRef.current = onSessionInvalid;
  onSelfResetRef.current = onSelfResetResult;
  foregroundRef.current = foregroundActions;

  const handleSessionFailure = useCallback((failure: string) => {
    if (failure === 'AUTH_REQUIRED' || failure === 'AUTH_FORBIDDEN' || failure === 'AUTH_CSRF') {
      setUsers([]); setRoles([]); setSecret(null);
      onInvalidRef.current();
    }
  }, []);

  const load = useCallback(async (pageCursor?: string) => {
    const current = ++generation.current;
    setLoading(true);
    setUsers([]);
    setError(null);
    try {
      const [page, roleList] = await Promise.all([
        timed(signal => trpc.users.list.query({ ...(pageCursor ? { cursor: pageCursor } : {}) }, { signal })),
        timed(signal => trpc.users.roles.query(undefined, { signal })),
      ]);
      if (!mounted.current || current !== generation.current) return false;
      setUsers(page.users);
      setRoles(roleList.roles);
      setNextCursor(page.nextCursor);
      setCursor(pageCursor);
      return true;
    } catch (failure) {
      if (mounted.current && current === generation.current) {
        const message = reason(failure, false);
        setError(message);
        setRoles([]);
        handleSessionFailure(message);
      }
      return false;
    } finally {
      if (mounted.current && current === generation.current) setLoading(false);
    }
  }, [handleSessionFailure]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      ++generation.current;
      // Browser back/route changes during a write must not leave an old authenticated view behind.
      if (busy.current) onInvalidRef.current();
    };
  }, [load]);

  useEffect(() => {
    const clear = () => { if (document.visibilityState === 'hidden') setSecret(null); };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, []);

  const mutate = useCallback(async (kind: UserAction, operation: (signal: AbortSignal) => Promise<Outcome>) => {
    if (busy.current) return false;
    if (!foregroundRef.current.begin()) { setError('AUTH_REQUIRED'); return false; }
    busy.current = true;
    ++generation.current;
    setPending(true); setError(null); setNotice(null); setSecret(null);
    try {
      const outcome = await timed(operation);
      if (!mounted.current) return false;
      if (outcome.callerSessionRevoked) {
        // The parent removes the authenticated subtree before any list refresh or further await.
        setUsers([]); setRoles([]); setSecret(null);
        foregroundRef.current.end({ skipQueuedRefresh: true });
        if (outcome.temporaryPassword && document.visibilityState === 'visible') {
          onSelfResetRef.current(outcome.user.username, outcome.temporaryPassword);
        } else {
          onInvalidRef.current();
        }
        return true;
      }
      setNotice(kind);
      if (outcome.temporaryPassword && document.visibilityState === 'visible') {
        setSecret({ username: outcome.user.username, password: outcome.temporaryPassword });
      }
      const refreshed = await load(kind === 'create' ? undefined : cursor);
      if (!mounted.current) return false;
      if (!refreshed) setError('USERS_REFRESH_FAILED');
      if (kind === 'create') setHistory([]);
      return true;
    } catch (failure) {
      if (!mounted.current) return false;
      const message = reason(failure, true);
      setError(message);
      handleSessionFailure(message);
      return false;
    } finally {
      busy.current = false;
      foregroundRef.current.end();
      if (mounted.current) setPending(false);
    }
  }, [cursor, handleSessionFailure, load]);

  return {
    users, roles, loading, pending, error, notice, secret, page: history.length + 1,
    hasPrevious: history.length > 0, hasNext: !!nextCursor,
    dismissSecret: () => setSecret(null),
    clearFeedback: () => { setError(null); setNotice(null); setSecret(null); },
    refresh: () => { if (!busy.current) { setSecret(null); void load(cursor); } },
    next: () => {
      if (busy.current || !nextCursor) return;
      setSecret(null); setHistory(pages => [...pages, cursor]); void load(nextCursor);
    },
    previous: () => {
      if (busy.current || !history.length) return;
      setSecret(null); const previous = history[history.length - 1]; setHistory(pages => pages.slice(0, -1)); void load(previous);
    },
    create: (username: string, roleId: string, currentPassword: string) => mutate('create', signal => trpc.users.create.mutate({ username, roleId, currentPassword }, { signal })),
    assignRole: (user: ManagedUser, roleId: string, currentPassword: string) => mutate('role', signal => trpc.users.assignRole.mutate({ userId: user.id, roleId, expectedAuthVersion: user.authVersion, currentPassword }, { signal })),
    disable: (user: ManagedUser, currentPassword: string) => mutate('disable', signal => trpc.users.disable.mutate({ userId: user.id, expectedAuthVersion: user.authVersion, currentPassword }, { signal })),
    resetPassword: (user: ManagedUser, currentPassword: string) => mutate('reset', signal => trpc.users.resetPassword.mutate({ userId: user.id, expectedAuthVersion: user.authVersion, currentPassword }, { signal })),
  };
}
