import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../../app.ts';
import { hashPassword } from '../../../core/auth/password.ts';
import { createMemoryUsersStore } from './memory-store.ts';

const password = 'Private HTTP fixture password';
const configuredOrigin = 'http://localhost:3000';
const adminRoleId = randomUUID();
const hrRoleId = randomUUID();
let listener: ReturnType<ReturnType<typeof createApp>['listen']>;
let origin: string;
let store: ReturnType<typeof createMemoryUsersStore>;
let passwordHash = '';

beforeAll(async () => { passwordHash = await hashPassword(password); });
beforeEach(async () => {
  store = createMemoryUsersStore([
    { id: randomUUID(), username: 'ADMIN', passwordHash, roleId: adminRoleId, roleCode: 'system_admin', accountStatus: 'active', mustChangePassword: false, authVersion: 1, rolePermissions: ['users.manage'], overrides: [] },
    { id: randomUUID(), username: 'HR01', passwordHash, roleId: hrRoleId, roleCode: 'hr', accountStatus: 'active', mustChangePassword: false, authVersion: 1, rolePermissions: ['employees.read'], overrides: [] },
    { id: randomUUID(), username: 'TEMPADMIN', passwordHash, roleId: adminRoleId, roleCode: 'system_admin', accountStatus: 'active', mustChangePassword: true, authVersion: 1, rolePermissions: ['users.manage'], overrides: [] },
  ], [
    { id: adminRoleId, code: 'system_admin', name: 'مدير النظام', permissions: ['users.manage'] },
    { id: hrRoleId, code: 'hr', name: 'الموارد البشرية', permissions: ['employees.read'] },
  ]);
  listener = createApp({ authStore: store, usersStore: store, authConfig: { origin: configuredOrigin, secret: 'http-users-fixture-secret-'.repeat(3) } }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener address.');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { if (listener?.listening) { const close = once(listener, 'close'); listener.close(); await close; } });

async function client(username?: string, loginPassword = password) {
  let cookie = '';
  let csrf = '';
  const send = async (path: string, input?: unknown, headers: Record<string, string> = {}, mutation = false) => {
    const response = await fetch(`${origin}/api/trpc/${path}${!mutation && input !== undefined ? '?input=' + encodeURIComponent(JSON.stringify(input)) : ''}`, {
      method: mutation ? 'POST' : 'GET',
      headers: { cookie, origin: configuredOrigin, ...(mutation ? { 'content-type': 'application/json', 'x-madar-csrf': csrf } : {}), ...headers },
      ...(mutation ? { body: JSON.stringify(input) } : {}),
    });
    const body = await response.json();
    const nextCookie = response.headers.get('set-cookie');
    if (nextCookie) cookie = nextCookie.split(';')[0];
    if (body.result?.data?.csrfToken) csrf = body.result.data.csrfToken;
    return { response, body };
  };
  await send('auth.session');
  if (username) {
    const login = await send('auth.login', { username, password: loginPassword }, {}, true);
    expect(login.response.status).toBe(200);
  }
  return { query: (path: string, input?: unknown) => send(path, input), mutate: (path: string, input: unknown, headers: Record<string, string> = {}) => send(path, input, headers, true) };
}

test('direct users API requests deny HR, preauthentication and temporary-password sessions', async () => {
  for (const [username, status] of [[undefined, 401], ['HR01', 403], ['TEMPADMIN', 401]] as const) {
    const api = await client(username);
    const result = await api.query('users.list');
    expect(result.response.status).toBe(status);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.body).not.toHaveProperty('result');
    expect(JSON.stringify(result.body)).not.toContain(password);
    const creation = await api.mutate('users.create', { username: `Unauthorized${username ?? 'Anonymous'}`, roleId: hrRoleId, currentPassword: password });
    expect(creation.response.status).toBe(status);
    expect([...store.users.values()].some(user => user.username.startsWith('Unauthorized'))).toBe(false);
  }
});

test('authorized list and roles use safe response shapes, no-store and durable audit', async () => {
  const api = await client('ADMIN');
  const result = await api.query('users.list');
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get('cache-control')).toBe('no-store');
  expect(result.body.result.data.users.length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(result.body)).not.toContain('scrypt$');
  expect(JSON.stringify(result.body)).not.toContain('passwordHash');
  const roles = await api.query('users.roles');
  expect(roles.response.status).toBe(200);
  expect(roles.body.result.data.roles).toHaveLength(2);
  expect(store.events.some(event => event.module === 'users' && event.result === 'success')).toBe(true);
});

test('create rejects wrong Origin, missing CSRF and privileged client-supplied extra fields', async () => {
  const api = await client('ADMIN');
  const input = { username: 'BlockedFixture', roleId: hrRoleId, currentPassword: password };
  const rejectedHeaders: Record<string, string>[] = [{ origin: 'https://foreign.invalid' }, { 'x-madar-csrf': '' }];
  for (const headers of rejectedHeaders) {
    const result = await api.mutate('users.create', input, headers);
    expect(result.response.status).toBe(403);
    expect(result.body.error.message).toBe('AUTH_CSRF');
  }
  const invalid = await api.mutate('users.create', { ...input, accountStatus: 'active', authVersion: 10 });
  expect(invalid.response.status).toBe(400);
  expect(JSON.stringify(invalid.body)).not.toContain(password);
  expect([...store.users.values()].some(user => user.username === input.username)).toBe(false);
});

test('temporary secret appears only in the successful creation response', async () => {
  const api = await client('ADMIN');
  const created = await api.mutate('users.create', { username: 'HR02', roleId: hrRoleId, currentPassword: password });
  expect(created.response.status).toBe(200);
  const temporary = created.body.result.data.temporaryPassword as string;
  expect(temporary.length).toBeGreaterThanOrEqual(15);
  expect(created.body.result.data.user.mustChangePassword).toBe(true);
  const listed = await api.query('users.list');
  expect(JSON.stringify(listed.body)).not.toContain(temporary);
  expect(JSON.stringify(store.events)).not.toContain(temporary);
  expect(JSON.stringify(store.events)).not.toContain(password);
});

test('GET cannot execute mutations and failed audit does not leak diagnostics or save partial data', async () => {
  const api = await client('ADMIN');
  expect((await api.query('users.create')).response.status).toBe(405);
  store.setAuditFailure(true);
  try {
    const result = await api.mutate('users.create', { username: 'RollbackFixture', roleId: hrRoleId, currentPassword: password });
    expect(result.response.status).toBe(503);
    expect(result.body.error.message).toBe('USERS_UNAVAILABLE');
    expect(JSON.stringify(result.body)).not.toMatch(/Synthetic audit|insert into|scrypt\$/);
    expect([...store.users.values()].some(user => user.username === 'RollbackFixture')).toBe(false);
  } finally { store.setAuditFailure(false); }
});

test('own reset response marks session revocation and old cookie cannot continue managing users', async () => {
  const api = await client('ADMIN');
  const admin = [...store.users.values()].find(user => user.username === 'ADMIN')!;
  const reset = await api.mutate('users.resetPassword', { userId: admin.id, expectedAuthVersion: admin.authVersion, currentPassword: password });
  expect(reset.response.status).toBe(200);
  expect(reset.body.result.data.callerSessionRevoked).toBe(true);
  const temporary = reset.body.result.data.temporaryPassword as string;
  expect(temporary.length).toBeGreaterThanOrEqual(15);
  expect((await api.query('users.list')).response.status).toBe(401);
  expect(JSON.stringify(store.events)).not.toContain(temporary);
  const nextLogin = await client('ADMIN', temporary);
  const session = await nextLogin.query('auth.session');
  expect(session.body.result.data.state).toBe('password_change');
  expect((await nextLogin.query('users.list')).response.status).toBe(401);
});
