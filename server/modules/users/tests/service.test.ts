import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { hashPassword, verifyPassword } from '../../../core/auth/password.ts';
import { createAuthService } from '../../auth/service.ts';
import type { AuthRequest, AuthResult } from '../../auth/service.ts';
import type { AuthUser } from '../../auth/store.ts';
import { createUsersService } from '../service.ts';
import { createInput } from '../validation.ts';
import { createMemoryUsersStore } from './memory-store.ts';
import type { MemoryRole } from './memory-store.ts';

const password = 'Private test manager password';
let passwordHash = '';
beforeAll(async () => { passwordHash = await hashPassword(password); });

function usersFixture(options: { actorRole?: 'system_admin' | 'hr'; temporary?: boolean } = {}) {
  const roles: MemoryRole[] = [
    { id: randomUUID(), code: 'system_admin', name: 'مدير النظام', permissions: ['users.manage', 'roles.manage'] },
    { id: randomUUID(), code: 'hr', name: 'الموارد البشرية', permissions: ['employees.read'] },
  ];
  const actorRole = roles.find(role => role.code === (options.actorRole ?? 'system_admin'))!;
  const actor: AuthUser = { id: randomUUID(), username: 'ADMIN', passwordHash,
    roleId: actorRole.id, roleCode: actorRole.code, rolePermissions: [...actorRole.permissions],
    accountStatus: 'active', mustChangePassword: options.temporary ?? false, authVersion: 1, overrides: [] };
  const target: AuthUser = { id: randomUUID(), username: 'HR01', passwordHash,
    roleId: roles[1].id, roleCode: roles[1].code, rolePermissions: [...roles[1].permissions],
    accountStatus: 'active', mustChangePassword: false, authVersion: 1, overrides: [] };
  const store = createMemoryUsersStore([actor, target], roles);
  const auth = createAuthService(store, { origin: 'http://localhost:3000', secret: 'fixture-secret-'.repeat(4) });
  const users = createUsersService(store, auth);
  async function login(username = 'ADMIN') {
    let request: AuthRequest = { origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID() };
    const accept = (result: AuthResult) => { request = { ...request, token: result.token ?? request.token, csrf: result.view.csrfToken }; };
    accept(await auth.session(request));
    accept(await auth.login(request, { username, password }));
    return request;
  }
  return { actor, target, roles, store, auth, users, login };
}

test('users.manage is enforced for HR, explicit deny and temporary sessions', async () => {
  const hr = usersFixture({ actorRole: 'hr' });
  await expect(hr.users.list(await hr.login(), {})).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(hr.store.events.at(-1)).toMatchObject({ module: 'users', result: 'denied', actorUserId: hr.actor.id, actorRoleId: hr.actor.roleId, actorRoleCode: 'hr' });
  const denied = usersFixture(); const deniedRequest = await denied.login();
  denied.store.users.get(denied.actor.id)!.overrides = [{ permissionCode: 'users.manage', effect: 'deny' }];
  await expect(denied.users.roles(deniedRequest)).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(denied.store.events.at(-1)).toMatchObject({ actorUserId: denied.actor.id, actorRoleId: denied.actor.roleId, result: 'denied' });
  const temporary = usersFixture({ temporary: true });
  await expect(temporary.users.list(await temporary.login(), {})).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
});

test('preauthentication and expired/revoked sessions cannot read account lists', async () => {
  const f = usersFixture();
  const preauth = await f.auth.session({ origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID() });
  await expect(f.users.list({ origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID(), token: preauth.token, csrf: preauth.view.csrfToken }, {})).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  expect(f.store.events.at(-1)).toMatchObject({ module: 'users', result: 'denied', actorUserId: null, actorRoleId: null });
  const request = await f.login();
  const active = [...f.store.sessions.values()].find(session => session.userId === f.actor.id)!;
  active.expiresAt = new Date(0);
  await expect(f.users.list(request, {})).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
});

test('list and role reads contain only safe DTO fields and emit one audit event per request', async () => {
  const f = usersFixture(); const request = await f.login();
  const before = f.store.events.length;
  const listed = await f.users.list(request, {});
  expect(listed.users).toHaveLength(2);
  expect(Object.keys(listed.users[0]).sort()).toEqual(['accountStatus', 'authVersion', 'id', 'mustChangePassword', 'roleCode', 'roleId', 'username']);
  expect(JSON.stringify(listed)).not.toContain(passwordHash);
  const roles = await f.users.roles(request);
  expect(roles.roles).toHaveLength(2);
  expect(f.store.events.length - before).toBe(2);
  expect(f.store.events.slice(before).every(event => event.module === 'users')).toBe(true);
});

test('account lists use a bounded cursor page and do not repeat records across pages', async () => {
  const f = usersFixture();
  for (let i = 0; i < 35; i++) {
    const id = randomUUID(); f.store.users.set(id, { ...f.target, id, username: `Fixture${i}` });
  }
  const request = await f.login();
  const first = await f.users.list(request, {});
  expect(first.users).toHaveLength(25);
  expect(first.nextCursor).toBeTruthy();
  const second = await f.users.list(request, { cursor: first.nextCursor });
  expect(second.users).toHaveLength(12);
  expect(second.nextCursor).toBeUndefined();
  expect(new Set([...first.users, ...second.users].map(user => user.id)).size).toBe(37);
});

test('creation normalizes username comparison, generates a temporary secret and never returns its hash', async () => {
  const f = usersFixture(); const request = await f.login();
  const result = await f.users.create(request, createInput({ username: '  NewStaff  ', roleId: f.roles[1].id, currentPassword: password }));
  expect(result.user.username).toBe('NewStaff');
  expect(result.user.accountStatus).toBe('active');
  expect(result.user.mustChangePassword).toBe(true);
  expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(15);
  expect(await verifyPassword(result.temporaryPassword, f.store.users.get(result.user.id)!.passwordHash)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('scrypt$');
  const createdAudit = f.store.events.filter(event => event.module === 'users' && event.result === 'success');
  expect(JSON.stringify(createdAudit)).not.toContain(result.temporaryPassword);
  expect(JSON.stringify(createdAudit)).not.toContain(passwordHash);
  await expect(f.users.create(request, { username: 'newstaff', roleId: f.roles[1].id, currentPassword: password }))
    .rejects.toMatchObject({ reason: 'USERS_DUPLICATE_USERNAME' });
  expect((await f.users.list(request, {})).users.some(user => 'temporaryPassword' in user || 'passwordHash' in user)).toBe(false);
});

test('mutations require session-bound CSRF, matching origin and the actor current password', async () => {
  const f = usersFixture(); const request = await f.login();
  const input = { username: 'NewStaff', roleId: f.roles[1].id, currentPassword: password };
  await expect(f.users.create({ ...request, csrf: undefined }, input)).rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  await expect(f.users.create({ ...request, origin: 'https://foreign.invalid' }, input)).rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  await expect(f.users.create(request, { ...input, currentPassword: 'Wrong private password' })).rejects.toMatchObject({ reason: 'USERS_REAUTH_FAILED' });
  expect(f.store.users.size).toBe(2);
  expect(JSON.stringify(f.store.events)).not.toContain('Wrong private password');
});

test('unknown roles and stale auth versions are rejected without overwriting the target', async () => {
  const f = usersFixture(); const request = await f.login();
  await expect(f.users.create(request, { username: 'NewStaff', roleId: randomUUID(), currentPassword: password })).rejects.toMatchObject({ reason: 'USERS_ROLE_NOT_FOUND' });
  await expect(f.users.assignRole(request, { userId: f.target.id, roleId: f.roles[0].id, expectedAuthVersion: 2, currentPassword: password })).rejects.toMatchObject({ reason: 'USERS_CONFLICT' });
  expect(f.store.users.get(f.target.id)?.roleId).toBe(f.roles[1].id);
});

test('assigning a role increments auth version and revokes existing target sessions', async () => {
  const f = usersFixture(); const request = await f.login(); const targetRequest = await f.login('HR01');
  const result = await f.users.assignRole(request, { userId: f.target.id, roleId: f.roles[0].id, expectedAuthVersion: 1, currentPassword: password });
  expect(result.user.roleId).toBe(f.roles[0].id);
  expect(result.user.authVersion).toBe(2);
  expect([...f.store.sessions.values()].filter(session => session.userId === f.target.id).every(session => session.revokedAt)).toBe(true);
  await expect(f.auth.requirePermission(targetRequest, 'users.manage')).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
});

test('disable revokes target sessions and reset never reactivates a disabled account', async () => {
  const f = usersFixture(); const request = await f.login(); const targetRequest = await f.login('HR01');
  const disabled = await f.users.disable(request, { userId: f.target.id, expectedAuthVersion: 1, currentPassword: password });
  expect(disabled.user.accountStatus).toBe('disabled');
  await expect(f.auth.requirePermission(targetRequest, 'employees.read')).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  const reset = await f.users.resetPassword(request, { userId: f.target.id, expectedAuthVersion: 2, currentPassword: password });
  expect(reset.callerSessionRevoked).toBe(false);
  expect(reset.user.accountStatus).toBe('disabled');
  expect(reset.user.mustChangePassword).toBe(true);
  expect(reset.user.authVersion).toBe(3);
  expect(await verifyPassword(reset.temporaryPassword, f.store.users.get(f.target.id)!.passwordHash)).toBe(true);
  const reassigned = await f.users.assignRole(request, { userId: f.target.id, roleId: f.roles[0].id, expectedAuthVersion: 3, currentPassword: password });
  expect(reassigned.user.accountStatus).toBe('disabled');
});

test('reset invalidates the old target password and creates restricted first-login credentials', async () => {
  const f = usersFixture(); const request = await f.login(); const oldTarget = await f.login('HR01');
  const result = await f.users.resetPassword(request, { userId: f.target.id, expectedAuthVersion: 1, currentPassword: password });
  expect(result.user.authVersion).toBe(2);
  expect(await verifyPassword(password, f.store.users.get(f.target.id)!.passwordHash)).toBe(false);
  await expect(f.auth.requirePermission(oldTarget, 'employees.read')).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  const preauth = await f.auth.session({ origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID() });
  const next = await f.auth.login({ origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID(), token: preauth.token, csrf: preauth.view.csrfToken },
    { username: 'HR01', password: result.temporaryPassword });
  expect(next.view.state).toBe('password_change');
});

test('failed durable audit rolls back user creation, password reset and session revocation', async () => {
  const f = usersFixture(); const request = await f.login(); await f.login('HR01');
  const oldHash = f.store.users.get(f.target.id)!.passwordHash;
  f.store.setAuditFailure(true);
  await expect(f.users.list(request, {})).rejects.toThrow();
  await expect(f.users.create(request, { username: 'Uncommitted', roleId: f.roles[1].id, currentPassword: password })).rejects.toThrow();
  expect(f.store.users.size).toBe(2);
  await expect(f.users.resetPassword(request, { userId: f.target.id, expectedAuthVersion: 1, currentPassword: password })).rejects.toThrow();
  expect(f.store.users.get(f.target.id)!.passwordHash).toBe(oldHash);
  expect(f.store.users.get(f.target.id)!.authVersion).toBe(1);
  expect([...f.store.sessions.values()].filter(session => session.userId === f.target.id).every(session => session.revokedAt === null)).toBe(true);
});

test('revoking users.manage after reauthentication prevents the final transactional write', async () => {
  const f = usersFixture(); const request = await f.login();
  let calls = 0;
  f.store.setBeforeTransaction(() => {
    calls++;
    if (calls === 2) f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'users.manage', effect: 'deny' }];
  });
  await expect(f.users.create(request, { username: 'NotAllowed', roleId: f.roles[1].id, currentPassword: password })).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(f.store.users.size).toBe(2);
});

test('successful reauthenticated actions do not exhaust the failed-attempt counter', async () => {
  const f = usersFixture(); const request = await f.login();
  for (let i = 0; i < 6; i++) {
    const result = await f.users.create(request, { username: `SuccessfulFixture${i}`, roleId: f.roles[1].id, currentPassword: password });
    expect(result.user.username).toBe(`SuccessfulFixture${i}`);
  }
  expect(f.store.users.size).toBe(8);
}, 10_000);

test('repeated failed actor reauthentication is persistently throttled', async () => {
  const f = usersFixture(); const request = await f.login();
  for (let i = 0; i < 5; i++) {
    await expect(f.users.create(request, { username: 'NeverCreated', roleId: f.roles[1].id, currentPassword: 'Incorrect fixture password' }))
      .rejects.toMatchObject({ reason: 'USERS_REAUTH_FAILED' });
  }
  await expect(f.users.create(request, { username: 'NeverCreated', roleId: f.roles[1].id, currentPassword: password }))
    .rejects.toMatchObject({ reason: 'AUTH_RATE_LIMITED' });
  expect(f.store.users.size).toBe(2);
}, 10_000);

test('a concurrent target edit causes one of two competing writes to fail with a conflict', async () => {
  const f = usersFixture(); const request = await f.login();
  const results = await Promise.allSettled([
    f.users.assignRole(request, { userId: f.target.id, roleId: f.roles[0].id, expectedAuthVersion: 1, currentPassword: password }),
    f.users.resetPassword(request, { userId: f.target.id, expectedAuthVersion: 1, currentPassword: password }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(result => result.status === 'rejected');
  expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toMatchObject({ reason: 'USERS_CONFLICT' });
  expect(f.store.users.get(f.target.id)?.authVersion).toBe(2);
});

test('actor credentials changed after reauthentication cannot authorize a later write', async () => {
  const f = usersFixture(); const request = await f.login();
  let calls = 0;
  f.store.setBeforeTransaction(() => {
    calls++;
    if (calls === 2) f.store.users.get(f.actor.id)!.authVersion++;
  });
  await expect(f.users.create(request, { username: 'CredentialsChanged', roleId: f.roles[1].id, currentPassword: password }))
    .rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  expect(f.store.users.size).toBe(2);
});

test('manager cannot disable their own account or change their own role', async () => {
  const f = usersFixture(); const request = await f.login();
  await expect(f.users.disable(request, { userId: f.actor.id, expectedAuthVersion: 1, currentPassword: password }))
    .rejects.toMatchObject({ reason: 'USERS_SELF_CHANGE' });
  await expect(f.users.assignRole(request, { userId: f.actor.id, roleId: f.roles[1].id, expectedAuthVersion: 1, currentPassword: password }))
    .rejects.toMatchObject({ reason: 'USERS_SELF_CHANGE' });
  expect(f.store.users.get(f.actor.id)).toMatchObject({ accountStatus: 'active', authVersion: 1, roleId: f.roles[0].id });
  expect([...f.store.sessions.values()].filter(session => session.userId === f.actor.id).every(session => session.revokedAt === null)).toBe(true);
  expect(await f.auth.requirePermission(request, 'users.manage')).toMatchObject({ userId: f.actor.id });
});

test('own administrative password reset is allowed but old sessions immediately lose access', async () => {
  const f = usersFixture(); const request = await f.login();
  const secondManagerId = randomUUID();
  f.store.users.set(secondManagerId, { ...f.actor, id: secondManagerId, username: 'MANAGER02' });
  const otherManagerRequest = await f.login('MANAGER02');
  const result = await f.users.resetPassword(request, { userId: f.actor.id, expectedAuthVersion: 1, currentPassword: password });
  expect(result.callerSessionRevoked).toBe(true);
  expect(result.user).toMatchObject({ id: f.actor.id, mustChangePassword: true, authVersion: 2, accountStatus: 'active' });
  expect(await verifyPassword(result.temporaryPassword, f.store.users.get(f.actor.id)!.passwordHash)).toBe(true);
  expect(await verifyPassword(password, f.store.users.get(f.actor.id)!.passwordHash)).toBe(false);
  await expect(f.auth.requirePermission(request, 'users.manage')).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  await expect(f.users.list(request, {})).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  expect([...f.store.sessions.values()].filter(session => session.userId === f.actor.id).every(session => session.revokedAt !== null)).toBe(true);
  const listed = await f.users.list(otherManagerRequest, {});
  expect(JSON.stringify(listed)).not.toContain(result.temporaryPassword);
  expect(JSON.stringify(f.store.events)).not.toContain(result.temporaryPassword);
  const base: AuthRequest = { origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID() };
  const preauth = await f.auth.session(base);
  const login = await f.auth.login({ ...base, token: preauth.token, csrf: preauth.view.csrfToken }, { username: 'ADMIN', password: result.temporaryPassword });
  expect(login.view.state).toBe('password_change');
});
