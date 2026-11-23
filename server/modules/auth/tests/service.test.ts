import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { hashPassword } from '../../../core/auth/password.ts';
import { createAuthService } from '../service.ts';
import type { AuthRequest, AuthResult } from '../service.ts';
import type { AuthUser } from '../store.ts';
import { createMemoryAuthStore } from './memory-store.ts';

const password = 'Temporary password 2026';
let passwordHash = '';
beforeAll(async () => { passwordHash = await hashPassword(password); });

function fixture(temporary = false) {
  let now = new Date('2026-11-23T09:00:00Z');
  const user: AuthUser = { id: randomUUID(), username: 'ADMIN', passwordHash, roleId: randomUUID(), roleCode: 'system_admin',
    accountStatus: 'active', mustChangePassword: temporary, authVersion: 1, rolePermissions: ['employees.read', 'users.manage'], overrides: [] };
  const store = createMemoryAuthStore([user]);
  const auth = createAuthService(store, { origin: 'http://localhost:3000', secret: 'a'.repeat(48), now: () => now });
  let request: AuthRequest = { origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID() };
  const accept = (result: AuthResult) => { request = { ...request, token: result.token ?? request.token, csrf: result.view.csrfToken }; return result; };
  return { store, auth, user, get request() { return request; }, accept,
    setTime(value: number) { now = new Date(value); }, advance(minutes: number) { now = new Date(now.getTime() + minutes * 60_000); },
    async login() { accept(await auth.session(request)); return accept(await auth.login(request, { username: 'admin', password })); } };
}

test('temporary password cannot pass permission guard; replacement rotates and revokes while retaining original absolute limit', async () => {
  const f = fixture(true);
  expect((await f.login()).view.state).toBe('password_change');
  const old = { ...f.request };
  await expect(f.auth.requirePermission(f.request, 'employees.read')).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  f.advance(10);
  const changed = f.accept(await f.auth.changePassword(f.request, { currentPassword: password, newPassword: 'A new private password 2026' }));
  expect(changed.view.state).toBe('authenticated');
  expect(changed.token).not.toBe(old.token);
  expect((await f.auth.session(old)).view.state).toBe('anonymous');
  const active = [...f.store.sessions.values()].find(value => value.stage === 'authenticated');
  expect(active?.absoluteExpiresAt?.toISOString()).toBe('2026-11-23T17:00:00.000Z');
  expect(f.store.users.get(f.user.id)?.authVersion).toBe(2);
});

test('session polling does not extend idle deadline; expiry is enforced at thirty minutes', async () => {
  const f = fixture(); const login = await f.login();
  f.advance(29);
  expect((await f.auth.session(f.request)).view.expiresAt).toBe(login.view.expiresAt);
  f.advance(1);
  await expect(f.auth.requirePermission(f.request, 'employees.read')).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
});

test('activity extends idle only within the original eight-hour bound', async () => {
  const f = fixture(); await f.login();
  for (let i = 0; i < 16; i++) { f.advance(29); f.accept(await f.auth.activity(f.request)); }
  expect(f.store.sessions.size).toBe(2);
  expect((await f.auth.session(f.request)).view.expiresAt).toBe('2026-11-23T17:00:00.000Z');
  f.advance(16);
  await expect(f.auth.requirePermission(f.request, 'employees.read')).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
});

test('explicit user deny overrides system-admin grant and role changes apply on the next request', async () => {
  const f = fixture(); await f.login();
  expect(await f.auth.requirePermission(f.request, 'employees.read')).toMatchObject({ scope: 'all_branches' });
  f.store.users.get(f.user.id)!.overrides = [{ permissionCode: 'employees.read', effect: 'deny' }];
  await expect(f.auth.requirePermission(f.request, 'employees.read')).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(f.store.events.at(-1)?.result).toBe('denied');
  f.store.users.get(f.user.id)!.accountStatus = 'disabled';
  await expect(f.auth.requirePermission(f.request, 'users.manage')).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
});

test('Origin and session-bound CSRF cannot be bypassed', async () => {
  const f = fixture(); f.accept(await f.auth.session(f.request));
  for (const altered of [{ origin: 'https://evil.invalid' }, { csrf: 'wrong' }, { token: 'a'.repeat(43) }]) {
    await expect(f.auth.login({ ...f.request, ...altered }, { username: 'admin', password })).rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  }
  expect(f.store.events.every(value => !value.actorUserId)).toBe(true);
});

test('login and password changes roll back if their durable audit insert fails', async () => {
  const f = fixture(true); f.accept(await f.auth.session(f.request)); f.store.setAuditFailure(true);
  await expect(f.auth.login(f.request, { username: 'admin', password })).rejects.toThrow('Synthetic audit failure.');
  expect([...f.store.sessions.values()].filter(value => value.userId)).toHaveLength(0);
  f.store.setAuditFailure(false); await f.login(); f.store.setAuditFailure(true);
  await expect(f.auth.changePassword(f.request, { currentPassword: password, newPassword: 'A new private password 2026' })).rejects.toThrow('Synthetic audit failure.');
  expect(f.store.users.get(f.user.id)?.authVersion).toBe(1);
});

test('logout revokes even when audit fails, and revoked token cannot read data', async () => {
  const f = fixture(); await f.login(); const previous = { ...f.request }; f.store.setAuditFailure(true);
  await f.auth.logout(f.request);
  await expect(f.auth.requirePermission(previous, 'employees.read')).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
});

test('persistent account throttling survives construction of another service instance', async () => {
  const f = fixture(); f.accept(await f.auth.session(f.request));
  for (let i = 0; i < 5; i++) await expect(f.auth.login(f.request, { username: 'ADMIN', password: 'wrong' })).rejects.toMatchObject({ reason: 'AUTH_INVALID_CREDENTIALS' });
  const second = createAuthService(f.store, { origin: 'http://localhost:3000', secret: 'a'.repeat(48), now: () => new Date('2026-11-23T09:00:00Z') });
  await expect(second.login(f.request, { username: 'admin', password })).rejects.toMatchObject({ reason: 'AUTH_RATE_LIMITED' });
});

test('account login suspension ends exactly at two minutes and repeated denials do not extend it', async () => {
  const f = fixture(); f.accept(await f.auth.session(f.request));
  const started = Date.parse('2026-11-23T09:00:00Z');
  for (let i = 0; i < 5; i++) {
    await expect(f.auth.login(f.request, { username: 'ADMIN', password: 'wrong' }))
      .rejects.toMatchObject({ reason: 'AUTH_INVALID_CREDENTIALS' });
  }
  for (const elapsed of [0, 60_000, 119_999]) {
    f.setTime(started + elapsed);
    await expect(f.auth.login(f.request, { username: 'admin', password }))
      .rejects.toMatchObject({ reason: 'AUTH_RATE_LIMITED' });
    expect(f.store.events.at(-1)).toMatchObject({ action: 'auth.login', result: 'denied',
      reasonCode: 'rate_limited', actorUserId: null, actorRoleId: null });
  }
  expect([...f.store.sessions.values()].every(value => value.stage === 'preauth')).toBe(true);
  f.setTime(started + 120_000);
  expect(f.accept(await f.auth.login(f.request, { username: 'admin', password })).view.state).toBe('authenticated');
  expect(f.store.events.at(-1)).toMatchObject({ action: 'auth.login', result: 'success', actorUserId: f.user.id });
  expect(f.store.users.get(f.user.id)?.authVersion).toBe(1);
});

test('source login limit remains thirty and resets at the two-minute boundary independently of account limit', async () => {
  const f = fixture(); f.accept(await f.auth.session(f.request));
  const started = new Date('2026-11-23T09:00:00Z');
  await expect(f.auth.login(f.request, { username: 'unknown-account', password: 'wrong' }))
    .rejects.toMatchObject({ reason: 'AUTH_INVALID_CREDENTIALS' });
  // Preserve the window created by a real login, without thirty expensive password derivations.
  await f.store.transaction(async tx => {
    for (let i = 0; i < 29; i++) {
      expect(await tx.consumeThrottle([f.auth.securityKey(`source:${f.request.peer}`)], started, 30, 120_000)).toBe(true);
    }
  });
  f.setTime(started.getTime() + 119_999);
  await expect(f.auth.login(f.request, { username: 'admin', password }))
    .rejects.toMatchObject({ reason: 'AUTH_RATE_LIMITED' });
  expect(f.store.events.at(-1)).toMatchObject({ action: 'auth.login', result: 'denied', reasonCode: 'rate_limited' });
  f.setTime(started.getTime() + 120_000);
  expect(f.accept(await f.auth.login(f.request, { username: 'admin', password })).view.state).toBe('authenticated');
});

test('password-change throttling still lasts fifteen minutes rather than the shorter login window', async () => {
  const f = fixture(true); await f.login();
  const started = Date.parse('2026-11-23T09:00:00Z');
  const replacement = 'A new private password 2026';
  for (let i = 0; i < 5; i++) {
    await expect(f.auth.changePassword(f.request, { currentPassword: 'wrong', newPassword: replacement }))
      .rejects.toMatchObject({ reason: 'AUTH_INVALID_CREDENTIALS' });
  }
  for (const elapsed of [120_000, 899_999]) {
    f.setTime(started + elapsed);
    await expect(f.auth.changePassword(f.request, { currentPassword: password, newPassword: replacement }))
      .rejects.toMatchObject({ reason: 'AUTH_RATE_LIMITED' });
  }
  expect(f.store.users.get(f.user.id)?.mustChangePassword).toBe(true);
  f.setTime(started + 900_000);
  expect(f.accept(await f.auth.changePassword(f.request, { currentPassword: password, newPassword: replacement })).view.state)
    .toBe('authenticated');
});

test('preauthentication and CSRF audit limits retain their independent fifteen-minute windows', async () => {
  const f = fixture();
  const started = Date.parse('2026-11-23T09:00:00Z');
  for (let i = 0; i < 30; i++) f.accept(await f.auth.session({ ...f.request, token: undefined }));
  for (const elapsed of [0, 120_000, 899_999]) {
    f.setTime(started + elapsed);
    await expect(f.auth.session({ ...f.request, token: undefined })).rejects.toMatchObject({ reason: 'AUTH_RATE_LIMITED' });
  }
  f.setTime(started + 900_000);
  expect((await f.auth.session({ ...f.request, token: undefined })).view.state).toBe('anonymous');
  const csrf = fixture(); csrf.accept(await csrf.auth.session(csrf.request));
  for (let i = 0; i < 30; i++) {
    await expect(csrf.auth.login({ ...csrf.request, csrf: 'wrong' }, { username: 'admin', password }))
      .rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  }
  expect(csrf.store.events.filter(value => value.action === 'auth.csrf')).toHaveLength(30);
  for (const elapsed of [120_000, 899_999]) {
    csrf.setTime(started + elapsed);
    await expect(csrf.auth.login({ ...csrf.request, csrf: 'wrong' }, { username: 'admin', password }))
      .rejects.toMatchObject({ reason: 'AUTH_CSRF' });
    expect(csrf.store.events.filter(value => value.action === 'auth.csrf')).toHaveLength(30);
  }
  csrf.setTime(started + 900_000);
  await expect(csrf.auth.login({ ...csrf.request, csrf: 'wrong' }, { username: 'admin', password }))
    .rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  expect(csrf.store.events.filter(value => value.action === 'auth.csrf')).toHaveLength(31);
});

test('audit does not contain entered password, cookie or CSRF values', async () => {
  const f = fixture(); await f.login();
  const events = JSON.stringify(f.store.events);
  expect(events).not.toContain(password); expect(events).not.toContain(f.request.token!); expect(events).not.toContain(f.request.csrf!);
});

test('explicit grants work independently of role while unknown permissions and invalid overrides deny', async () => {
  const f = fixture(); await f.login();
  f.store.users.get(f.user.id)!.rolePermissions = [];
  f.store.users.get(f.user.id)!.overrides = [{ permissionCode: 'employees.read', effect: 'grant' }, { permissionCode: 'unapproved.superuser', effect: 'grant' }];
  await expect(f.auth.requirePermission(f.request, 'employees.read')).resolves.toMatchObject({ userId: f.user.id });
  await expect(f.auth.requirePermission(f.request, 'unapproved.superuser')).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  f.store.users.get(f.user.id)!.overrides = [{ permissionCode: 'employees.read', effect: 'unexpected' }];
  await expect(f.auth.requirePermission(f.request, 'employees.read')).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
});

test('corrupt session time invariants fail closed', async () => {
  const f = fixture(); await f.login();
  const session = [...f.store.sessions.values()].find(value => value.stage === 'authenticated')!;
  session.absoluteExpiresAt = new Date('invalid');
  await expect(f.auth.requirePermission(f.request, 'employees.read')).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
});
