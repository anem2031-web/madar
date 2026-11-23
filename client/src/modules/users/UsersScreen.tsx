import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Language } from '../../i18n/locale.ts';
import { userMessages } from './locale.ts';
import type { UserLabels } from './locale.ts';
import { useUsers } from './useUsers.ts';
import type { ManagedRole, ManagedUser, UserAction } from './useUsers.ts';
import { TemporaryPasswordPanel } from './TemporaryPasswordPanel.tsx';
import { usePasswordPrivacy } from '../auth/password-privacy.ts';

type Selection = { kind: 'create' } | { kind: 'role' | 'disable' | 'reset'; user: ManagedUser };

function roleName(role: { code: string; name: string } | undefined, labels: UserLabels) {
  if (!role) return labels.noRole;
  return role.code === 'system_admin' ? labels.adminRole : role.code === 'hr' ? labels.hrRole : role.name;
}

function errorText(error: string, labels: UserLabels) {
  const map: Record<string, keyof UserLabels> = {
    USERS_INVALID_INPUT: 'invalidInput', USERS_DUPLICATE_USERNAME: 'duplicate',
    USERS_NOT_FOUND: 'notFound', USERS_ROLE_NOT_FOUND: 'notFound', USERS_CONFLICT: 'conflict',
    USERS_ALREADY_DISABLED: 'conflict', USERS_SELF_CHANGE: 'selfChange', USERS_REAUTH_FAILED: 'reauthFailed',
    USERS_UNAVAILABLE: 'requestFailed', USERS_UNCERTAIN: 'uncertain', USERS_REFRESH_FAILED: 'refreshFailed',
    AUTH_REQUIRED: 'sessionExpired', AUTH_FORBIDDEN: 'forbidden', AUTH_CSRF: 'csrfFailed',
    AUTH_INVALID_CREDENTIALS: 'reauthFailed', AUTH_RATE_LIMITED: 'rateLimited', AUTH_UNAVAILABLE: 'requestFailed',
  };
  return labels[map[error] ?? 'requestFailed'];
}

function AccountForm({ selection, roles, labels, pending, disabled, onSubmit, onCancel, selfReset }: {
  selection: Selection; roles: ManagedRole[]; labels: UserLabels; pending: boolean;
  onSubmit: (username: string, roleId: string, password: string) => Promise<boolean>;
  onCancel: () => void;
  selfReset: boolean;
  disabled: boolean;
}) {
  const [username, setUsername] = useState('');
  const [roleId, setRoleId] = useState(selection.kind === 'role' ? selection.user.roleId : '');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const formRef = usePasswordPrivacy(() => { setPassword(''); setVisible(false); });
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const title = selection.kind === 'create' ? labels.createHeading : selection.kind === 'role' ? labels.roleHeading : selection.kind === 'disable' ? labels.disableHeading : labels.resetHeading;
  const help = selection.kind === 'create' ? labels.createHelp : selection.kind === 'role' ? labels.roleHelp : selection.kind === 'disable' ? labels.disableHelp : selfReset ? labels.selfResetHelp : labels.resetHelp;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    // Password managers can update the native field without firing React's change event.
    const submittedPassword = new FormData(form).get('manager-current-password');
    const currentPassword = typeof submittedPassword === 'string' ? submittedPassword : '';
    if (!currentPassword || Array.from(currentPassword).length > 128
      || (selection.kind === 'create' && (!username.trim() || Array.from(username.trim()).length > 64))
      || ((selection.kind === 'role' || selection.kind === 'create') && !roles.some(role => role.id === roleId))) {
      setInvalid(true); return;
    }
    const passwordField = form.elements.namedItem('manager-current-password');
    if (passwordField instanceof HTMLInputElement) passwordField.value = '';
    setPassword(''); setVisible(false); setInvalid(false);
    await onSubmit(username.trim(), roleId, currentPassword);
  };
  return (
    <section className="users-editor" aria-labelledby="account-form-heading">
      <h3 id="account-form-heading" ref={heading} tabIndex={-1} className="text-lg font-bold outline-none">{title}</h3>
      {selection.kind !== 'create' && <p className="mt-1 font-semibold"><bdi>{selection.user.username}</bdi></p>}
      <p className="mt-2 text-sm leading-7 text-muted">{help}</p>
      <form ref={formRef} className="auth-form" onSubmit={submit} noValidate aria-busy={pending}>
        <fieldset className="contents" disabled={disabled}>
          {selection.kind === 'create' && <label className="field" htmlFor="managed-username"><span>{labels.username}</span><input id="managed-username" name="managed-username" dir="ltr" autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} required onChange={event => { setUsername(event.target.value); setInvalid(false); }} aria-invalid={invalid || undefined} aria-describedby={invalid ? 'managed-form-error' : undefined} /></label>}
          {(selection.kind === 'create' || selection.kind === 'role') && <label className="field" htmlFor="managed-role"><span>{labels.role}</span><select id="managed-role" value={roleId} required onChange={event => { setRoleId(event.target.value); setInvalid(false); }} aria-invalid={invalid || undefined} aria-describedby={invalid ? 'managed-form-error' : undefined}><option value="">{labels.chooseRole}</option>{roles.map(role => <option key={role.id} value={role.id}>{roleName(role, labels)}</option>)}</select></label>}
          <label className="field" htmlFor="manager-current-password"><span>{labels.currentPassword}</span><input id="manager-current-password" name="manager-current-password" dir="ltr" type={visible ? 'text' : 'password'} autoComplete="current-password" value={password} required onChange={event => { setPassword(event.target.value); setInvalid(false); }} aria-describedby={invalid ? 'reauth-help managed-form-error' : 'reauth-help'} aria-invalid={invalid || undefined} /></label>
          <p id="reauth-help" className="field-hint">{labels.reauthHelp}</p>
          <label className="password-toggle"><input type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} />{visible ? labels.hidePassword : labels.showPassword}</label>
          {invalid && <p id="managed-form-error" role="alert" className="feedback feedback-error">{labels.invalidInput}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <button type="submit" className="primary-button">{pending ? labels.working : selection.kind === 'create' ? labels.addUser : selection.kind === 'disable' ? labels.confirmDisable : selection.kind === 'reset' ? labels.confirmReset : labels.save}</button>
            <button type="button" className="control" onClick={onCancel}>{labels.cancel}</button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

export function UsersScreen({ language, actorUsername, verificationPending, onSessionInvalid, onSelfResetResult, foregroundActions }: {
  language: Language; actorUsername: string; onSessionInvalid: () => void;
  verificationPending: boolean;
  onSelfResetResult: (username: string, password: string) => void;
  foregroundActions: { begin: () => boolean; end: (options?: { skipQueuedRefresh?: boolean }) => void };
}) {
  const labels = userMessages[language];
  const accounts = useUsers(onSessionInvalid, onSelfResetResult, foregroundActions);
  const [selection, setSelection] = useState<Selection | null>(null);
  const { users, roles, loading, pending, error, notice, secret } = accounts;
  const blocked = pending || verificationPending;

  const select = (value: Selection) => { accounts.clearFeedback(); setSelection(value); };
  const submit = async (username: string, roleId: string, password: string) => {
    if (!selection) return false;
    let success: boolean;
    if (selection.kind === 'create') success = await accounts.create(username, roleId, password);
    else if (selection.kind === 'role') success = await accounts.assignRole(selection.user, roleId, password);
    else if (selection.kind === 'disable') success = await accounts.disable(selection.user, password);
    else success = await accounts.resetPassword(selection.user, password);
    if (success) setSelection(null);
    return success;
  };
  const noticeLabel: Record<UserAction, string> = { create: labels.created, role: labels.roleChanged, disable: labels.accountDisabled, reset: labels.passwordReset };

  return (
    <section className="users-content" aria-labelledby="users-heading">
      <header className="users-heading-row"><div><h2 id="users-heading" className="card-title">{labels.heading}</h2><p className="card-description">{labels.description}</p></div><button type="button" className="primary-button users-add" disabled={blocked || loading} onClick={() => select({ kind: 'create' })}>{labels.addUser}</button></header>
      {notice && <p role="status" className="feedback feedback-success">{noticeLabel[notice]}</p>}
      {error && <p role="alert" className="feedback feedback-error">{errorText(error, labels)}</p>}
      {secret && <TemporaryPasswordPanel username={secret.username} password={secret.password} labels={labels} onDismiss={accounts.dismissSecret} />}
      {selection && <AccountForm key={selection.kind + (selection.kind === 'create' ? '' : selection.user.id)} selection={selection} roles={roles} labels={labels} pending={pending} disabled={blocked} onSubmit={submit} onCancel={() => setSelection(null)} selfReset={selection.kind === 'reset' && selection.user.username === actorUsername} />}
      <p className="mt-5 text-sm text-muted">{labels.selfActionsNote}</p>
      <div className="users-list-toolbar"><button type="button" className="control" disabled={blocked || loading} onClick={() => { setSelection(null); accounts.refresh(); }}>{labels.refresh}</button><p className="text-sm text-muted">{labels.page} {accounts.page.toLocaleString(language)}</p></div>
      {loading ? <p role="status" className="py-8 text-center text-muted">{labels.loading}</p> : users.length === 0 ? <p className="py-8 text-center text-muted">{labels.empty}</p> : (
        <div className="users-table-wrapper"><table className="users-table"><thead><tr><th scope="col">{labels.username}</th><th scope="col">{labels.role}</th><th scope="col">{labels.status}</th><th scope="col">{labels.passwordState}</th><th scope="col">{labels.actions}</th></tr></thead><tbody>{users.map(user => <tr key={user.id}><th scope="row"><bdi>{user.username}</bdi></th><td>{roleName(roles.find(role => role.id === user.roleId), labels)}</td><td><span className={user.accountStatus === 'active' ? 'status-badge status-active' : 'status-badge status-disabled'}>{user.accountStatus === 'active' ? labels.active : labels.disabled}</span></td><td>{user.mustChangePassword ? labels.temporary : labels.permanent}</td><td><div className="users-actions"><button type="button" className="control" disabled={blocked || user.username === actorUsername} onClick={() => select({ kind: 'role', user })}>{labels.changeRole}</button><button type="button" className="control" disabled={blocked || user.accountStatus === 'disabled' || user.username === actorUsername} onClick={() => select({ kind: 'disable', user })}>{labels.disable}</button><button type="button" className="control" disabled={blocked} onClick={() => select({ kind: 'reset', user })}>{labels.resetPassword}</button></div></td></tr>)}</tbody></table></div>
      )}
      <nav className="users-pagination" aria-label={labels.heading}><button type="button" className="control" disabled={blocked || loading || !accounts.hasPrevious} onClick={() => { setSelection(null); accounts.previous(); }}>{labels.previous}</button><button type="button" className="control" disabled={blocked || loading || !accounts.hasNext} onClick={() => { setSelection(null); accounts.next(); }}>{labels.next}</button></nav>
    </section>
  );
}
