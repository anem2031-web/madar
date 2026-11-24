import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditCursor, AuditDeliveryStatus, AuditEventDetail, AuditEventSummary } from '../../../../shared/audit/contracts.ts';
import { trpc } from '../../lib/trpc.ts';
import { readRequestFailure, requestReference } from '../../lib/request-failure.ts';
import { useRequestFailure } from '../../lib/useRequestFailure.ts';
import type { AccessFailureHandlers } from '../auth/access-failures.ts';
import { defaultAuditDraft, normalizeAuditFilters, refreshAuditWindow } from './filters.ts';
import type { AuditFilters } from './filters.ts';

const knownReasons = new Set(['AUDIT_INVALID_INPUT', 'AUDIT_NOT_FOUND', 'AUDIT_UNAVAILABLE', 'AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'AUTH_CSRF', 'AUTH_RATE_LIMITED', 'AUTH_UNAVAILABLE']);
const reason = (failure: unknown) => readRequestFailure(failure, knownReasons, 'AUDIT_UNAVAILABLE').code;
async function timed<T>(controller: AbortController, call: (signal: AbortSignal) => Promise<T>) {
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  try { return await call(controller.signal); } finally { window.clearTimeout(timer); }
}

export function useAudit(accessHandlers: AccessFailureHandlers) {
  const [initialDraft] = useState(defaultAuditDraft);
  const [filters, setFilters] = useState<AuditFilters>(() => {
    const initial = normalizeAuditFilters(initialDraft);
    if ('error' in initial) throw new Error('Invalid initial audit period.');
    return initial.filters;
  });
  const [events, setEvents] = useState<AuditEventSummary[]>([]);
  const [delivery, setDelivery] = useState<AuditDeliveryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const { error, errorRequestId, setError } = useRequestFailure();
  const [detail, setDetail] = useState<AuditEventDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const { error: detailError, errorRequestId: detailErrorRequestId, setError: setDetailError } = useRequestFailure();
  const [cursor, setCursor] = useState<AuditCursor>();
  const [nextCursor, setNextCursor] = useState<AuditCursor>();
  const [history, setHistory] = useState<(AuditCursor | undefined)[]>([]);
  const [rolling, setRolling] = useState(true);
  const mounted = useRef(true);
  const listGeneration = useRef(0), detailGeneration = useRef(0);
  const listController = useRef<AbortController | null>(null), detailController = useRef<AbortController | null>(null);
  const accessRef = useRef(accessHandlers);
  accessRef.current = accessHandlers;
  const clearDetail = useCallback(() => {
    ++detailGeneration.current; detailController.current?.abort();
    setDetail(null); setDetailError(null); setDetailLoading(false);
  }, []);
  const handleAccessFailure = useCallback((message: string, entry: boolean, failure: unknown) => {
    if (message === 'AUTH_FORBIDDEN' && !entry) { accessRef.current.onActionForbidden(); return; }
    if (message === 'AUTH_REQUIRED' || message === 'AUTH_CSRF' || message === 'AUTH_FORBIDDEN') {
      ++listGeneration.current; listController.current?.abort(); clearDetail();
      setEvents([]); setDelivery(null); setLoading(false);
      if (message === 'AUTH_FORBIDDEN') accessRef.current.onReadForbidden(requestReference(failure));
      else accessRef.current.onSessionInvalid();
    }
  }, [clearDetail]);
  const load = useCallback(async (nextFilters: AuditFilters, next?: AuditCursor, nextHistory?: (AuditCursor | undefined)[], rollingMode?: boolean) => {
    const current = ++listGeneration.current;
    listController.current?.abort();
    const controller = new AbortController(); listController.current = controller;
    clearDetail(); setEvents([]); setDelivery(null); setLoading(true); setError(null);
    try {
      const page = await timed(controller, signal => trpc.audit.list.query({ ...nextFilters, ...(next ? { cursor: next } : {}) }, { signal }));
      if (!mounted.current || current !== listGeneration.current) return;
      setEvents(page.events); setDelivery(page.delivery); setFilters(nextFilters); setCursor(next); setNextCursor(page.nextCursor);
      if (nextHistory) setHistory(nextHistory);
      if (rollingMode !== undefined) setRolling(rollingMode);
    } catch (failure) {
      if (mounted.current && current === listGeneration.current) { const message = reason(failure); setError(message, failure); handleAccessFailure(message, true, failure); }
    } finally {
      if (mounted.current && current === listGeneration.current) setLoading(false);
    }
  }, [clearDetail, handleAccessFailure]);
  const initialFilters = useRef(filters);
  useEffect(() => {
    mounted.current = true; void load(initialFilters.current);
    return () => { mounted.current = false; ++listGeneration.current; ++detailGeneration.current; listController.current?.abort(); detailController.current?.abort(); };
  }, [load]);
  const openDetail = useCallback(async (eventId: string) => {
    const current = ++detailGeneration.current;
    detailController.current?.abort();
    const controller = new AbortController(); detailController.current = controller;
    setDetail(null); setDetailError(null); setDetailLoading(true);
    try {
      const response = await timed(controller, signal => trpc.audit.detail.query({ eventId }, { signal }));
      if (mounted.current && current === detailGeneration.current) setDetail(response.event);
    } catch (failure) {
      if (mounted.current && current === detailGeneration.current) { const message = reason(failure); setDetailError(message, failure); handleAccessFailure(message, false, failure); }
    } finally {
      if (mounted.current && current === detailGeneration.current) setDetailLoading(false);
    }
  }, [handleAccessFailure]);
  return {
    initialDraft, filters, rolling, events, delivery, loading, error, errorRequestId, detail, detailError, detailErrorRequestId, detailLoading,
    page: history.length + 1, hasPrevious: history.length > 0, hasNext: !!nextCursor,
    apply: (nextFilters: AuditFilters, rollingMode: boolean) => { void load(refreshAuditWindow(nextFilters, rollingMode), undefined, [], rollingMode); },
    refresh: () => { void load(refreshAuditWindow(filters, rolling), rolling ? undefined : cursor, rolling ? [] : undefined); },
    next: () => { if (nextCursor) void load(filters, nextCursor, [...history, cursor]); },
    previous: () => { if (history.length) void load(filters, history.at(-1), history.slice(0, -1)); },
    openDetail, closeDetail: clearDetail,
  };
}
