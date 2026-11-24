import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { hashPassword } from '../../../core/auth/password.ts';
import { createAuthService } from '../../auth/service.ts';
import type { AuthRequest, AuthResult } from '../../auth/service.ts';
import type { AuthUser } from '../../auth/store.ts';
import { createOrganizationService } from '../service.ts';
import { createBranchInput, createDepartmentInput, listBranchesInput, listDepartmentsInput, renameBranchInput, renameDepartmentInput } from '../validation.ts';
import { createMemoryOrganizationStore } from './memory-store.ts';

const password = 'Synthetic organization password';
let passwordHash = '';
beforeAll(async () => { passwordHash = await hashPassword(password); });

function fixture(options: { hr?: boolean; temporary?: boolean } = {}) {
  const actor: AuthUser = { id: randomUUID(), username: 'OrganizationFixture', passwordHash, roleId: randomUUID(),
    roleCode: options.hr ? 'hr' : 'system_admin', accountStatus: 'active', mustChangePassword: options.temporary ?? false,
    authVersion: 1, rolePermissions: options.hr ? ['organization.read'] : ['organization.read', 'settings.manage'], overrides: [] };
  const first = { id: randomUUID(), name: 'الفرع الأول', version: 1 };
  const second = { id: randomUUID(), name: 'Second branch', version: 1 };
  const department = { id: randomUUID(), branchId: first.id, name: 'قسم التشغيل', version: 1 };
  const otherDepartment = { id: randomUUID(), branchId: second.id, name: 'Other department', version: 1 };
  const store = createMemoryOrganizationStore([actor], [first, second], [department, otherDepartment]);
  let now = Date.parse('2026-11-23T14:00:00Z');
  const clock = () => new Date(now);
  const auth = createAuthService(store, { origin: 'http://localhost:3000', secret: 'organization-test-secret-'.repeat(3), now: clock });
  const service = createOrganizationService(store, auth, { now: clock });
  async function login() {
    let request: AuthRequest = { origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID() };
    const accept = (result: AuthResult) => { request = { ...request, token: result.token ?? request.token, csrf: result.view.csrfToken }; };
    accept(await auth.session(request)); accept(await auth.login(request, { username: actor.username, password })); return request;
  }
  return { actor, first, second, department, otherDepartment, store, auth, service, login, advance: (ms: number) => { now += ms; } };
}

test('HR reads branches and its selected branch departments but cannot write without an explicit grant', async () => {
  const f = fixture({ hr: true }); const request = await f.login();
  expect((await f.service.listBranches(request)).branches).toHaveLength(2);
  const result = await f.service.listDepartments(request, { branchId: f.first.id });
  expect(result).toEqual({ branch: f.first, departments: [f.department] });
  expect(f.store.events.at(-1)).toMatchObject({ module: 'organization', entityId: f.first.id, entityVersion: 1, metadata: { entityType: 'branch', count: 1 } });
  await expect(f.service.createBranch(request, { name: 'Forbidden branch' })).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(f.store.branches.size).toBe(2);
  expect(f.store.events.at(-1)).toMatchObject({ actorUserId: f.actor.id, actorRoleCode: 'hr', result: 'denied', reasonCode: 'AUTH_FORBIDDEN' });
  f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'settings.manage', effect: 'grant' }];
  expect((await f.service.createBranch(request, { name: 'Delegated branch' })).branch.name).toBe('Delegated branch');
});

test('special denies override the manager role and write permission never bypasses the separate read guard', async () => {
  const f = fixture(); const request = await f.login();
  f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'settings.manage', effect: 'deny' }];
  expect((await f.service.listBranches(request)).branches).toHaveLength(2);
  await expect(f.service.renameBranch(request, { branchId: f.first.id, expectedVersion: 1, name: 'Denied' })).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'organization.read', effect: 'deny' }];
  await expect(f.service.listBranches(request)).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  await expect(f.service.createDepartment(request, { branchId: f.first.id, name: 'Denied department' })).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(f.store.departments.size).toBe(2);
  expect(f.store.events.at(-1)).toMatchObject({ entityId: f.first.id, metadata: { entityType: 'branch' }, actorUserId: f.actor.id });
});

test('anonymous, preauth, temporary, expired, revoked and disabled accounts cannot read organization data', async () => {
  const f = fixture();
  const base: AuthRequest = { origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID() };
  await expect(f.service.listBranches(base)).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  const preauth = await f.auth.session(base);
  await expect(f.service.listBranches({ ...base, token: preauth.token })).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  const temporary = fixture({ temporary: true });
  await expect(temporary.service.listBranches(await temporary.login())).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  const request = await f.login();
  const sessionId = [...f.store.sessions.values()].find(row => row.userId === f.actor.id)!.id;
  f.store.sessions.get(sessionId)!.revokedAt = new Date();
  await expect(f.service.listBranches(request)).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  f.store.sessions.get(sessionId)!.revokedAt = null;
  f.store.users.get(f.actor.id)!.accountStatus = 'disabled';
  await expect(f.service.listBranches(request)).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  f.store.users.get(f.actor.id)!.accountStatus = 'active'; f.advance(30 * 60_000);
  await expect(f.service.listBranches(request)).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
});

test('branch lists and department lists are bounded by cursor and branch without per-row audit events', async () => {
  const f = fixture(); const request = await f.login();
  for (let index = 0; index < 28; index++) {
    const id = `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
    f.store.branches.set(id, { id, name: `Branch ${index}`, version: 1 });
    f.store.departments.set(id, { id, branchId: f.first.id, name: `Department ${index}`, version: 1 });
  }
  const initialEvents = f.store.events.length;
  const page = await f.service.listBranches(request);
  expect(page.branches).toHaveLength(25); expect(page.nextCursor).toBe(page.branches.at(-1)!.id);
  const next = await f.service.listBranches(request, { cursor: page.nextCursor });
  expect(next.branches).toHaveLength(5); expect(next.nextCursor).toBeUndefined();
  const departmentPage = await f.service.listDepartments(request, { branchId: f.first.id });
  expect(departmentPage.departments).toHaveLength(25);
  const later = await f.service.listDepartments(request, { branchId: f.first.id, cursor: departmentPage.nextCursor });
  expect(later.departments).toHaveLength(4);
  expect([...departmentPage.departments, ...later.departments].every(row => row.branchId === f.first.id)).toBe(true);
  expect(f.store.events.length - initialEvents).toBe(4);
});

test('create and rename preserve trimmed Unicode names and allow duplicates without changing identity or sessions', async () => {
  const f = fixture(); const request = await f.login(); const sessionBefore = structuredClone([...f.store.sessions.values()]);
  const created = await f.service.createBranch(request, { name: '  فرع عربي English  ' });
  expect(created.branch).toMatchObject({ name: 'فرع عربي English', version: 1 });
  expect(f.store.events.at(-1)).toMatchObject({ entityId: created.branch.id, entityVersion: 1, metadata: { entityType: 'branch' } });
  expect((await f.service.createBranch(request, { name: created.branch.name })).branch.id).not.toBe(created.branch.id);
  const firstDepartment = await f.service.createDepartment(request, { branchId: created.branch.id, name: '  تشغيل Operations  ' });
  expect(f.store.events.at(-1)).toMatchObject({ entityId: firstDepartment.department.id, entityVersion: 1, metadata: { entityType: 'department' } });
  const duplicate = await f.service.createDepartment(request, { branchId: created.branch.id, name: 'تشغيل Operations' });
  expect(duplicate.department.id).not.toBe(firstDepartment.department.id);
  const updated = await f.service.renameBranch(request, { branchId: created.branch.id, expectedVersion: 1, name: '  الاسم الجديد  ' });
  expect(updated).toEqual({ changed: true, branch: { ...created.branch, name: 'الاسم الجديد', version: 2 } });
  const renamed = await f.service.renameDepartment(request, { branchId: created.branch.id, departmentId: firstDepartment.department.id, expectedVersion: 1, name: '  الإدارة  ' });
  expect(renamed).toEqual({ changed: true, department: { ...firstDepartment.department, name: 'الإدارة', version: 2 } });
  expect(f.store.users.get(f.actor.id)!.authVersion).toBe(1);
  expect(structuredClone([...f.store.sessions.values()])).toEqual(sessionBefore);
  expect(f.store.events.at(-1)).toMatchObject({ entityId: firstDepartment.department.id, entityVersion: 2, metadata: { entityType: 'department', changed: true },
    beforeValues: { branchId: created.branch.id, name: 'تشغيل Operations', version: 1 }, afterValues: { branchId: created.branch.id, name: 'الإدارة', version: 2 } });
  expect(JSON.stringify(f.store.events)).not.toMatch(/passwordHash|currentPassword|tokenHash|scrypt\$/);
  expect(JSON.stringify(f.store.events)).not.toContain(password);
});

test('matching names are no-ops while stale versions and exhausted changed versions reject without overwrite', async () => {
  const f = fixture(); const request = await f.login();
  const same = await f.service.renameBranch(request, { branchId: f.first.id, expectedVersion: 1, name: `  ${f.first.name}  ` });
  expect(same).toEqual({ changed: false, branch: f.first });
  expect(f.store.events.at(-1)).toMatchObject({ entityId: f.first.id, entityVersion: 1, metadata: { entityType: 'branch', changed: false } });
  expect(await f.service.renameDepartment(request, { branchId: f.first.id, departmentId: f.department.id, expectedVersion: 1, name: f.department.name })).toEqual({ changed: false, department: f.department });
  await f.service.renameBranch(request, { branchId: f.first.id, expectedVersion: 1, name: 'A new name' });
  await expect(f.service.renameBranch(request, { branchId: f.first.id, expectedVersion: 1, name: 'Overwrite' })).rejects.toMatchObject({ reason: 'ORG_CONFLICT' });
  expect(f.store.branches.get(f.first.id)!.name).toBe('A new name');
  f.store.departments.get(f.department.id)!.version = 4_294_967_295;
  await expect(f.service.renameDepartment(request, { branchId: f.first.id, departmentId: f.department.id, expectedVersion: 4_294_967_295, name: 'Overflow' })).rejects.toMatchObject({ reason: 'ORG_CONFLICT' });
  expect((await f.service.renameDepartment(request, { branchId: f.first.id, departmentId: f.department.id, expectedVersion: 4_294_967_295, name: f.department.name })).changed).toBe(false);
});

test('a department cannot be read or renamed under another branch and a missing branch cannot be used', async () => {
  const f = fixture(); const request = await f.login(); const missingId = randomUUID();
  await expect(f.service.listDepartments(request, { branchId: missingId })).rejects.toMatchObject({ reason: 'ORG_BRANCH_NOT_FOUND' });
  await expect(f.service.createDepartment(request, { branchId: missingId, name: 'Missing branch department' })).rejects.toMatchObject({ reason: 'ORG_BRANCH_NOT_FOUND' });
  await expect(f.service.renameDepartment(request, { branchId: f.second.id, departmentId: f.department.id, expectedVersion: 1, name: 'Wrong branch' })).rejects.toMatchObject({ reason: 'ORG_DEPARTMENT_NOT_FOUND' });
  await expect(f.service.renameDepartment(request, { branchId: f.first.id, departmentId: missingId, expectedVersion: 1, name: 'Missing department' })).rejects.toMatchObject({ reason: 'ORG_DEPARTMENT_NOT_FOUND' });
  expect(f.store.departments.get(f.department.id)).toEqual(f.department);
});

test('two edits to the same branch version commit one name and reject the stale writer', async () => {
  const f = fixture(); const request = await f.login();
  const results = await Promise.allSettled(['First writer', 'Second writer'].map(name => f.service.renameBranch(request, { branchId: f.first.id, expectedVersion: 1, name })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const denied = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  expect(denied.reason).toMatchObject({ reason: 'ORG_CONFLICT' });
  expect(f.store.branches.get(f.first.id)!.version).toBe(2);
  expect(f.store.events.filter(event => event.action === 'organization.branches.rename').map(event => event.result)).toEqual(['success', 'denied']);
});

test('mutations reject a foreign origin or missing CSRF before changing branch or department state', async () => {
  const f = fixture(); const request = await f.login();
  await expect(f.service.createBranch({ ...request, origin: 'https://foreign.invalid' }, { name: 'Foreign' })).rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  await expect(f.service.createDepartment({ ...request, csrf: undefined }, { branchId: f.first.id, name: 'No CSRF' })).rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  expect(f.store.branches.size).toBe(2); expect(f.store.departments.size).toBe(2);
});

test('the fresh guard observes permission withdrawal at the transaction boundary', async () => {
  const f = fixture(); const request = await f.login();
  f.store.setBeforeTransaction(() => { f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'settings.manage', effect: 'deny' }]; });
  await expect(f.service.renameBranch(request, { branchId: f.first.id, expectedVersion: 1, name: 'Withdrawn' })).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(f.store.branches.get(f.first.id)).toEqual(f.first);
});

test('write and outbox failures roll back newly inserted or renamed rows and versions without a success event', async () => {
  const f = fixture(); const request = await f.login(); const eventCount = f.store.events.length;
  f.store.setWriteFailure(true);
  await expect(f.service.createBranch(request, { name: 'Partial branch' })).rejects.toThrow('Synthetic organization write failure');
  await expect(f.service.renameDepartment(request, { branchId: f.first.id, departmentId: f.department.id, expectedVersion: 1, name: 'Partial name' })).rejects.toThrow();
  f.store.setWriteFailure(false); f.store.setAuditFailure(true);
  await expect(f.service.createDepartment(request, { branchId: f.first.id, name: 'Lost audit department' })).rejects.toThrow();
  await expect(f.service.renameBranch(request, { branchId: f.first.id, expectedVersion: 1, name: 'Lost audit name' })).rejects.toThrow();
  expect(f.store.branches.size).toBe(2); expect(f.store.departments.size).toBe(2);
  expect(f.store.branches.get(f.first.id)).toEqual(f.first); expect(f.store.departments.get(f.department.id)).toEqual(f.department);
  expect(f.store.events).toHaveLength(eventCount);
});

test('strict input validation bounds Unicode names, IDs and versions and excludes unplanned fields and moves', () => {
  expect(createBranchInput({ name: '  عربي English  ' })).toEqual({ name: 'عربي English' });
  expect(createBranchInput({ name: '😀'.repeat(150) }).name).toHaveLength(300);
  expect(() => createBranchInput({ name: '😀'.repeat(151) })).toThrow('ORG_INVALID_INPUT');
  for (const input of [{ name: '' }, { name: '  ' }, { name: 123 }, { name: 'Valid', phone: 'Extra' }, null, []]) expect(() => createBranchInput(input)).toThrow('ORG_INVALID_INPUT');
  expect(listBranchesInput(undefined)).toEqual({});
  expect(() => listBranchesInput({ cursor: 'bad' })).toThrow('ORG_INVALID_INPUT');
  expect(() => listDepartmentsInput({ branchId: randomUUID(), scope: 'all' })).toThrow('ORG_INVALID_INPUT');
  expect(() => createDepartmentInput({ branchId: 'bad', name: 'Valid' })).toThrow('ORG_INVALID_INPUT');
  for (const expectedVersion of [0, -1, 1.5, Number.NaN, 4_294_967_296, '1']) expect(() => renameBranchInput({ branchId: randomUUID(), expectedVersion, name: 'Valid' })).toThrow('ORG_INVALID_INPUT');
  expect(() => renameDepartmentInput({ branchId: randomUUID(), departmentId: randomUUID(), expectedVersion: 1, name: 'Valid', destinationBranchId: randomUUID() })).toThrow('ORG_INVALID_INPUT');
});
