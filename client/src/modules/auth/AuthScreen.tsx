import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { messages } from '../../i18n/locale.ts';
import { RequestFailure, RequestReference } from '../../components/feedback/RequestFailure.tsx';
import type { Language } from '../../i18n/locale.ts';
import { useAuth } from './useAuth.ts';
import { navigate, usePathname } from '../../app/navigation.ts';
import { userMessages } from '../users/locale.ts';
import { TemporaryPasswordPanel } from '../users/TemporaryPasswordPanel.tsx';
import { usePasswordPrivacy } from './password-privacy.ts';
import { organizationMessages } from '../organization/locale.ts';
import { permissionMessages } from '../permission-overrides/locale.ts';
import { numberingMessages } from '../settings/numbering/locale.ts';
import { auditMessages } from '../audit/locale.ts';

import { getAllowedLandingPages } from '../../../../shared/permissions/pages.ts';
import type { ProtectedPageId } from '../../../../shared/permissions/pages.ts';
import { protectedPageComponents } from './ProtectedPageContent.tsx';
import { usePageGuard } from './usePageGuard.ts';

type Labels = typeof messages.ar;

function errorLabel(error: string, labels: Labels) {
  const keys: Record<string, keyof Labels> = {
    AUTH_INVALID_CREDENTIALS: 'invalidCredentials', AUTH_RATE_LIMITED: 'rateLimited',
    AUTH_REQUIRED: 'sessionExpired', AUTH_FORBIDDEN: 'forbidden', AUTH_CSRF: 'csrfFailed',
    AUTH_INVALID_INPUT: 'invalidInput', AUTH_PASSWORD_POLICY: 'passwordPolicy',
    AUTH_PASSWORD_REUSED: 'passwordReused', AUTH_UNAVAILABLE: 'requestFailed',
    AUTH_UNCERTAIN: 'operationUncertain', AUTH_LOGOUT_UNCERTAIN: 'logoutUncertain',
  };
  return labels[keys[error] ?? 'requestFailed'];
}

function PasswordForm({ labels, pending, disabled, onSubmit }: {
  labels: Labels;
  pending: boolean;
  disabled: boolean;
  onSubmit: (current: string, next: string) => Promise<void>;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false);
  const [validation, setValidation] = useState<'invalidInput' | 'passwordPolicy' | 'passwordMismatch' | null>(null);
  const form = usePasswordPrivacy(() => { setCurrent(''); setNext(''); setConfirmation(''); setVisible(false); });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!current || Array.from(current).length > 128) { setValidation('invalidInput'); return; }
    if (Array.from(next).length < 15 || Array.from(next).length > 128) { setValidation('passwordPolicy'); return; }
    if (next !== confirmation) { setValidation('passwordMismatch'); return; }
    const oldPassword = current;
    const newPassword = next;
    setCurrent(''); setNext(''); setConfirmation(''); setValidation(null); setVisible(false);
    await onSubmit(oldPassword, newPassword);
  };
  return (
    <form ref={form} onSubmit={submit} noValidate className="auth-form" aria-busy={pending}>
      <fieldset disabled={disabled} className="contents">
        <label className="field" htmlFor="current-password"><span>{labels.currentPassword}</span><input id="current-password" name="current-password" dir="ltr" type={visible ? 'text' : 'password'} autoComplete="current-password" required aria-invalid={validation === 'invalidInput' || undefined} aria-describedby={validation === 'invalidInput' ? 'password-form-error' : undefined} value={current} onChange={event => { setCurrent(event.target.value); setValidation(null); }} /></label>
        <label className="field" htmlFor="new-password"><span>{labels.newPassword}</span><input id="new-password" name="new-password" dir="ltr" type={visible ? 'text' : 'password'} autoComplete="new-password" required aria-invalid={validation === 'passwordPolicy' || undefined} aria-describedby={validation === 'passwordPolicy' ? 'password-hint password-form-error' : 'password-hint'} value={next} onChange={event => { setNext(event.target.value); setValidation(null); }} /></label>
        <p id="password-hint" className="field-hint">{labels.passwordHint}</p>
        <label className="field" htmlFor="confirm-password"><span>{labels.confirmPassword}</span><input id="confirm-password" name="confirm-password" dir="ltr" type={visible ? 'text' : 'password'} autoComplete="new-password" required aria-invalid={validation === 'passwordMismatch' || undefined} aria-describedby={validation === 'passwordMismatch' ? 'password-form-error' : undefined} value={confirmation} onChange={event => { setConfirmation(event.target.value); setValidation(null); }} /></label>
        {validation && <p role="alert" className="feedback feedback-error" id="password-form-error">{labels[validation]}</p>}
        <label className="password-toggle"><input type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} />{visible ? labels.hidePassword : labels.showPassword}</label>
        <button type="submit" className="primary-button">{pending ? labels.saving : labels.savePassword}</button>
      </fieldset>
    </form>
  );
}

function LoginForm({ labels, pending, disabled, onSubmit }: {
  labels: Labels;
  pending: boolean;
  disabled: boolean;
  onSubmit: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const form = usePasswordPrivacy(() => { setPassword(''); setVisible(false); });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || Array.from(username).length > 64 || !password || Array.from(password).length > 128) { setInvalid(true); return; }
    const submittedPassword = password;
    setPassword(''); setVisible(false); setInvalid(false);
    await onSubmit(username, submittedPassword);
  };
  return (
    <form ref={form} onSubmit={submit} noValidate className="auth-form" aria-busy={pending}>
      <fieldset disabled={disabled} className="contents">
        <label className="field" htmlFor="username"><span>{labels.username}</span><input id="username" name="username" dir="ltr" autoComplete="username" autoCapitalize="none" spellCheck={false} required aria-invalid={invalid || undefined} aria-describedby={invalid ? 'login-form-error' : undefined} value={username} onChange={event => { setUsername(event.target.value); setInvalid(false); }} /></label>
        <label className="field" htmlFor="password"><span>{labels.password}</span><input id="password" name="password" dir="ltr" type={visible ? 'text' : 'password'} autoComplete="current-password" required aria-invalid={invalid || undefined} aria-describedby={invalid ? 'login-form-error' : undefined} value={password} onChange={event => { setPassword(event.target.value); setInvalid(false); }} /></label>
        {invalid && <p role="alert" className="feedback feedback-error" id="login-form-error">{labels.invalidInput}</p>}
        <label className="password-toggle"><input type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} />{visible ? labels.hidePassword : labels.showPassword}</label>
        <button type="submit" className="primary-button">{pending ? labels.loggingIn : labels.login}<span aria-hidden="true">↗</span></button>
      </fieldset>
    </form>
  );
}

export function AuthScreen({ language }: { language: Language }) {
  const labels = messages[language];
  const userLabels = userMessages[language];
  const permissionLabels = permissionMessages[language];
  const organizationLabels = organizationMessages[language];
  const numberingLabels = numberingMessages[language];
  const auditLabels = auditMessages[language];
  const path = usePathname();
  const auth = useAuth();
  const guard = usePageGuard(path, auth);
  const [selfResetResult, setSelfResetResult] = useState<{ username: string; password: string; path: string; expiresAt: number } | null>(null);
  const { session, pending, verifying, error, notice } = auth;
  const blocked = pending || verifying;
  const verificationStatus = verifying ? <p role="status" className="mb-4 text-sm text-muted">{labels.checking}</p> : null;
  useEffect(() => {
    if (selfResetResult && session && session.state !== 'anonymous') setSelfResetResult(null);
  }, [selfResetResult, session]);
  useEffect(() => {
    if (!selfResetResult) return;
    const clear = () => setSelfResetResult(null);
    const onVisibility = () => { if (document.visibilityState === 'hidden') clear(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('popstate', clear);
    const timer = window.setTimeout(clear, Math.max(0, selfResetResult.expiresAt - Date.now()));
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('popstate', clear);
      window.clearTimeout(timer);
    };
  }, [selfResetResult]);
  const receiveSelfReset = (username: string, password: string) => {
    const expiresAt = Date.parse(session?.expiresAt ?? '');
    if (document.visibilityState === 'visible' && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
      setSelfResetResult({ username, password, path, expiresAt });
    }
    // Clear all account data and obtain only a fresh anonymous CSRF context.
    auth.invalidateSession();
    void auth.refresh();
  };
  if (selfResetResult && selfResetResult.path === path && (!session || session.state === 'anonymous')) return (
    <div className="mx-auto w-full max-w-xl">
      <TemporaryPasswordPanel username={selfResetResult.username} password={selfResetResult.password} labels={userLabels} signedOut onDismiss={() => {
        setSelfResetResult(null);
        navigate('/');
        void auth.refresh();
      }} />
    </div>
  );
  if (guard.decision.kind === 'checking' || guard.decision.kind === 'redirect' || (pending && !session)) return (
    <div className="state-panel" role="status" aria-live="polite">
      <span className="loading-ring" aria-hidden="true" /><h2 className="card-title">{pending ? labels.working : labels.checking}</h2><p className="text-muted">{labels.checkingDescription}</p>
    </div>
  );
  if (guard.decision.kind === 'unavailable') return (
    <div className="state-panel">
      <span className="state-symbol" aria-hidden="true">!</span><h2 className="card-title">{labels.unavailable}</h2>
      {error ? <RequestFailure message={errorLabel(error, labels)} code={error} requestId={auth.errorRequestId} language={language} /> : <p className="text-muted" role="alert">{labels.unavailableDescription}</p>}
      <button type="button" className="primary-button mt-5" disabled={pending} onClick={guard.retry}>{labels.retry}</button>
    </div>
  );
  const pageLabels = {
    organization: organizationLabels.openOrganization,
    users: userLabels.openUsers,
    permissions: permissionLabels.openPermissions,
    numbering: numberingLabels.openNumbering,
    audit: auditLabels.openAudit,
  } satisfies Record<ProtectedPageId, string>;
  const allowedPages = getAllowedLandingPages(session?.user?.permissions ?? []);
  if (guard.decision.kind === 'not-found') return (
    <div className="state-panel">
      <h2 className="card-title">{labels.notFoundHeading}</h2><p className="text-muted">{labels.notFoundDescription}</p>
      <button type="button" className="control mt-5" disabled={blocked} onClick={() => navigate('/')}>{userLabels.back}</button>
    </div>
  );
  if (guard.decision.kind === 'no-access' || guard.decision.kind === 'access-conflict') return (
    <div className="state-panel">
      <h2 className="card-title">{guard.decision.kind === 'no-access' ? labels.noPagesHeading : labels.accessConflictHeading}</h2>
      <p className="text-muted" role="alert">{guard.decision.kind === 'no-access' ? labels.noPagesDescription : labels.accessConflictDescription}</p>
      {guard.decision.kind === 'access-conflict' && <RequestReference requestId={guard.decision.requestId} language={language} />}
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <button type="button" className="control" disabled={blocked} onClick={guard.retry}>{labels.retry}</button>
        <button type="button" className="control" disabled={blocked} onClick={() => { void auth.logout(); }}>{labels.logout}</button>
      </div>
    </div>
  );
  const role = session?.user?.roleCode;
  const roleName = role === 'system_admin' ? labels.adminRole : role === 'hr' ? labels.hrRole : labels.assignedRole;
  if (guard.decision.kind === 'render' && session?.state === 'authenticated' && session.user) {
    const PageView = protectedPageComponents[guard.decision.page.id];
    return (
      <div className="w-full min-w-0">
        <nav className="workspace-nav flex-wrap" aria-label={labels.workspace}>
          <button type="button" className="control" onClick={() => navigate('/')} disabled={blocked}>{userLabels.back}</button>
          {allowedPages.map(page => <a key={page.id} href={page.path} className="control" aria-current={page.path === path ? 'page' : undefined} aria-disabled={blocked || undefined} onClick={event => { event.preventDefault(); if (!blocked) navigate(page.path); }}>{pageLabels[page.id]}</a>)}
          <button type="button" className="control" onClick={() => { void auth.logout(); }} disabled={blocked}>{pending ? labels.working : labels.logout}</button>
        </nav>
        {verificationStatus}
        <PageView key={session.user.username + ':' + guard.decision.page.id} language={language} username={session.user.username} permissions={session.user.permissions}
          verifying={verifying} accessHandlers={guard.accessHandlers} onSelfResetResult={receiveSelfReset}
          foregroundActions={{ begin: auth.beginForeground, end: auth.endForeground }} />
      </div>
    );
  }
  if (!session) return null;
  return (
    <div className="auth-content">
      {verificationStatus}
      {session.state === 'authenticated' ? (
        <>
          <span className="success-symbol" aria-hidden="true">✓</span>
          <h2 className="card-title mt-4">{labels.welcome}</h2>
          <p className="card-description">{labels.signedIn}</p>
          {notice && <p role="status" className="feedback feedback-success">{labels[notice]}</p>}
          {error && <RequestFailure message={errorLabel(error, labels)} code={error} requestId={auth.errorRequestId} language={language} />}
          <dl className="account-details"><div><dt>{labels.account}</dt><dd dir="auto">{session.user?.username}</dd></div><div><dt>{labels.role}</dt><dd>{roleName}</dd></div></dl>
          <p className="workspace-note">{labels.workspaceNote}</p>
          {allowedPages.map(page => <a key={page.id} href={page.path} className="primary-button mt-3" aria-disabled={blocked || undefined} onClick={event => { event.preventDefault(); if (!blocked) navigate(page.path); }}>{pageLabels[page.id]}</a>)}
          <p className="field-hint mt-5">{labels.sessionNote}</p>
          <button type="button" className="control mt-6 w-full" disabled={blocked} onClick={() => { void auth.logout(); }}>{pending ? labels.working : labels.logout}</button>
        </>
      ) : (
        <>
          <span className="section-eyebrow">{labels.appName}</span>
          <h2 className="card-title">{session.state === 'password_change' ? labels.changePasswordHeading : labels.loginHeading}</h2>
          <p className="card-description">{session.state === 'password_change' ? labels.changePasswordDescription : labels.loginDescription}</p>
          {notice && <p role="status" className="feedback feedback-success">{labels[notice]}</p>}
          {error && <RequestFailure message={errorLabel(error, labels)} code={error} requestId={auth.errorRequestId} language={language} />}
          {session.state === 'password_change'
            ? <PasswordForm labels={labels} pending={pending} disabled={blocked} onSubmit={auth.changePassword} />
            : <LoginForm labels={labels} pending={pending} disabled={blocked} onSubmit={auth.login} />}
          {session.state === 'password_change'
            ? <button type="button" className="control mt-4 w-full" disabled={blocked} onClick={() => { void auth.logout(); }}>{labels.logout}</button>
            : <p className="account-help">{labels.accountHelp}</p>}
        </>
      )}
    </div>
  );
}
