import { useCallback, useEffect, useRef, useState } from 'react';
import { setCsrfToken, trpc } from '../../lib/trpc.ts';
import { readRequestFailure } from '../../lib/request-failure.ts';
import { useRequestFailure } from '../../lib/useRequestFailure.ts';

export type SessionView = {
  state: 'anonymous' | 'password_change' | 'authenticated';
  csrfToken: string;
  user?: { username: string; roleCode: string; permissions: string[] };
  expiresAt?: string;
};
export type SessionReadOutcome = { sequence: number; status: 'success' | 'failure'; session: SessionView | null };

type RefreshMode = 'hard' | 'background';

function unexpired(session: SessionView | null) {
  const expiry = Date.parse(session?.expiresAt ?? '');
  return !!session && Number.isFinite(expiry) && expiry > Date.now();
}

function strongerRefresh(current: RefreshMode | null, requested: RefreshMode): RefreshMode {
  return current === 'hard' || requested === 'hard' ? 'hard' : 'background';
}

function pageIsVisible() { return document.visibilityState === 'visible'; }

const knownErrors = new Set([
  'AUTH_INVALID_CREDENTIALS', 'AUTH_RATE_LIMITED', 'AUTH_REQUIRED', 'AUTH_FORBIDDEN',
  'AUTH_CSRF', 'AUTH_INVALID_INPUT', 'AUTH_PASSWORD_POLICY', 'AUTH_PASSWORD_REUSED', 'AUTH_UNAVAILABLE',
]);

function safeReason(error: unknown, write = true) {
  return readRequestFailure(error, knownErrors, write ? 'AUTH_UNCERTAIN' : 'AUTH_UNAVAILABLE', write).code;
}

async function withTimeout<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  try { return await call(controller.signal); } finally { window.clearTimeout(timer); }
}

export function useAuth() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const { error, errorRequestId, setError } = useRequestFailure();
  const [notice, setNotice] = useState<'signedOut' | 'passwordChanged' | null>(null);
  const [readOutcome, setReadOutcome] = useState<SessionReadOutcome | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const foreground = useRef(false);
  const refreshQueued = useRef<RefreshMode | null>(null);
  const reading = useRef(false);
  const readGeneration = useRef(0);
  const readAgain = useRef<RefreshMode | null>(null);
  const mounted = useRef(true);
  const sessionRef = useRef<SessionView | null>(null);
  const activityDue = useRef(0);
  const readSequence = useRef(0);

  const accept = useCallback((next: SessionView | null) => {
    const expired = !!next && next.state !== 'anonymous' && !unexpired(next);
    const accepted = expired ? null : next;
    sessionRef.current = accepted;
    setCsrfToken(accepted?.csrfToken);
    setSession(accepted);
    if (expired) setError('AUTH_REQUIRED');
  }, []);

  const refresh = useCallback(async (mode: RefreshMode = 'hard'): Promise<void> => {
    const requested: RefreshMode = mode === 'background' && unexpired(sessionRef.current) ? 'background' : 'hard';
    if (requested === 'hard') {
      if (sessionRef.current) {
        ++generation.current;
        accept(null);
      }
      setLoading(true);
      setVerifying(false);
    }
    if (foreground.current || busy.current) {
      refreshQueued.current = strongerRefresh(refreshQueued.current, requested);
      return;
    }
    if (reading.current) {
      if (readGeneration.current !== generation.current) readAgain.current = strongerRefresh(readAgain.current, requested);
      return;
    }
    reading.current = true;
    const sequence = ++readSequence.current;
    readAgain.current = null;
    const current = ++generation.current;
    readGeneration.current = current;
    if (requested === 'background') {
      setVerifying(true);
    } else {
      accept(null);
      setLoading(true);
      setVerifying(false);
    }
    setError(null);
    try {
      const next = await withTimeout(signal => trpc.auth.session.query(undefined, { signal }));
      if (mounted.current && current === generation.current) {
        const trusted = next.state === 'anonymous' || unexpired(next) ? next : null;
        accept(next);
        setReadOutcome({ sequence, status: trusted ? 'success' : 'failure', session: trusted });
      }
    } catch (failure) {
      if (mounted.current && current === generation.current) {
        accept(null); setError(safeReason(failure, false), failure);
        setReadOutcome({ sequence, status: 'failure', session: null });
      }
    } finally {
      reading.current = false;
      if (mounted.current) {
        setVerifying(false);
        if (current === generation.current) setLoading(false);
      }
      if (mounted.current && readAgain.current && document.visibilityState === 'visible') {
        const queued = readAgain.current;
        readAgain.current = null;
        void refresh(queued);
      }
    }
  }, [accept]);

  const requestAccessRecheck = useCallback(() => {
    const expected = readSequence.current + 1;
    // A read that started before the denial cannot satisfy this recheck.
    if (reading.current) readAgain.current = strongerRefresh(readAgain.current, 'background');
    else if (pageIsVisible()) void refresh('background');
    return expected;
  }, [refresh]);

  const invalidateSession = useCallback(() => {
    ++generation.current;
    accept(null);
    setLoading(false);
    setVerifying(false);
    setError(null);
    setNotice(null);
  }, [accept]);

  const beginForeground = useCallback(() => {
    if (!pageIsVisible()) return false;
    if (sessionRef.current && !unexpired(sessionRef.current)) { void refresh(); return false; }
    if (busy.current || reading.current || foreground.current || sessionRef.current?.state !== 'authenticated') return false;
    foreground.current = true;
    ++generation.current;
    setPending(true);
    return true;
  }, [refresh]);

  const endForeground = useCallback((options?: { skipQueuedRefresh?: boolean }) => {
    if (!foreground.current) return;
    foreground.current = false;
    setPending(false);
    const queued = refreshQueued.current;
    refreshQueued.current = null;
    if (queued && !options?.skipQueuedRefresh && document.visibilityState === 'visible') void refresh(queued);
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        ++generation.current;
        if (!unexpired(sessionRef.current)) {
          accept(null);
          setLoading(true);
        }
      } else { void refresh('background'); }
    };
    const onPageShow = () => { void refresh('background'); };
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      const current = sessionRef.current;
      const expiresAt = Date.parse(current?.expiresAt ?? '');
      // A simple window focus is not a loss of the already verified session.
      if (current && Number.isFinite(expiresAt) && expiresAt > Date.now()) return;
      void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      ++generation.current;
      setCsrfToken();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
    };
  }, [accept, refresh]);

  const mutate = useCallback(async (operation: (signal: AbortSignal) => Promise<SessionView>, kind: 'login' | 'password' | 'logout') => {
    if (!pageIsVisible() || busy.current || foreground.current || reading.current) return;
    busy.current = true;
    ++generation.current;
    setPending(true);
    setError(null);
    setNotice(null);
    if (kind === 'logout') {
      sessionRef.current = null;
      setSession(null);
    }
    let successful = false;
    try {
      const next = await withTimeout(operation);
      if (!mounted.current) return;
      successful = true;
      accept(document.visibilityState === 'hidden' ? null : next);
      setLoading(document.visibilityState === 'hidden');
      if (kind === 'logout') setNotice('signedOut');
      if (kind === 'password') setNotice('passwordChanged');
    } catch (failure) {
      if (!mounted.current) return;
      const reason = safeReason(failure);
      if (kind === 'logout' || reason === 'AUTH_UNCERTAIN' || reason === 'AUTH_UNAVAILABLE' || reason === 'AUTH_REQUIRED' || reason === 'AUTH_CSRF') accept(null);
      setError(kind === 'logout' ? 'AUTH_LOGOUT_UNCERTAIN' : reason, failure);
      setLoading(false);
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(false);
        const queued = refreshQueued.current;
        refreshQueued.current = null;
        if (document.visibilityState === 'visible') {
          if (queued === 'hard') void refresh();
          else if (successful && !unexpired(sessionRef.current)) void refresh();
          else if (!successful && queued) void refresh(queued);
        }
      }
    }
  }, [accept, refresh]);

  useEffect(() => {
    if (!session?.expiresAt || session.state === 'anonymous') return;
    const delay = Math.max(0, Date.parse(session.expiresAt) - Date.now());
    const timer = window.setTimeout(() => {
      invalidateSession();
      if (foreground.current) {
        refreshQueued.current = 'hard';
      } else { void refresh(); }
    }, Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [session, refresh, invalidateSession]);

  useEffect(() => {
    if (session?.state !== 'authenticated') return;
    let reporting = false;
    const reportActivity = (event: Event) => {
      if (!event.isTrusted || !sessionRef.current || sessionRef.current.state !== 'authenticated' || foreground.current || busy.current || reading.current || reporting || document.visibilityState !== 'visible' || Date.now() < activityDue.current) return;
      reporting = true;
      activityDue.current = Date.now() + 60_000;
      const current = generation.current;
      void withTimeout(signal => trpc.auth.activity.mutate(undefined, { signal })).then(next => {
        if (mounted.current && current === generation.current && sessionRef.current) accept(next);
      }).catch(failure => {
        if (mounted.current && current === generation.current) { accept(null); setLoading(false); setError(safeReason(failure, false), failure); }
      }).finally(() => { reporting = false; });
    };
    window.addEventListener('pointerdown', reportActivity, { passive: true });
    window.addEventListener('keydown', reportActivity);
    return () => {
      window.removeEventListener('pointerdown', reportActivity);
      window.removeEventListener('keydown', reportActivity);
    };
  }, [session?.state, accept]);

  return {
    session, loading, pending, verifying, error, errorRequestId, notice, readOutcome, requestAccessRecheck, refresh, invalidateSession, beginForeground, endForeground,
    login: (username: string, password: string) => mutate(signal => trpc.auth.login.mutate({ username, password }, { signal }), 'login'),
    changePassword: (currentPassword: string, newPassword: string) => mutate(signal => trpc.auth.changePassword.mutate({ currentPassword, newPassword }, { signal }), 'password'),
    logout: () => mutate(signal => trpc.auth.logout.mutate(undefined, { signal }), 'logout'),
  };
}
