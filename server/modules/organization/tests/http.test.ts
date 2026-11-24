import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../../app.ts';
import { hashPassword } from '../../../core/auth/password.ts';
import type { AuthUser } from '../../auth/store.ts';
import { initialRolePermissions } from '../../../../shared/permissions/catalog.ts';
import { createMemoryOrganizationStore } from './memory-store.ts';

const password = 'Synthetic organization HTTP password';
const configuredOrigin = 'http://localhost:3000';
const branchOne = { id: randomUUID(), name: 'الفرع الأول', version: 1 };
const branchTwo = { id: randomUUID(), name: 'Second branch', version: 1 };
const departmentOne = { id: randomUUID(), branchId: branchOne.id, name: 'الشؤون الإدارية', version: 1 };
const departmentTwo = { id: randomUUID(), branchId: branchTwo.id, name: 'Operations', version: 1 };
let passwordHash = '';
let listener: ReturnType<ReturnType<typeof createApp>['listen']>;
let origin: string;
let store: ReturnType<typeof createMemoryOrganizationStore>;

beforeAll(async () => { passwordHash = await hashPassword(password); });
beforeEach(async () => {
  const make = (username: string, roleCode: 'system_admin' | 'hr', overrides: AuthUser['overrides'] = [], temporary = false): AuthUser => ({
    id: randomUUID(), username, passwordHash, roleId: randomUUID(), roleCode, accountStatus: 'active',
    mustChangePassword: temporary, authVersion: 1, rolePermissions: [...initialRolePermissions[roleCode]], overrides,
  });
  store = createMemoryOrganizationStore([
    make('MANAGER', 'system_admin'), make('HR01', 'hr'), make('TEMP', 'system_admin', [], true),
    make('READ_DENIED', 'system_admin', [{ permissionCode: 'organization.read', effect: 'deny' }]),
    make('WRITE_DENIED', 'system_admin', [{ permissionCode: 'settings.manage', effect: 'deny' }]),
    make('DELEGATED', 'hr', [{ permissionCode: 'settings.manage', effect: 'grant' }]),
  ], [branchOne, branchTwo], [departmentOne, departmentTwo]);
  listener = createApp({ authStore: store, organizationStore: store,
    authConfig: { origin: configuredOrigin, secret: 'synthetic-organization-http-secret-'.repeat(2) } }).listen(0, '127.0.0.1');
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
  const send = async (path: string, input?: unknown, mutation = false, headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}/api/trpc/${path}${!mutation && input !== undefined ? '?input=' + encodeURIComponent(JSON.stringify(input)) : ''}`, {
      method: mutation ? 'POST' : 'GET', headers: { cookie, origin: configuredOrigin,
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

test('direct reads and writes reject preauthentication, temporary sessions and a denied read permission', async () => {
  for (const [username, status] of [[undefined, 401], ['TEMP', 401], ['READ_DENIED', 403]] as const) {
    const api = await client(username);
    const results = [await api.query('organization.listBranches'),
      await api.query('organization.listDepartments', { branchId: branchOne.id }),
      await api.mutate('organization.createBranch', { name: 'Must not save' }),
      await api.mutate('organization.createDepartment', { branchId: branchOne.id, name: 'Must not save' })];
    for (const result of results) {
      expect(result.response.status).toBe(status);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
      expect(result.body).not.toHaveProperty('result');
      expect(JSON.stringify(result.body)).not.toContain(password);
    }
  }
  expect(store.branches.size).toBe(2);
  expect(store.departments.size).toBe(2);
});

test('HR reads only its selected branch departments while write grants and denials are evaluated independently of role names', async () => {
  const hr = await client('HR01');
  const branches = await hr.query('organization.listBranches');
  expect(branches.response.status).toBe(200);
  expect(branches.body.result.data.branches).toHaveLength(2);
  expect(branches.response.headers.get('cache-control')).toBe('no-store');
  const departments = await hr.query('organization.listDepartments', { branchId: branchOne.id });
  expect(departments.response.status).toBe(200);
  expect(departments.body.result.data.branch.id).toBe(branchOne.id);
  expect(departments.body.result.data.departments).toEqual([departmentOne]);
  expect(JSON.stringify(departments.body)).not.toContain(departmentTwo.id);
  expect((await hr.mutate('organization.renameBranch', { branchId: branchOne.id, expectedVersion: 1, name: 'Blocked rename' })).response.status).toBe(403);
  const denied = await client('WRITE_DENIED');
  expect((await denied.query('organization.listBranches')).response.status).toBe(200);
  expect((await denied.mutate('organization.createBranch', { name: 'Blocked manager' })).response.status).toBe(403);
  const delegated = await client('DELEGATED');
  const created = await delegated.mutate('organization.createBranch', { name: 'Allowed delegated HR' });
  expect(created.response.status).toBe(200);
  expect(created.body.result.data.branch.name).toBe('Allowed delegated HR');
  expect(JSON.stringify([branches.body, departments.body, created.body, store.events])).not.toMatch(/passwordHash|scrypt\$|tokenHash/);
});

test('HTTP saves normalize names, retain duplicate names, enforce versions and leave sessions intact', async () => {
  const api = await client('MANAGER');
  const creation = await api.mutate('organization.createBranch', { name: '  فرع جديد  ' });
  expect(creation.response.status).toBe(200);
  const branch = creation.body.result.data.branch;
  expect(branch.name).toBe('فرع جديد');
  expect(branch.version).toBe(1);
  const duplicate = await api.mutate('organization.createBranch', { name: branch.name });
  expect(duplicate.response.status).toBe(200);
  expect(duplicate.body.result.data.branch.id).not.toBe(branch.id);
  const renamed = await api.mutate('organization.renameBranch', { branchId: branch.id, expectedVersion: 1, name: 'New branch name' });
  expect(renamed.response.status).toBe(200);
  expect(renamed.body.result.data).toEqual({ changed: true, branch: { ...branch, name: 'New branch name', version: 2 } });
  const stale = await api.mutate('organization.renameBranch', { branchId: branch.id, expectedVersion: 1, name: 'Stale overwrite' });
  expect(stale.response.status).toBe(409);
  expect(stale.body.error.message).toBe('ORG_CONFLICT');
  const unchanged = await api.mutate('organization.renameBranch', { branchId: branch.id, expectedVersion: 2, name: '  New branch name  ' });
  expect(unchanged.response.status).toBe(200);
  expect(unchanged.body.result.data.changed).toBe(false);
  expect(unchanged.body.result.data.branch.version).toBe(2);
  const createdDepartment = await api.mutate('organization.createDepartment', { branchId: branch.id, name: '  قسم جديد  ' });
  expect(createdDepartment.response.status).toBe(200);
  const department = createdDepartment.body.result.data.department;
  expect(department).toMatchObject({ branchId: branch.id, name: 'قسم جديد', version: 1 });
  const renamedDepartment = await api.mutate('organization.renameDepartment', { branchId: branch.id, departmentId: department.id, expectedVersion: 1, name: 'Updated department' });
  expect(renamedDepartment.response.status).toBe(200);
  expect(renamedDepartment.body.result.data.department).toMatchObject({ branchId: branch.id, name: 'Updated department', version: 2 });
  expect((await api.query('auth.session')).body.result.data.state).toBe('authenticated');
  expect([...store.users.values()].every(user => user.authVersion === 1)).toBe(true);
  expect(JSON.stringify(store.events)).not.toContain(password);
});

test('department rename cannot use a different valid branch and missing branch reads fail without leaking unrelated references', async () => {
  const api = await client('MANAGER');
  const rejected = await api.mutate('organization.renameDepartment', { branchId: branchTwo.id, departmentId: departmentOne.id, expectedVersion: 1, name: 'Wrong branch rename' });
  expect(rejected.response.status).toBe(404);
  expect(rejected.body.error.message).toBe('ORG_DEPARTMENT_NOT_FOUND');
  expect(store.departments.get(departmentOne.id)).toEqual(departmentOne);
  const missing = await api.query('organization.listDepartments', { branchId: randomUUID() });
  expect(missing.response.status).toBe(404);
  expect(missing.body.error.message).toBe('ORG_BRANCH_NOT_FOUND');
  expect(JSON.stringify([rejected.body, missing.body])).not.toContain(departmentOne.name);
});

test('CSRF, GET mutations and unrecognized structural fields cannot save changes', async () => {
  const api = await client('MANAGER');
  const rejectedHeaders: Record<string, string>[] = [{ origin: 'https://foreign.invalid' }, { 'x-madar-csrf': '' }];
  for (const headers of rejectedHeaders) {
    const rejected = await api.mutate('organization.createBranch', { name: 'Must not save' }, headers);
    expect(rejected.response.status).toBe(403);
    expect(rejected.body.error.message).toBe('AUTH_CSRF');
  }
  for (const input of [{ name: 'Injected branch', version: 99 }, { name: '  ' }, { name: 'Injected branch', settings: { secret: password } }]) {
    const invalid = await api.mutate('organization.createBranch', input);
    expect(invalid.response.status).toBe(400);
    expect(JSON.stringify(invalid.body)).not.toContain(password);
  }
  expect((await api.query('organization.createBranch')).response.status).toBe(405);
  expect(store.branches.size).toBe(2);
});

test('failed audit or writes return safe no-store errors and roll back creation and renaming', async () => {
  const api = await client('MANAGER');
  for (const failure of ['audit', 'write'] as const) {
    if (failure === 'audit') store.setAuditFailure(true); else store.setWriteFailure(true);
    try {
      const results = [await api.mutate('organization.createBranch', { name: 'Rollback branch' }),
        await api.mutate('organization.renameDepartment', { branchId: branchOne.id, departmentId: departmentOne.id, expectedVersion: 1, name: 'Rollback department' })];
      for (const rejected of results) {
        expect(rejected.response.status).toBe(503);
        expect(rejected.response.headers.get('cache-control')).toBe('no-store');
        expect(rejected.body.error.message).toBe('ORG_UNAVAILABLE');
        expect(rejected.body.error.data.requestId).toMatch(/^[a-f0-9-]{36}$/);
        expect(JSON.stringify(rejected.body)).not.toMatch(/Synthetic|insert into|scrypt\$|passwordHash/);
        expect(JSON.stringify(rejected.body)).not.toContain(password);
      }
      expect(store.branches.size).toBe(2);
      expect(store.departments.get(departmentOne.id)).toEqual(departmentOne);
    } finally { store.setAuditFailure(false); store.setWriteFailure(false); }
  }
  expect((await api.query('auth.session')).body.result.data.state).toBe('authenticated');
});
