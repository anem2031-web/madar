import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../../app.ts';
import { hashPassword } from '../../../core/auth/password.ts';
import type { AuthUser } from '../../auth/store.ts';
import { initialRolePermissions } from '../../../../shared/permissions/catalog.ts';
import { createMemoryPermissionOverridesStore } from './memory-store.ts';

const password = 'Synthetic HTTP permission confirmation';
const configuredOrigin = 'http://localhost:3000';
let passwordHash = '';
let listener: ReturnType<ReturnType<typeof createApp>['listen']>;
let origin: string;
let store: ReturnType<typeof createMemoryPermissionOverridesStore>;

beforeAll(async () => { passwordHash = await hashPassword(password); });
beforeEach(async () => {
  const make = (username: string, roleCode: 'system_admin' | 'hr', overrides: AuthUser['overrides'] = [], temporary = false): AuthUser => ({
    id: randomUUID(), username, passwordHash, roleId: randomUUID(), roleCode, accountStatus: 'active',
    mustChangePassword: temporary, authVersion: 1, rolePermissions: [...initialRolePermissions[roleCode]], overrides,
  });
  store = createMemoryPermissionOverridesStore([
    make('ADMIN', 'system_admin'), make('HR01', 'hr'), make('TEMP', 'system_admin', [], true),
    make('DENIED', 'system_admin', [{ permissionCode: 'permissions.manage_overrides', effect: 'deny' }]),
    make('DELEGATED', 'hr', [{ permissionCode: 'permissions.manage_overrides', effect: 'grant' }]),
  ]);
  listener = createApp({ authStore: store, permissionOverridesStore: store,
    authConfig: { origin: configuredOrigin, secret: 'synthetic-http-permission-secret-'.repeat(2) } }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener.');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  if (!listener?.listening) return;
  const closed = once(listener, 'close'); listener.close(); await closed;
});

const user = (name: string) => [...store.users.values()].find(value => value.username === name)!;
async function client(username?: string) {
  let cookie = '';
  let csrf = '';
  const send = async (path: string, input?: unknown, mutation = false, headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}/api/trpc/${path}${!mutation && input !== undefined ? '?input=' + encodeURIComponent(JSON.stringify(input)) : ''}`, {
      method: mutation ? 'POST' : 'GET',
      headers: { cookie, origin: configuredOrigin,
        ...(mutation ? { 'content-type': 'application/json', 'x-madar-csrf': csrf } : {}), ...headers },
      ...(mutation ? { body: JSON.stringify(input) } : {}),
    });
    const body = await response.json();
    const next = response.headers.get('set-cookie');
    if (next) cookie = next.split(';')[0];
    if (body.result?.data?.csrfToken) csrf = body.result.data.csrfToken;
    return { response, body };
  };
  await send('auth.session');
  if (username) expect((await send('auth.login', { username, password }, true)).response.status).toBe(200);
  return { query: (path: string, input?: unknown) => send(path, input),
    mutate: (path: string, input: unknown, headers?: Record<string, string>) => send(path, input, true, headers) };
}

test('all direct overrides endpoints enforce authentication and effective authorization', async () => {
  const target = user('HR01');
  for (const [username, status] of [[undefined, 401], ['HR01', 403], ['TEMP', 401], ['DENIED', 403]] as const) {
    const api = await client(username);
    const results = [await api.query('permissionOverrides.list'), await api.query('permissionOverrides.detail', { userId: target.id }),
      await api.mutate('permissionOverrides.save', { userId: target.id, expectedAuthVersion: 1, currentPassword: password, overrides: [] })];
    for (const result of results) {
      expect(result.response.status).toBe(status);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
      expect(result.body).not.toHaveProperty('result');
      expect(JSON.stringify(result.body)).not.toContain(password);
    }
  }
  expect(user('HR01').authVersion).toBe(1);
});

test('a delegated permission works independently of users.manage and returns only safe data', async () => {
  const api = await client('DELEGATED');
  const session = await api.query('auth.session');
  expect(session.body.result.data.user.permissions).not.toContain('users.manage');
  const page = await api.query('permissionOverrides.list');
  expect(page.response.status).toBe(200);
  expect(page.body.result.data.users).toHaveLength(5);
  const detail = await api.query('permissionOverrides.detail', { userId: user('HR01').id });
  expect(detail.response.status).toBe(200);
  expect(detail.body.result.data.editable).toBe(true);
  expect(detail.body.result.data.rolePermissions).toEqual([...initialRolePermissions.hr].sort());
  const exposed = JSON.stringify([page.body, detail.body, store.events]);
  expect(exposed).not.toMatch(/passwordHash|scrypt\$|currentPassword|tokenHash/);
  expect(exposed).not.toContain(password);
  expect(store.events.filter(event => event.action === 'permissions.overrides.list')).toHaveLength(1);
});

test('CSRF, self changes and extra privileged input fail without exposing the input', async () => {
  const api = await client('ADMIN');
  const target = user('HR01');
  const input = { userId: target.id, expectedAuthVersion: 1, currentPassword: password, overrides: [] };
  const rejectedHeaders: Record<string, string>[] = [{ origin: 'https://foreign.invalid' }, { 'x-madar-csrf': '' }];
  for (const headers of rejectedHeaders) {
    const rejected = await api.mutate('permissionOverrides.save', input, headers);
    expect(rejected.response.status).toBe(403);
    expect(rejected.body.error.message).toBe('AUTH_CSRF');
  }
  const own = user('ADMIN');
  expect((await api.query('permissionOverrides.detail', { userId: own.id })).body.result.data.editable).toBe(false);
  const self = await api.mutate('permissionOverrides.save', { ...input, userId: own.id });
  expect(self.response.status).toBe(403);
  expect(self.body.error.message).toBe('OVERRIDES_SELF_CHANGE');
  const invalid = await api.mutate('permissionOverrides.save', { ...input, roleId: randomUUID() });
  expect(invalid.response.status).toBe(400);
  expect(JSON.stringify(invalid.body)).not.toContain(password);
  expect(user('ADMIN').authVersion).toBe(1);
  expect(user('HR01').authVersion).toBe(1);
});

test('saving overrides revokes only target sessions, takes effect at next login and supports returning to role inheritance', async () => {
  const api = await client('ADMIN');
  const targetApi = await client('HR01');
  const target = user('HR01');
  const saved = await api.mutate('permissionOverrides.save', { userId: target.id, expectedAuthVersion: 1,
    currentPassword: password, overrides: [{ permissionCode: 'employees.read', effect: 'deny' }, { permissionCode: 'audit.read', effect: 'grant' }] });
  expect(saved.response.status).toBe(200);
  expect(saved.body.result.data.changed).toBe(true);
  expect(saved.body.result.data.detail.user.authVersion).toBe(2);
  expect(saved.body.result.data.detail.effectivePermissions).not.toContain('employees.read');
  expect(saved.body.result.data.detail.effectivePermissions).toContain('audit.read');
  expect((await targetApi.query('auth.session')).body.result.data.state).toBe('anonymous');
  expect((await api.query('permissionOverrides.list')).response.status).toBe(200);
  const freshTarget = await client('HR01');
  const nextSession = await freshTarget.query('auth.session');
  expect(nextSession.body.result.data.user.permissions).not.toContain('employees.read');
  expect(nextSession.body.result.data.user.permissions).toContain('audit.read');
  const inherited = await api.mutate('permissionOverrides.save', { userId: target.id, expectedAuthVersion: 2, currentPassword: password, overrides: [] });
  expect(inherited.response.status).toBe(200);
  expect(inherited.body.result.data.detail.overrides).toEqual([]);
  expect(inherited.body.result.data.detail.effectivePermissions).toEqual([...initialRolePermissions.hr].sort());
  expect((await freshTarget.query('auth.session')).body.result.data.state).toBe('anonymous');
  expect(JSON.stringify(store.events)).not.toContain(password);
});

test('failed audit or repository writes return safe no-store errors and retain the committed target state', async () => {
  const api = await client('ADMIN');
  const target = user('HR01');
  const input = { userId: target.id, expectedAuthVersion: 1, currentPassword: password,
    overrides: [{ permissionCode: 'employees.read', effect: 'deny' }] };
  for (const failure of ['audit', 'replace'] as const) {
    if (failure === 'audit') store.setAuditFailure(true); else store.setReplaceFailure(true);
    try {
      const rejected = await api.mutate('permissionOverrides.save', input);
      expect(rejected.response.status).toBe(503);
      expect(rejected.response.headers.get('cache-control')).toBe('no-store');
      expect(rejected.body.error.message).toBe('OVERRIDES_UNAVAILABLE');
      expect(rejected.body.error.data.requestId).toMatch(/^[a-f0-9-]{36}$/);
      expect(JSON.stringify(rejected.body)).not.toMatch(/Synthetic|insert into|scrypt\$|passwordHash/);
      expect(JSON.stringify(rejected.body)).not.toContain(password);
      expect(user('HR01').authVersion).toBe(1);
      expect(user('HR01').overrides).toEqual([]);
    } finally { store.setAuditFailure(false); store.setReplaceFailure(false); }
  }
  expect((await api.query('permissionOverrides.save')).response.status).toBe(405);
});
