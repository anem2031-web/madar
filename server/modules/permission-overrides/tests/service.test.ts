import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { hashPassword } from '../../../core/auth/password.ts';
import { createAuthService } from '../../auth/service.ts';
import type { AuthRequest, AuthResult } from '../../auth/service.ts';
import type { AuthUser } from '../../auth/store.ts';
import { createPermissionOverridesService } from '../service.ts';
import type { UserOverride } from '../store.ts';
import { detailInput, listInput, saveInput } from '../validation.ts';
import { createMemoryPermissionOverridesStore } from './memory-store.ts';

const password = '  Private مدير test password  ';
let passwordHash = '';
beforeAll(async () => { passwordHash = await hashPassword(password); });

function fixture(options: { hr?: boolean; temporary?: boolean } = {}) {
  const actor: AuthUser = { id: randomUUID(), username: 'ManagerFixture', passwordHash,
    roleId: randomUUID(), roleCode: options.hr ? 'hr' : 'system_admin',
    rolePermissions: options.hr ? ['employees.read'] : ['permissions.manage_overrides'],
    accountStatus: 'active', mustChangePassword: options.temporary ?? false, authVersion: 1, overrides: [] };
  const target: AuthUser = { ...actor, id: randomUUID(), username: 'StaffFixture', roleId: randomUUID(), roleCode: 'hr',
    rolePermissions: ['employees.read', 'employees.update'], mustChangePassword: false };
  const store = createMemoryPermissionOverridesStore([actor, target]);
  let now = Date.parse('2026-11-23T12:00:00Z');
  const clock = () => new Date(now);
  const auth = createAuthService(store, { origin: 'http://localhost:3000', secret: 'synthetic-secret-'.repeat(4), now: clock });
  const service = createPermissionOverridesService(store, auth, { now: clock });
  async function login(username = actor.username) {
    let request: AuthRequest = { origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID() };
    const accept = (result: AuthResult) => { request = { ...request, token: result.token ?? request.token, csrf: result.view.csrfToken }; };
    accept(await auth.session(request)); accept(await auth.login(request, { username, password })); return request;
  }
  const input = (overrides: UserOverride[] = [], expectedAuthVersion = 1) => ({ userId: target.id, currentPassword: password, expectedAuthVersion, overrides });
  return { actor, target, store, auth, service, login, input, advance: (ms: number) => { now += ms; } };
}

test('the dedicated permission enforces HR deny, admin override deny and special HR grant', async () => {
  const hr = fixture({ hr: true }); const request = await hr.login();
  await expect(hr.service.list(request)).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(hr.store.events.at(-1)).toMatchObject({ module: 'permissions', actorUserId: hr.actor.id, actorRoleCode: 'hr', result: 'denied' });
  hr.store.users.get(hr.actor.id)!.overrides = [{ permissionCode: 'permissions.manage_overrides', effect: 'grant' }];
  expect((await hr.service.list(request)).users).toHaveLength(2);
  const admin = fixture(); const managerRequest = await admin.login();
  admin.store.users.get(admin.actor.id)!.overrides = [{ permissionCode: 'permissions.manage_overrides', effect: 'deny' }];
  await expect(admin.service.detail(managerRequest, { userId: admin.target.id })).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
});

test('anonymous, preauth, temporary, expired and revoked sessions cannot read details', async () => {
  const f = fixture();
  const base = { peer: '127.0.0.1', requestId: randomUUID(), origin: 'http://localhost:3000' };
  await expect(f.service.detail(base, { userId: f.target.id })).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  const preauth = await f.auth.session(base);
  await expect(f.service.list({ ...base, token: preauth.token })).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  const temp = fixture({ temporary: true });
  await expect(temp.service.list(await temp.login())).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  const request = await f.login();
  const session = [...f.store.sessions.values()].find(value => value.userId === f.actor.id)!;
  session.revokedAt = new Date();
  await expect(f.service.list(request)).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  f.store.sessions.get(session.id)!.revokedAt = null;
  f.store.sessions.get(session.id)!.expiresAt = new Date(0);
  await expect(f.service.list(request)).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
});

test('list is cursor bounded, details use central effective decisions and DTOs/audits omit secrets', async () => {
  const f = fixture(); const request = await f.login();
  for (let i = 0; i < 30; i++) { const id = randomUUID(); f.store.users.set(id, { ...f.target, id, username: `Synthetic${i}` }); }
  const first = await f.service.list(request); const second = await f.service.list(request, { cursor: first.nextCursor });
  expect(first.users).toHaveLength(25); expect(second.users).toHaveLength(7); expect(second.nextCursor).toBeUndefined();
  expect(new Set([...first.users, ...second.users].map(user => user.id)).size).toBe(32);
  expect(Object.keys(first.users[0]).sort()).toEqual(['accountStatus', 'authVersion', 'id', 'roleCode', 'username']);
  f.store.users.get(f.target.id)!.overrides = [{ permissionCode: 'employees.read', effect: 'deny' }, { permissionCode: 'audit.read', effect: 'grant' }];
  const before = f.store.events.length;
  const detail = await f.service.detail(request, { userId: f.target.id });
  expect(detail.rolePermissions).toEqual(['employees.read', 'employees.update']);
  expect(detail.effectivePermissions).toEqual(['audit.read', 'employees.update']);
  expect(detail.editable).toBe(true);
  expect((await f.service.detail(request, { userId: f.actor.id })).editable).toBe(false);
  expect(f.store.events.length - before).toBe(2);
  const serialized = JSON.stringify({ first, detail, events: f.store.events });
  expect(serialized).not.toContain(password); expect(serialized).not.toContain(passwordHash); expect(serialized).not.toContain(request.token!);
});

test('saving grant/deny revokes only target sessions and the next login uses the new decision', async () => {
  const f = fixture(); const request = await f.login(); const targetRequest = await f.login(f.target.username);
  const result = await f.service.save(request, f.input([{ permissionCode: 'employees.read', effect: 'deny' }, { permissionCode: 'audit.read', effect: 'grant' }]));
  expect(result.changed).toBe(true); expect(result.detail.user.authVersion).toBe(2);
  expect(result.detail.effectivePermissions).toEqual(['audit.read', 'employees.update']);
  expect((await f.auth.session(targetRequest)).view.state).toBe('anonymous');
  expect((await f.auth.session(request)).view.state).toBe('authenticated');
  const newRequest = await f.login(f.target.username);
  expect((await f.auth.session(newRequest)).view.user?.permissions).toEqual(['audit.read', 'employees.update']);
  const event = f.store.events.find(value => value.action === 'permissions.overrides.save' && value.result === 'success')!;
  expect(event.beforeValues).toEqual({ authVersion: 1, overrides: [] });
  expect(event.afterValues).toEqual({ authVersion: 2, overrides: result.detail.overrides });
  expect(event.metadata).toEqual({ changed: true });
  expect(JSON.stringify(event)).not.toContain(password);
});

test('returning to role inheritance removes explicit overrides; matching save leaves version/session intact', async () => {
  const f = fixture(); const request = await f.login(); const targetRequest = await f.login(f.target.username);
  const unchanged = await f.service.save(request, f.input());
  expect(unchanged.changed).toBe(false); expect(unchanged.detail.user.authVersion).toBe(1);
  expect((await f.auth.session(targetRequest)).view.state).toBe('authenticated');
  expect(f.store.events.at(-1)?.metadata).toEqual({ changed: false });
  f.store.users.get(f.target.id)!.overrides = [{ permissionCode: 'employees.read', effect: 'deny' }];
  const reset = await f.service.save(request, f.input());
  expect(reset.changed).toBe(true); expect(reset.detail.overrides).toEqual([]);
  expect(reset.detail.effectivePermissions).toEqual(['employees.read', 'employees.update']);
});

test('self edits are denied at service level with no changed user, override or session', async () => {
  const f = fixture(); const request = await f.login();
  await expect(f.service.save(request, { ...f.input(), userId: f.actor.id, overrides: [{ permissionCode: 'users.manage', effect: 'grant' }] }))
    .rejects.toMatchObject({ reason: 'OVERRIDES_SELF_CHANGE' });
  expect(f.store.users.get(f.actor.id)?.authVersion).toBe(1);
  expect(f.store.users.get(f.actor.id)?.overrides).toEqual([]);
  expect((await f.auth.session(request)).view.state).toBe('authenticated');
  expect(f.store.events.at(-1)).toMatchObject({ action: 'permissions.overrides.save', result: 'denied', reasonCode: 'OVERRIDES_SELF_CHANGE' });
});

test('mutations require CSRF/exact origin and the current actor password without trimming', async () => {
  const f = fixture(); const request = await f.login();
  await expect(f.service.save({ ...request, csrf: undefined }, f.input())).rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  await expect(f.service.save({ ...request, origin: 'https://foreign.invalid' }, f.input())).rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  await expect(f.service.save(request, { ...f.input(), currentPassword: password.trim() })).rejects.toMatchObject({ reason: 'OVERRIDES_REAUTH_FAILED' });
  expect((await f.auth.session(request)).view.state).toBe('authenticated');
  expect((await f.service.save(request, f.input())).changed).toBe(false);
});

test('stale/nonexistent targets and exhausted auth version are rejected without partial writes', async () => {
  const f = fixture(); const request = await f.login();
  await expect(f.service.save(request, { ...f.input(), userId: randomUUID() })).rejects.toMatchObject({ reason: 'OVERRIDES_NOT_FOUND' });
  await expect(f.service.save(request, f.input([], 2))).rejects.toMatchObject({ reason: 'OVERRIDES_CONFLICT' });
  f.store.users.get(f.target.id)!.authVersion = 4_294_967_295;
  await expect(f.service.save(request, f.input([{ permissionCode: 'audit.read', effect: 'grant' }], 4_294_967_295)))
    .rejects.toMatchObject({ reason: 'OVERRIDES_CONFLICT' });
  expect(f.store.users.get(f.target.id)?.overrides).toEqual([]);
});

test('concurrent saves to one version yield one change and one conflict', async () => {
  const f = fixture(); const request = await f.login();
  const results = await Promise.allSettled([
    f.service.save(request, f.input([{ permissionCode: 'audit.read', effect: 'grant' }])),
    f.service.save(request, f.input([{ permissionCode: 'employees.read', effect: 'deny' }])),
  ]);
  expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(value => value.status === 'rejected')).toMatchObject({ reason: { reason: 'OVERRIDES_CONFLICT' } });
  expect(f.store.users.get(f.target.id)?.authVersion).toBe(2);
});

test('a changed permission or actor credential during password verification blocks the final write', async () => {
  for (const change of ['permission', 'credential', 'session', 'target'] as const) {
    const f = fixture(); const request = await f.login(); let count = 0;
    f.store.setBeforeTransaction(() => {
      if (++count !== 2) return;
      if (change === 'permission') f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'permissions.manage_overrides', effect: 'deny' }];
      else if (change === 'credential') f.store.users.get(f.actor.id)!.passwordHash = 'synthetic-changed-hash';
      else if (change === 'session') [...f.store.sessions.values()].find(value => value.userId === f.actor.id)!.revokedAt = new Date();
      else f.store.users.get(f.target.id)!.authVersion++;
    });
    const expected = change === 'permission' ? 'AUTH_FORBIDDEN' : change === 'target' ? 'OVERRIDES_CONFLICT' : 'AUTH_REQUIRED';
    await expect(f.service.save(request, f.input([{ permissionCode: 'audit.read', effect: 'grant' }])))
      .rejects.toMatchObject({ reason: expected });
    expect(f.store.users.get(f.target.id)?.overrides).toEqual([]);
  }
});

test('outbox or replace failures roll back override/version/session changes', async () => {
  for (const stage of ['replace', 'audit'] as const) {
    const f = fixture(); const request = await f.login(); await f.login(f.target.username);
    const eventCount = f.store.events.length;
    if (stage === 'replace') f.store.setReplaceFailure(true); else f.store.setAuditFailure(true);
    await expect(f.service.save(request, f.input([{ permissionCode: 'audit.read', effect: 'grant' }]))).rejects.toThrow('Synthetic');
    expect(f.store.users.get(f.target.id)?.authVersion).toBe(1); expect(f.store.users.get(f.target.id)?.overrides).toEqual([]);
    expect([...f.store.sessions.values()].filter(value => value.userId === f.target.id).every(value => value.revokedAt === null)).toBe(true);
    expect(f.store.events.length).toBe(eventCount);
  }
});

test('confirmation throttle remains five attempts in fifteen minutes', async () => {
  const f = fixture(); const request = await f.login();
  const badInput = { ...f.input(), currentPassword: 'synthetic incorrect password' };
  for (let i = 0; i < 5; i++) await expect(f.service.save(request, badInput)).rejects.toMatchObject({ reason: 'OVERRIDES_REAUTH_FAILED' });
  f.advance(2 * 60_000);
  await expect(f.service.save(request, f.input())).rejects.toMatchObject({ reason: 'AUTH_RATE_LIMITED' });
  f.advance(13 * 60_000);
  expect((await f.service.save(request, f.input())).changed).toBe(false);
});

test('strict validation rejects unknown/duplicate permissions, invalid effects, scope and malformed versions', () => {
  const userId = randomUUID();
  const valid = { userId, currentPassword: password, expectedAuthVersion: 1, overrides: [{ permissionCode: 'audit.read', effect: 'grant' }] };
  expect(saveInput(valid).currentPassword).toBe(password);
  expect(detailInput({ userId: userId.toUpperCase() }).userId).toBe(userId);
  expect(listInput(undefined)).toEqual({});
  for (const input of [
    { ...valid, scope: 'all' }, { ...valid, actorId: userId }, { ...valid, roleId: userId },
    { ...valid, expectedAuthVersion: 0 }, { ...valid, expectedAuthVersion: 1.5 }, { ...valid, expectedAuthVersion: Number.MAX_SAFE_INTEGER },
    { ...valid, overrides: [{ permissionCode: 'unknown', effect: 'grant' }] },
    { ...valid, overrides: [{ permissionCode: 'audit.read', effect: 'inherit' }] },
    { ...valid, overrides: [{ permissionCode: 'audit.read', effect: 'allow' }] },
    { ...valid, overrides: [valid.overrides[0], valid.overrides[0]] },
    { ...valid, overrides: [{ permissionCode: 'audit.read', effect: 'grant', extra: 1 }] },
    { ...valid, currentPassword: 'a'.repeat(129) }, { ...valid, userId: 'invalid' },
  ]) expect(() => saveInput(input)).toThrow('OVERRIDES_INVALID_INPUT');
  expect(() => detailInput({ userId, scope: 'all' })).toThrow('OVERRIDES_INVALID_INPUT');
  expect(() => listInput({ limit: 100 })).toThrow('OVERRIDES_INVALID_INPUT');
});
