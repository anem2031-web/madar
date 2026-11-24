import { useCallback, useEffect, useRef, useState } from 'react';
import { resolvePageAccess } from '../../../../shared/permissions/pages.ts';
import type { PageAccessDecision } from '../../../../shared/permissions/pages.ts';
import { replaceNavigation } from '../../app/navigation.ts';
import type { AccessFailureHandlers } from './access-failures.ts';
import type { useAuth } from './useAuth.ts';

type Auth = ReturnType<typeof useAuth>;
type Incident = { pathname: string; username: string; minimumSequence: number; phase: 'checking' | 'conflict'; requestId?: string };
export type ClientPageDecision = PageAccessDecision | { kind: 'access-conflict'; requestId?: string };

export function usePageGuard(pathname: string, auth: Auth) {
  const [incident, setIncident] = useState<Incident | null>(null);
  const incidentRef = useRef<Incident | null>(null);
  const displayedPath = useRef<string | null>(null);
  const updateIncident = useCallback((value: Incident | null) => { incidentRef.current = value; setIncident(value); }, []);
  const base = resolvePageAccess({ pathname, session: auth.loading
    ? { state: 'checking' }
    : !auth.session ? { state: 'unavailable' }
    : { state: auth.session.state, permissions: auth.session.user?.permissions } });
  const username = auth.session?.state === 'authenticated' ? auth.session.user?.username : undefined;

  useEffect(() => {
    const current = incidentRef.current;
    if (current && (current.pathname !== pathname || current.username !== username)) updateIncident(null);
  }, [pathname, username, updateIncident]);
  useEffect(() => {
    const current = incidentRef.current;
    const outcome = auth.readOutcome;
    if (!current || current.phase !== 'checking' || !outcome || outcome.sequence < current.minimumSequence) return;
    if (outcome.status === 'failure' || outcome.session?.state !== 'authenticated'
      || outcome.session.user?.username !== current.username) { updateIncident(null); return; }
    const next = resolvePageAccess({ pathname: current.pathname, session: {
      state: 'authenticated', permissions: outcome.session.user.permissions,
    } });
    // One actual read is the whole automatic recovery budget. Never retry page data here.
    updateIncident(next.kind === 'render' || next.kind === 'workspace' ? { ...current, phase: 'conflict' } : null);
  }, [auth.readOutcome, updateIncident]);

  let decision: ClientPageDecision = base;
  const currentIncident = incident?.pathname === pathname && incident.username === username ? incident : null;
  if (username && currentIncident && (base.kind === 'render' || base.kind === 'workspace')) {
    decision = currentIncident.phase === 'checking' ? { kind: 'checking' } : { kind: 'access-conflict', requestId: currentIncident.requestId };
  }
  // An existing checked page may keep its draft during a background check; a new route may not mount.
  if (auth.verifying && displayedPath.current !== pathname) decision = { kind: 'checking' };
  useEffect(() => {
    if (!auth.verifying && (decision.kind === 'render' || decision.kind === 'workspace')) displayedPath.current = pathname;
  }, [pathname, auth.verifying, decision.kind]);
  const redirectKey = decision.kind === 'redirect' ? `${pathname}:${decision.target}` : null;
  const lastRedirect = useRef<string | null>(null);
  useEffect(() => {
    if (decision.kind !== 'redirect' || auth.verifying) { if (!redirectKey) lastRedirect.current = null; return; }
    if (lastRedirect.current === redirectKey) return;
    lastRedirect.current = redirectKey;
    replaceNavigation(decision.target);
  }, [decision, auth.verifying, redirectKey]);

  const onReadForbidden = useCallback((requestId?: string) => {
    if (!username || incidentRef.current) return;
    const minimumSequence = auth.requestAccessRecheck();
    updateIncident({ pathname, username, minimumSequence, phase: 'checking', requestId });
  }, [pathname, username, auth.requestAccessRecheck, updateIncident]);
  const onActionForbidden = useCallback(() => { void auth.refresh('background'); }, [auth.refresh]);
  const onSessionInvalid = useCallback(() => { auth.invalidateSession(); void auth.refresh(); }, [auth.invalidateSession, auth.refresh]);
  const retry = useCallback(() => { updateIncident(null); void auth.refresh(); }, [auth.refresh, updateIncident]);
  const accessHandlers: AccessFailureHandlers = { onSessionInvalid, onReadForbidden, onActionForbidden };
  return { decision, accessHandlers, retry };
}
