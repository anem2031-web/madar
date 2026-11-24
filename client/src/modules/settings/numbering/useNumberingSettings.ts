import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreateNumberingSeries, NumberingSeries, UpdateNumberingSeries } from '../../../../../shared/numbering/settings.ts';
import { trpc } from '../../../lib/trpc.ts';
import { requestReference } from '../../auth/access-failures.ts';
import type { AccessFailureHandlers } from '../../auth/access-failures.ts';

type ForegroundActions = { begin: () => boolean; end: (options?: { skipQueuedRefresh?: boolean }) => void };
type Notice = { kind: 'created' | 'updated' | 'unchanged'; code?: string };
const knownReasons = new Set([
  'NUMBERING_INVALID_INPUT', 'NUMBERING_INVALID_PREFIX', 'NUMBERING_DUPLICATE_CODE', 'NUMBERING_DUPLICATE_PREFIX',
  'NUMBERING_NOT_FOUND', 'NUMBERING_CONFLICT', 'NUMBERING_LOCKED', 'NUMBERING_UNAVAILABLE',
  'AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'AUTH_CSRF', 'AUTH_RATE_LIMITED', 'AUTH_UNAVAILABLE',
]);
function reason(error: unknown, write: boolean) {
  const message = error instanceof Error ? error.message : '';
  return knownReasons.has(message) ? message : write ? 'NUMBERING_UNCERTAIN' : 'NUMBERING_UNAVAILABLE';
}
async function timed<T>(call: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  try { return await call(controller.signal); } finally { window.clearTimeout(timer); }
}

export function useNumberingSettings(accessHandlers: AccessFailureHandlers, foregroundActions: ForegroundActions) {
  const [series, setSeries] = useState<NumberingSeries[]>([]);
  const [selected, setSelected] = useState<NumberingSeries | null>(null);
  const [calendarYear, setCalendarYear] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const busy = useRef(false);
  const pageDenied = useRef(false);
  const accessRef = useRef(accessHandlers);
  const foregroundRef = useRef(foregroundActions);
  accessRef.current = accessHandlers;
  foregroundRef.current = foregroundActions;

  const handleAccessFailure = useCallback((message: string, source: 'page' | 'operation', original: unknown) => {
    if (message === 'AUTH_FORBIDDEN') {
      if (source === 'operation') { accessRef.current.onActionForbidden(); return; }
      pageDenied.current = true; ++generation.current;
      setSeries([]); setSelected(null); setLoading(false); setNotice(null);
      accessRef.current.onReadForbidden(requestReference(original));
    } else if (message === 'AUTH_REQUIRED' || message === 'AUTH_CSRF') {
      ++generation.current; setSeries([]); setSelected(null); setLoading(false); setNotice(null);
      accessRef.current.onSessionInvalid();
    }
  }, []);
  const load = useCallback(async (pageCursor?: string, pageHistory?: (string | undefined)[]) => {
    const current = ++generation.current;
    setLoading(true); setSeries([]); setError(null);
    try {
      const page = await timed(signal => trpc.numberingSettings.list.query({ ...(pageCursor ? { cursor: pageCursor } : {}) }, { signal }));
      if (!mounted.current || current !== generation.current) return false;
      setSeries(page.series); setCalendarYear(page.calendarYear); setCursor(pageCursor); setNextCursor(page.nextCursor);
      if (pageHistory) setHistory(pageHistory);
      return true;
    } catch (failure) {
      if (mounted.current && current === generation.current) {
        const message = reason(failure, false); setError(message); handleAccessFailure(message, 'page', failure);
      }
      return false;
    } finally {
      if (mounted.current && current === generation.current) setLoading(false);
    }
  }, [handleAccessFailure]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false; ++generation.current;
      if (busy.current && !pageDenied.current) accessRef.current.onSessionInvalid();
    };
  }, [load]);

  async function mutate<T>(operation: (signal: AbortSignal) => Promise<T>, apply: (outcome: T) => Promise<boolean>) {
    if (busy.current || loading || reviewRequired) return false;
    if (!foregroundRef.current.begin()) { setError('AUTH_REQUIRED'); return false; }
    busy.current = true; ++generation.current;
    setPending(true); setError(null); setNotice(null);
    try {
      const outcome = await timed(operation);
      if (!mounted.current) return false;
      const refreshed = await apply(outcome);
      if (mounted.current && !refreshed) { setError('NUMBERING_REFRESH_FAILED'); setReviewRequired(true); }
      return true;
    } catch (failure) {
      if (!mounted.current) return false;
      const message = reason(failure, true); setError(message);
      if (['NUMBERING_UNCERTAIN', 'NUMBERING_UNAVAILABLE', 'AUTH_UNAVAILABLE', 'NUMBERING_CONFLICT', 'NUMBERING_LOCKED', 'NUMBERING_NOT_FOUND'].includes(message)) setReviewRequired(true);
      handleAccessFailure(message, 'operation', failure);
      return false;
    } finally {
      busy.current = false;
      foregroundRef.current.end();
      if (mounted.current) setPending(false);
    }
  }
  return {
    series, selected, calendarYear, loading, pending, error, notice, reviewRequired,
    page: history.length + 1, hasPrevious: history.length > 0, hasNext: !!nextCursor,
    select: (value: NumberingSeries) => { if (!busy.current) { setSelected(value); setError(null); setNotice(null); } },
    clearFeedback: () => { if (!busy.current) { setError(null); setNotice(null); } },
    refresh: async () => {
      if (busy.current) return;
      setSelected(null); setNotice(null);
      if (await load(cursor)) setReviewRequired(false);
    },
    next: () => {
      if (busy.current || !nextCursor) return;
      setSelected(null); setNotice(null); void load(nextCursor, [...history, cursor]);
    },
    previous: () => {
      if (busy.current || !history.length) return;
      setSelected(null); setNotice(null); void load(history.at(-1), history.slice(0, -1));
    },
    create: (input: CreateNumberingSeries) => mutate(signal => trpc.numberingSettings.create.mutate(input, { signal }), async outcome => {
      const refreshed = await load(undefined, []);
      if (mounted.current && !pageDenied.current) {
        setSelected(outcome.series); setNotice({ kind: 'created', code: outcome.series.code });
      }
      return refreshed;
    }),
    update: (input: UpdateNumberingSeries) => mutate(signal => trpc.numberingSettings.update.mutate(input, { signal }), async outcome => {
      setSeries(rows => rows.map(value => value.id === outcome.series.id ? outcome.series : value));
      setSelected(outcome.series);
      setNotice({ kind: outcome.changed ? 'updated' : 'unchanged', code: outcome.changed ? outcome.series.code : undefined });
      return true;
    }),
  };
}
