import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../app.ts';
import { hashPassword } from '../auth/password.ts';
import type { AuthUser } from '../../modules/auth/store.ts';
import type { OrganizationStore } from '../../modules/organization/store.ts';
import { createMemoryUsersStore } from '../../modules/users/tests/memory-store.ts';

const password = 'Synthetic HTTP guard password';
const configuredOrigin = 'http://localhost:3000';
const roleId = randomUUID();
const hrRoleId = randomUUID();
const branch = { id: randomUUID(), name: 'Synthetic guard branch', version: 1 };
let passwordHash = '';
let listener: ReturnType<ReturnType<typeof createApp>['listen']>;
let origin: string;
let store: ReturnType<typeof createMemoryUsersStore>;
let attemptedWrites = 0;

beforeAll(async () => { passwordHash = await hashPassword(password); });
beforeEach(async () => {
  const user = (username: string, admin: boolean, overrides: AuthUser['overrides'] = [], temporary = false): AuthUser => ({
    id: randomUUID(), username, passwordHash, roleId: admin ? roleId : hrRoleId, roleCode: admin ? 'system_admin' : 'hr',
    accountStatus: 'active', mustChangePassword: temporary, authVersion: 1,
    rolePermissions: admin ? ['organization.read', 'users.manage', 'settings.manage'] : ['organization.read'], overrides,
  });
  store = createMemoryUsersStore([user('HR', false), user('DENIED', true, [{ permissionCode: 'users.manage', effect: 'deny' }]), user('TEMP', true, [], true)], [
    { id: roleId, code: 'system_admin', name: 'System admin', permissions: ['organization.read', 'users.manage', 'settings.manage'] },
    { id: hrRoleId, code: 'hr', name: 'HR', permissions: ['organization.read'] },
  ]);
  attemptedWrites = 0;
  const unexpectedWrite = async (): Promise<never> => { attemptedWrites++; throw new Error('Unexpected forbidden write.'); };
  const organizationStore: OrganizationStore = { transaction: work => store.transaction(tx => work({ ...tx,
    async listBranches() { return [{ ...branch }]; }, async getBranch(id) { return id === branch.id ? { ...branch } : null; },
    async listDepartments() { return []; }, async getDepartment() { return null; },
    insertBranch: unexpectedWrite, renameBranch: unexpectedWrite, insertDepartment: unexpectedWrite, renameDepartment: unexpectedWrite,
  })) };
  listener = createApp({ authStore: store, usersStore: store, organizationStore,
    authConfig: { origin: configuredOrigin, secret: 'synthetic-http-central-guard-secret-'.repeat(2) } }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener.');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  if (!listener?.listening) return;
  const closed = once(listener, 'close'); listener.close(); await closed;
});

async function client(username?: string) {
  let cookie = '';
  let csrf = '';
  const send = async (path: string, input?: unknown, mutation = false) => {
    const response = await fetch(`${origin}/api/trpc/${path}`, {
      method: mutation ? 'POST' : 'GET', headers: { cookie, origin: configuredOrigin,
        ...(mutation ? { 'content-type': 'application/json', 'x-madar-csrf': csrf } : {}) },
      ...(mutation ? { body: JSON.stringify(input) } : {}), redirect: 'manual',
    });
    const body = await response.json();
    const next = response.headers.get('set-cookie');
    if (next) cookie = next.split(';')[0];
    if (body.result?.data?.csrfToken) csrf = body.result.data.csrfToken;
    return { response, body };
  };
  await send('auth.session');
  if (username) expect((await send('auth.login', { username, password }, true)).response.status).toBe(200);
  return { query: (path: string) => send(path), mutate: (path: string, input: unknown) => send(path, input, true) };
}

test('a denied page API remains JSON403 without an HTTP redirect or invalidating the valid caller session', async () => {
  for (const username of ['HR', 'DENIED']) {
    const api = await client(username);
    const rejected = await api.query('users.list');
    expect(rejected.response.status).toBe(403);
    expect(rejected.response.headers.get('content-type')).toContain('application/json');
    expect(rejected.response.headers.get('cache-control')).toBe('no-store');
    expect(rejected.response.headers.get('location')).toBeNull();
    expect(rejected.body.error.message).toBe('AUTH_FORBIDDEN');
    expect(rejected.body).not.toHaveProperty('result');
    expect((await api.query('auth.session')).body.result.data.state).toBe('authenticated');
    expect((await api.query('organization.listBranches')).body.result.data.branches).toEqual([branch]);
    expect(JSON.stringify(rejected.body)).not.toMatch(/<html|passwordHash|scrypt\$/i);
    expect(JSON.stringify(rejected.body)).not.toContain(password);
  }
});

test('an action403 leaves an allowed read and the authenticated session usable without reaching a business write', async () => {
  const api = await client('HR');
  expect((await api.query('organization.listBranches')).response.status).toBe(200);
  const rejected = await api.mutate('organization.createBranch', { name: 'Forbidden write' });
  expect(rejected.response.status).toBe(403);
  expect(rejected.body.error.message).toBe('AUTH_FORBIDDEN');
  expect(rejected.response.headers.get('location')).toBeNull();
  expect(attemptedWrites).toBe(0);
  expect((await api.query('auth.session')).body.result.data.state).toBe('authenticated');
  expect((await api.query('organization.listBranches')).response.status).toBe(200);
  expect(store.events.some(event => event.module === 'organization' && event.result === 'denied' && event.reasonCode === 'AUTH_FORBIDDEN')).toBe(true);
});

test('anonymous and temporary-password sessions receive real401 responses rather than a successful login page', async () => {
  for (const [username, state] of [[undefined, 'anonymous'], ['TEMP', 'password_change']] as const) {
    const api = await client(username);
    const rejected = await api.query('users.list');
    expect(rejected.response.status).toBe(401);
    expect(rejected.body.error.message).toBe('AUTH_REQUIRED');
    expect(rejected.response.headers.get('content-type')).toContain('application/json');
    expect(rejected.response.headers.get('location')).toBeNull();
    expect((await api.query('auth.session')).body.result.data.state).toBe(state);
  }
});
