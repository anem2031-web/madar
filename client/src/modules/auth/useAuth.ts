import { useCallback, useEffect, useRef, useState } from 'react';
import { setCsrfToken, trpc } from '../../lib/trpc.ts';

export type SessionView = {
  state: 'anonymous' | 'password_change' | 'authenticated';
  csrfToken: string;
  user?: { username: string; roleCode: string; permissions: string[] };
  expiresAt?: string;
};

const knownErrors = new Set([
  'AUTH_INVALID_CREDENTIALS', 'AUTH_RATE_LIMITED', 'AUTH_REQUIRED', 'AUTH_FORBIDDEN',
  'AUTH_CSRF', 'AUTH_INVALID_INPUT', 'AUTH_PASSWORD_POLICY', 'AUTH_PASSWORD_REUSED', 'AUTH_UNAVAILABLE',
]);

function safeReason(error: unknown) {
  const reason = error instanceof Error ? error.message : '';
  return knownErrors.has(reason) ? reason : 'AUTH_UNCERTAIN';
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<'signedOut' | 'passwordChanged' | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const foreground = useRef(false);
  const refreshQueued = useRef(false);
  const reading = useRef(false);
  const readGeneration = useRef(0);
  const readAgain = useRef(false);
  const mounted = useRef(true);
  const sessionRef = useRef<SessionView | null>(null);
  const activityDue = useRef(0);

  const accept = useCallback((next: SessionView | null) => {
    sessionRef.current = next;
    setCsrfToken(next?.csrfToken);
    setSession(next);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (foreground.current) { refreshQueued.current = true; return; }
    if (busy.current) return;
    if (reading.current) {
      if (readGeneration.current !== generation.current) readAgain.current = true;
      return;
    }
    reading.current = true;
    const current = ++generation.current;
    readGeneration.current = current;
    accept(null);
    setLoading(true);
    setError(null);
    try {
      const next = await withTimeout(signal => trpc.auth.session.query(undefined, { signal }));
      if (mounted.current && current === generation.current) accept(next);
    } catch {
      if (mounted.current && current === generation.current) setError('AUTH_UNAVAILABLE');
    } finally {
      reading.current = false;
      if (mounted.current && current === generation.current) setLoading(false);
      if (mounted.current && readAgain.current && document.visibilityState === 'visible') {
        readAgain.current = false;
        void refresh();
      }
    }
  }, [accept]);

  const invalidateSession = useCallback(() => {
    ++generation.current;
    accept(null);
    setLoading(false);
    setError(null);
    setNotice(null);
  }, [accept]);

  const beginForeground = useCallback(() => {
    if (busy.current || reading.current || foreground.current || sessionRef.current?.state !== 'authenticated') return false;
    foreground.current = true;
    ++generation.current;
    setPending(true);
    return true;
  }, []);

  const endForeground = useCallback((options?: { skipQueuedRefresh?: boolean }) => {
    if (!foreground.current) return;
    foreground.current = false;
    setPending(false);
    const queued = refreshQueued.current;
    refreshQueued.current = false;
    if (queued && !options?.skipQueuedRefresh && document.visibilityState === 'visible') void refresh();
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        ++generation.current;
        sessionRef.current = null;
        setSession(null);
        if (!busy.current && !foreground.current) setCsrfToken();
        setLoading(true);
      } else { void refresh(); }
    };
    const onPageShow = () => { void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onPageShow);
    return () => {
      mounted.current = false;
      ++generation.current;
      setCsrfToken();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onPageShow);
    };
  }, [accept, refresh]);

  const mutate = useCallback(async (operation: (signal: AbortSignal) => Promise<SessionView>, kind: 'login' | 'password' | 'logout') => {
    if (busy.current || foreground.current) return;
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
      setError(kind === 'logout' ? 'AUTH_LOGOUT_UNCERTAIN' : reason);
      setLoading(false);
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(false);
        if (successful && document.visibilityState === 'visible' && !sessionRef.current) void refresh();
      }
    }
  }, [accept, refresh]);

  useEffect(() => {
    if (!session?.expiresAt || session.state === 'anonymous') return;
    const delay = Math.max(0, Date.parse(session.expiresAt) - Date.now());
    const timer = window.setTimeout(() => {
      if (foreground.current) {
        invalidateSession();
        refreshQueued.current = true;
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
      }).catch(() => {
        if (mounted.current && current === generation.current) { accept(null); setLoading(false); setError('AUTH_REQUIRED'); }
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
    session, loading, pending, error, notice, refresh, invalidateSession, beginForeground, endForeground,
    login: (username: string, password: string) => mutate(signal => trpc.auth.login.mutate({ username, password }, { signal }), 'login'),
    changePassword: (currentPassword: string, newPassword: string) => mutate(signal => trpc.auth.changePassword.mutate({ currentPassword, newPassword }, { signal }), 'password'),
    logout: () => mutate(signal => trpc.auth.logout.mutate(undefined, { signal }), 'logout'),
  };
}
