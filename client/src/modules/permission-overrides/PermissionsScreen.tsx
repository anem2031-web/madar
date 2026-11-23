import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { permissionCodes } from '../../../../shared/permissions/catalog.ts';
import type { PermissionCode } from '../../../../shared/permissions/catalog.ts';
import type { Language } from '../../i18n/locale.ts';
import { usePasswordPrivacy } from '../auth/password-privacy.ts';
import { permissionLabelKeys, permissionMessages } from './locale.ts';
import type { PermissionLabels } from './locale.ts';
import { usePermissionOverrides } from './usePermissionOverrides.ts';
import type { PermissionDetail, PermissionOverride } from './usePermissionOverrides.ts';

function roleName(code: string, labels: PermissionLabels) {
  return code === 'system_admin' ? labels.adminRole : code === 'hr' ? labels.hrRole : code;
}

function errorText(error: string, labels: PermissionLabels) {
  const keys: Record<string, keyof PermissionLabels> = {
    OVERRIDES_INVALID_INPUT: 'invalidInput', OVERRIDES_NOT_FOUND: 'notFound', OVERRIDES_CONFLICT: 'conflict',
    OVERRIDES_SELF_CHANGE: 'selfChange', OVERRIDES_REAUTH_FAILED: 'reauthFailed',
    OVERRIDES_UNAVAILABLE: 'requestFailed', OVERRIDES_UNCERTAIN: 'uncertain',
    AUTH_REQUIRED: 'sessionExpired', AUTH_FORBIDDEN: 'forbidden', AUTH_CSRF: 'csrfFailed',
    AUTH_RATE_LIMITED: 'rateLimited', AUTH_UNAVAILABLE: 'requestFailed', AUTH_INVALID_CREDENTIALS: 'reauthFailed',
  };
  return labels[keys[error] ?? 'requestFailed'];
}

function PermissionEditor({ detail, labels, actorUsername, disabled, pending, reviewRequired, onSave }: {
  detail: PermissionDetail; labels: PermissionLabels; actorUsername: string;
  disabled: boolean; pending: boolean; reviewRequired: boolean;
  onSave: (currentPassword: string, overrides: PermissionOverride[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Partial<Record<PermissionCode, 'grant' | 'deny'>>>(() => Object.fromEntries(detail.overrides.map(override => [override.permissionCode, override.effect])));
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const formRef = usePasswordPrivacy(() => { setPassword(''); setVisible(false); });
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || reviewRequired || !detail.editable) return;
    const form = event.currentTarget;
    // Read the native value so password-manager autofill cannot leave stale React state.
    const submittedPassword = new FormData(form).get('permissions-current-password');
    const currentPassword = typeof submittedPassword === 'string' ? submittedPassword : '';
    if (!currentPassword || Array.from(currentPassword).length > 128) { setInvalid(true); return; }
    const overrides: PermissionOverride[] = [];
    for (const permissionCode of permissionCodes) {
      const effect = draft[permissionCode];
      if (effect) overrides.push({ permissionCode, effect });
    }
    const passwordField = form.elements.namedItem('permissions-current-password');
    if (passwordField instanceof HTMLInputElement) passwordField.value = '';
    setPassword(''); setVisible(false); setInvalid(false);
    await onSave(currentPassword, overrides);
  };

  return (
    <section className="min-w-0" aria-labelledby="permission-editor-heading">
      <h3 ref={headingRef} tabIndex={-1} id="permission-editor-heading" className="text-lg font-bold outline-none">{labels.accountPermissions}</h3>
      <dl className="account-details mt-4">
        <div><dt>{labels.selectedAccount}</dt><dd><bdi>{detail.user.username}</bdi></dd></div>
        <div><dt>{labels.role}</dt><dd><bdi>{roleName(detail.user.roleCode, labels)}</bdi></dd></div>
        <div><dt>{labels.status}</dt><dd>{detail.user.accountStatus === 'active' ? labels.active : labels.disabled}</dd></div>
      </dl>
      <p className="field-hint mt-3">{labels.roleReadOnly}</p>
      <p id="permission-result-help" className="field-hint mt-2">{labels.resultHelp}</p>
      {!detail.editable && <p role="note" className="mt-4 rounded-xl border border-line bg-slate-50 p-4 text-sm leading-7">{labels.selfReadOnly}</p>}
      <form ref={formRef} className="auth-form" onSubmit={submit} noValidate aria-busy={pending} aria-describedby="permission-result-help">
        <fieldset disabled={disabled || !detail.editable || reviewRequired} className="contents">
          <legend className="sr-only">{labels.customization}</legend>
          <div className="grid min-w-0 gap-3">
            {permissionCodes.map(code => {
              const name = labels[permissionLabelKeys[code]];
              const granted = detail.rolePermissions.includes(code);
              const allowed = detail.effectivePermissions.includes(code);
              return (
                <div key={code} className="grid min-w-0 gap-4 rounded-xl border border-line p-4 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,13rem)] sm:items-center">
                  <div className="min-w-0">
                    <label htmlFor={`override-${code}`} className="block text-sm font-semibold">{name}</label>
                    <p className="mt-2 text-xs leading-6 text-muted">{labels.roleGrant}: {granted ? labels.grantedByRole : labels.absentFromRole}</p>
                    <p className="mt-1 text-xs leading-6"><span className="text-muted">{labels.savedResult}: </span><strong className={allowed ? 'text-brand' : 'text-danger'}>{allowed ? labels.allowed : labels.denied}</strong></p>
                  </div>
                  <div className="field">
                    <span className="text-xs text-muted">{labels.customization}</span>
                    <select id={`override-${code}`} value={draft[code] ?? 'inherit'} onChange={event => {
                      const effect = event.target.value;
                      setDraft(previous => {
                        const next = { ...previous };
                        if (effect === 'grant' || effect === 'deny') next[code] = effect;
                        else delete next[code];
                        return next;
                      });
                    }}>
                      <option value="inherit">{labels.inherit}</option>
                      <option value="grant">{labels.grant}</option>
                      <option value="deny">{labels.deny}</option>
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
          {detail.editable && <>
            <p className="field-hint">{labels.saveHelp}</p>
            <label className="field" htmlFor="permissions-actor-username"><span>{labels.confirmationAccount}</span><input id="permissions-actor-username" name="permissions-actor-username" dir="ltr" autoComplete="section-permissions username" value={actorUsername} readOnly aria-describedby="permissions-reauth-help" /></label>
            <label className="field" htmlFor="permissions-current-password"><span>{labels.currentPassword}</span><input id="permissions-current-password" name="permissions-current-password" dir="ltr" type={visible ? 'text' : 'password'} autoComplete="section-permissions current-password" value={password} required onChange={event => { setPassword(event.target.value); setInvalid(false); }} aria-invalid={invalid || undefined} aria-describedby={invalid ? 'permissions-reauth-help permissions-form-error' : 'permissions-reauth-help'} /></label>
            <p id="permissions-reauth-help" className="field-hint">{labels.reauthHelp}</p>
            <label className="password-toggle"><input type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} />{visible ? labels.hidePassword : labels.showPassword}</label>
            {invalid && <p role="alert" id="permissions-form-error" className="feedback feedback-error">{labels.invalidInput}</p>}
            <button type="submit" className="primary-button">{pending ? labels.working : labels.save}</button>
          </>}
        </fieldset>
      </form>
    </section>
  );
}

export function PermissionsScreen({ language, actorUsername, verificationPending, onSessionInvalid, foregroundActions }: {
  language: Language; actorUsername: string; verificationPending: boolean;
  onSessionInvalid: () => void;
  foregroundActions: { begin: () => boolean; end: (options?: { skipQueuedRefresh?: boolean }) => void };
}) {
  const labels = permissionMessages[language];
  const permissions = usePermissionOverrides(onSessionInvalid, foregroundActions);
  const { users, loading, detail, detailLoading, pending, selectedId, error, notice, reviewRequired } = permissions;
  const blocked = pending || verificationPending;

  return (
    <section className="w-full min-w-0" aria-labelledby="permissions-heading">
      <h2 id="permissions-heading" className="card-title">{labels.heading}</h2>
      <p className="card-description">{labels.description}</p>
      {error && <p role="alert" className="feedback feedback-error">{errorText(error, labels)}</p>}
      {notice && <p role="status" className="feedback feedback-success">{labels[notice]}</p>}
      <div className="mt-7 grid min-w-0 gap-8 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <section className="min-w-0" aria-labelledby="permission-accounts-heading">
          <h3 id="permission-accounts-heading" className="text-lg font-bold">{labels.accounts}</h3>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <button type="button" className="control" disabled={blocked || loading} onClick={permissions.refresh}>{labels.refreshAccounts}</button>
            <p className="text-xs text-muted">{labels.page} {permissions.page.toLocaleString(language)}</p>
          </div>
          {loading ? <p role="status" className="py-6 text-sm text-muted">{labels.loading}</p> : !users.length ? <p className="py-6 text-sm text-muted">{labels.empty}</p> : (
            <ul className="mt-4 grid min-w-0 gap-3">{users.map(user => (
              <li key={user.id} className="min-w-0">
                <button type="button" className={`control grid w-full min-w-0 gap-1 p-3 text-start ${selectedId === user.id ? 'bg-brand/8' : ''}`} aria-pressed={selectedId === user.id} disabled={blocked} onClick={() => permissions.select(user.id)}>
                  <bdi className="min-w-0 break-all text-sm font-semibold">{user.username}</bdi>
                  <span className="min-w-0 break-words text-xs text-muted">{roleName(user.roleCode, labels)}</span>
                  <span className="text-xs text-muted">{user.accountStatus === 'active' ? labels.active : labels.disabled}</span>
                </button>
              </li>
            ))}</ul>
          )}
          <nav className="mt-4 flex flex-wrap justify-between gap-3" aria-label={labels.accounts}>
            <button type="button" className="control" disabled={blocked || loading || !permissions.hasPrevious} onClick={permissions.previous}>{labels.previous}</button>
            <button type="button" className="control" disabled={blocked || loading || !permissions.hasNext} onClick={permissions.next}>{labels.next}</button>
          </nav>
        </section>
        <div className="min-w-0">
          {selectedId && <button type="button" className="control mb-5" disabled={blocked || detailLoading} onClick={permissions.reloadDetail}>{labels.refreshDetail}</button>}
          {reviewRequired && <p role="status" className="mb-5 text-sm leading-7 text-muted">{labels.reviewRequired}</p>}
          {detailLoading ? <p role="status" className="py-6 text-sm text-muted">{labels.loadingDetail}</p> : detail ? (
            <PermissionEditor key={`${detail.user.id}:${detail.user.authVersion}`} detail={detail} labels={labels} actorUsername={actorUsername} disabled={blocked} pending={pending} reviewRequired={reviewRequired} onSave={permissions.save} />
          ) : <p className="py-6 text-sm text-muted">{labels.chooseAccount}</p>}
        </div>
      </div>
    </section>
  );
}
