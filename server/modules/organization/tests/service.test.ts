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
  async function login(username = actor.username) {
    let request: AuthRequest = { origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID() };
    const accept = (result: AuthResult) => { request = { ...request, token: result.token ?? request.token, csrf: result.view.csrfToken }; };
    accept(await auth.session(request)); accept(await auth.login(request, { username, password })); return request;
  }
  return { actor, first, second, department, otherDepartment, store, auth, service, login, advance: (ms: number) => { now += ms; } };
}

test('HR reads branches and its selected branch departments but cannot write without an explicit grant', async () => {
  const f = fixture({ hr: true }); const request = await f.login();
  expect((await f.service.listBranches(request)).branches).toHaveLength(2);
  const result = await f.service.listDepartments(request, { branchId: f.first.id });
  expect(result).toEqual({ branch: f.first, departments: [f.department] });
  expect(f.store.events.at(-1)).toMatchObject({ module: 'organization', entityId: f.first.id, entityVersion: 1, metadata: { entityType: 'branch', count: 1 } });
  await expect(f.service.createBranch(request, { operationId: randomUUID(), name: 'Forbidden branch' })).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(f.store.branches.size).toBe(2);
  expect(f.store.events.at(-1)).toMatchObject({ actorUserId: f.actor.id, actorRoleCode: 'hr', result: 'denied', reasonCode: 'AUTH_FORBIDDEN' });
  f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'settings.manage', effect: 'grant' }];
  expect((await f.service.createBranch(request, { operationId: randomUUID(), name: 'Delegated branch' })).branch.name).toBe('Delegated branch');
});

test('special denies override the manager role and write permission never bypasses the separate read guard', async () => {
  const f = fixture(); const request = await f.login();
  f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'settings.manage', effect: 'deny' }];
  expect((await f.service.listBranches(request)).branches).toHaveLength(2);
  await expect(f.service.renameBranch(request, { operationId: randomUUID(), branchId: f.first.id, expectedVersion: 1, name: 'Denied' })).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'organization.read', effect: 'deny' }];
  await expect(f.service.listBranches(request)).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  await expect(f.service.createDepartment(request, { operationId: randomUUID(), branchId: f.first.id, name: 'Denied department' })).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
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
  const created = await f.service.createBranch(request, { operationId: randomUUID(), name: '  فرع عربي English  ' });
  expect(created.branch).toMatchObject({ name: 'فرع عربي English', version: 1 });
  expect(f.store.events.at(-1)).toMatchObject({ entityId: created.branch.id, entityVersion: 1, metadata: { entityType: 'branch' } });
  expect((await f.service.createBranch(request, { operationId: randomUUID(), name: created.branch.name })).branch.id).not.toBe(created.branch.id);
  const firstDepartment = await f.service.createDepartment(request, { operationId: randomUUID(), branchId: created.branch.id, name: '  تشغيل Operations  ' });
  expect(f.store.events.at(-1)).toMatchObject({ entityId: firstDepartment.department.id, entityVersion: 1, metadata: { entityType: 'department' } });
  const duplicate = await f.service.createDepartment(request, { operationId: randomUUID(), branchId: created.branch.id, name: 'تشغيل Operations' });
  expect(duplicate.department.id).not.toBe(firstDepartment.department.id);
  const updated = await f.service.renameBranch(request, { operationId: randomUUID(), branchId: created.branch.id, expectedVersion: 1, name: '  الاسم الجديد  ' });
  expect(updated).toEqual({ changed: true, branch: { ...created.branch, name: 'الاسم الجديد', version: 2 } });
  const renamed = await f.service.renameDepartment(request, { operationId: randomUUID(), branchId: created.branch.id, departmentId: firstDepartment.department.id, expectedVersion: 1, name: '  الإدارة  ' });
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
  const same = await f.service.renameBranch(request, { operationId: randomUUID(), branchId: f.first.id, expectedVersion: 1, name: `  ${f.first.name}  ` });
  expect(same).toEqual({ changed: false, branch: f.first });
  expect(f.store.events.at(-1)).toMatchObject({ entityId: f.first.id, entityVersion: 1, metadata: { entityType: 'branch', changed: false } });
  expect(await f.service.renameDepartment(request, { operationId: randomUUID(), branchId: f.first.id, departmentId: f.department.id, expectedVersion: 1, name: f.department.name })).toEqual({ changed: false, department: f.department });
  await f.service.renameBranch(request, { operationId: randomUUID(), branchId: f.first.id, expectedVersion: 1, name: 'A new name' });
  await expect(f.service.renameBranch(request, { operationId: randomUUID(), branchId: f.first.id, expectedVersion: 1, name: 'Overwrite' })).rejects.toMatchObject({ reason: 'ORG_CONFLICT' });
  expect(f.store.branches.get(f.first.id)!.name).toBe('A new name');
  f.store.departments.get(f.department.id)!.version = 4_294_967_295;
  await expect(f.service.renameDepartment(request, { operationId: randomUUID(), branchId: f.first.id, departmentId: f.department.id, expectedVersion: 4_294_967_295, name: 'Overflow' })).rejects.toMatchObject({ reason: 'ORG_CONFLICT' });
  expect((await f.service.renameDepartment(request, { operationId: randomUUID(), branchId: f.first.id, departmentId: f.department.id, expectedVersion: 4_294_967_295, name: f.department.name })).changed).toBe(false);
});

test('a department cannot be read or renamed under another branch and a missing branch cannot be used', async () => {
  const f = fixture(); const request = await f.login(); const missingId = randomUUID();
  await expect(f.service.listDepartments(request, { branchId: missingId })).rejects.toMatchObject({ reason: 'ORG_BRANCH_NOT_FOUND' });
  await expect(f.service.createDepartment(request, { operationId: randomUUID(), branchId: missingId, name: 'Missing branch department' })).rejects.toMatchObject({ reason: 'ORG_BRANCH_NOT_FOUND' });
  await expect(f.service.renameDepartment(request, { operationId: randomUUID(), branchId: f.second.id, departmentId: f.department.id, expectedVersion: 1, name: 'Wrong branch' })).rejects.toMatchObject({ reason: 'ORG_DEPARTMENT_NOT_FOUND' });
  await expect(f.service.renameDepartment(request, { operationId: randomUUID(), branchId: f.first.id, departmentId: missingId, expectedVersion: 1, name: 'Missing department' })).rejects.toMatchObject({ reason: 'ORG_DEPARTMENT_NOT_FOUND' });
  expect(f.store.departments.get(f.department.id)).toEqual(f.department);
});

test('two edits to the same branch version commit one name and reject the stale writer', async () => {
  const f = fixture(); const request = await f.login();
  const results = await Promise.allSettled(['First writer', 'Second writer'].map(name => f.service.renameBranch(request, { operationId: randomUUID(), branchId: f.first.id, expectedVersion: 1, name })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const denied = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  expect(denied.reason).toMatchObject({ reason: 'ORG_CONFLICT' });
  expect(f.store.branches.get(f.first.id)!.version).toBe(2);
  expect(f.store.events.filter(event => event.action === 'organization.branches.rename').map(event => event.result)).toEqual(['success', 'denied']);
});

test('mutations reject a foreign origin or missing CSRF before changing branch or department state', async () => {
  const f = fixture(); const request = await f.login();
  await expect(f.service.createBranch({ ...request, origin: 'https://foreign.invalid' }, { operationId: randomUUID(), name: 'Foreign' })).rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  await expect(f.service.createDepartment({ ...request, csrf: undefined }, { operationId: randomUUID(), branchId: f.first.id, name: 'No CSRF' })).rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  expect(f.store.branches.size).toBe(2); expect(f.store.departments.size).toBe(2);
});

test('the fresh guard observes permission withdrawal at the transaction boundary', async () => {
  const f = fixture(); const request = await f.login();
  f.store.setBeforeTransaction(() => { f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'settings.manage', effect: 'deny' }]; });
  await expect(f.service.renameBranch(request, { operationId: randomUUID(), branchId: f.first.id, expectedVersion: 1, name: 'Withdrawn' })).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(f.store.branches.get(f.first.id)).toEqual(f.first);
});

test('write and outbox failures roll back newly inserted or renamed rows and versions without a success event', async () => {
  const f = fixture(); const request = await f.login(); const eventCount = f.store.events.length;
  f.store.setWriteFailure(true);
  await expect(f.service.createBranch(request, { operationId: randomUUID(), name: 'Partial branch' })).rejects.toThrow('Synthetic organization write failure');
  await expect(f.service.renameDepartment(request, { operationId: randomUUID(), branchId: f.first.id, departmentId: f.department.id, expectedVersion: 1, name: 'Partial name' })).rejects.toThrow();
  f.store.setWriteFailure(false); f.store.setAuditFailure(true);
  await expect(f.service.createDepartment(request, { operationId: randomUUID(), branchId: f.first.id, name: 'Lost audit department' })).rejects.toThrow();
  await expect(f.service.renameBranch(request, { operationId: randomUUID(), branchId: f.first.id, expectedVersion: 1, name: 'Lost audit name' })).rejects.toThrow();
  expect(f.store.branches.size).toBe(2); expect(f.store.departments.size).toBe(2);
  expect(f.store.branches.get(f.first.id)).toEqual(f.first); expect(f.store.departments.get(f.department.id)).toEqual(f.department);
  expect(f.store.events).toHaveLength(eventCount);
});

test('strict input validation bounds Unicode names, IDs and versions and excludes unplanned fields and moves', () => {
  const operationId = randomUUID();
  expect(createBranchInput({ operationId: operationId.toUpperCase(), name: '  عربي English  ' })).toEqual({ operationId, name: 'عربي English' });
  expect(createBranchInput({ operationId: randomUUID(), name: '😀'.repeat(150) }).name).toHaveLength(300);
  expect(() => createBranchInput({ operationId: randomUUID(), name: '😀'.repeat(151) })).toThrow('ORG_INVALID_INPUT');
  for (const input of [{ operationId, name: '' }, { operationId, name: '  ' }, { operationId, name: 123 }, { operationId, name: 'Valid', phone: 'Extra' }, null, []]) expect(() => createBranchInput(input)).toThrow('ORG_INVALID_INPUT');
  for (const operationId of ['', 'bad', 123, null]) expect(() => createBranchInput({ operationId, name: 'Valid' })).toThrow('ORG_INVALID_INPUT');
  expect(() => createBranchInput({ name: 'Legacy client' })).toThrow('ORG_CLIENT_UPDATE_REQUIRED');
  expect(listBranchesInput(undefined)).toEqual({});
  expect(() => listBranchesInput({ cursor: 'bad' })).toThrow('ORG_INVALID_INPUT');
  expect(() => listDepartmentsInput({ branchId: randomUUID(), scope: 'all' })).toThrow('ORG_INVALID_INPUT');
  expect(() => createDepartmentInput({ operationId: randomUUID(), branchId: 'bad', name: 'Valid' })).toThrow('ORG_INVALID_INPUT');
  for (const expectedVersion of [0, -1, 1.5, Number.NaN, 4_294_967_296, '1']) expect(() => renameBranchInput({ operationId: randomUUID(), branchId: randomUUID(), expectedVersion, name: 'Valid' })).toThrow('ORG_INVALID_INPUT');
  expect(() => renameDepartmentInput({ operationId: randomUUID(), branchId: randomUUID(), departmentId: randomUUID(), expectedVersion: 1, name: 'Valid', destinationBranchId: randomUUID() })).toThrow('ORG_INVALID_INPUT');
});

test.each(['createBranch', 'renameBranch', 'createDepartment', 'renameDepartment'] as const)('%s replays its committed result without repeating the domain change', async operation => {
  const f = fixture(); const request = await f.login(); const operationId = randomUUID();
  const invoke = async () => {
    if (operation === 'createBranch') return f.service.createBranch(request, { operationId, name: 'A repeated branch request' });
    if (operation === 'renameBranch') return f.service.renameBranch(request, { operationId, branchId: f.first.id, expectedVersion: 1, name: 'Renamed exactly once' });
    if (operation === 'createDepartment') return f.service.createDepartment(request, { operationId, branchId: f.first.id, name: 'A repeated department request' });
    return f.service.renameDepartment(request, { operationId, branchId: f.first.id, departmentId: f.department.id, expectedVersion: 1, name: 'Renamed department once' });
  };
  const first = await invoke(); const replay = await invoke();
  expect(replay).toEqual(first);
  expect(f.store.receipts.size).toBe(1);
  expect(f.store.branches.size).toBe(operation === 'createBranch' ? 3 : 2);
  expect(f.store.departments.size).toBe(operation === 'createDepartment' ? 3 : 2);
  expect(f.store.branches.get(f.first.id)!.version).toBe(operation === 'renameBranch' ? 2 : 1);
  expect(f.store.departments.get(f.department.id)!.version).toBe(operation === 'renameDepartment' ? 2 : 1);
  const action = `organization.${operation.endsWith('Branch') ? 'branches' : 'departments'}.${operation.startsWith('create') ? 'create' : 'rename'}`;
  expect(f.store.events.filter(event => event.action === action && event.result === 'success')).toHaveLength(1);
  const replays = f.store.events.filter(event => event.action === `${action}.replay`);
  expect(replays).toHaveLength(1);
  expect(replays[0]).toMatchObject({ actorUserId: f.actor.id, result: 'success', metadata: { replayed: true } });
  expect(replays[0].beforeValues ?? null).toBeNull();
  expect(replays[0].afterValues ?? null).toBeNull();
  expect(JSON.stringify(f.store.events)).not.toMatch(/inputHash|reservationToken|response_json|passwordHash|tokenHash/);
});

test('concurrent arrivals of the same operation commit one create in the serialized memory model', async () => {
  const f = fixture(); const request = await f.login();
  const input = { operationId: randomUUID(), name: 'One concurrent intention' };
  const results = await Promise.all(Array.from({ length: 6 }, () => f.service.createBranch({ ...request, requestId: randomUUID() }, input)));
  expect(new Set(results.map(value => value.branch.id)).size).toBe(1);
  expect(f.store.branches.size).toBe(3);
  expect(f.store.receipts.size).toBe(1);
  expect(f.store.events.filter(event => event.action === 'organization.branches.create' && event.result === 'success')).toHaveLength(1);
  expect(f.store.events.filter(event => event.action === 'organization.branches.create.replay')).toHaveLength(5);
});

test('the same key rejects another payload, operation or target instead of returning an unrelated receipt', async () => {
  const f = fixture(); const request = await f.login();
  const creation = { operationId: randomUUID(), name: 'Original payload' };
  const first = await f.service.createBranch(request, creation);
  await expect(f.service.createBranch(request, { ...creation, name: 'Changed payload' })).rejects.toMatchObject({ reason: 'ORG_OPERATION_CONFLICT' });
  await expect(f.service.createDepartment(request, { operationId: creation.operationId, branchId: f.first.id, name: creation.name })).rejects.toMatchObject({ reason: 'ORG_OPERATION_CONFLICT' });
  const rename = { operationId: randomUUID(), branchId: f.first.id, expectedVersion: 1, name: 'Changed target name' };
  await f.service.renameBranch(request, rename);
  await expect(f.service.renameBranch(request, { ...rename, branchId: f.second.id })).rejects.toMatchObject({ reason: 'ORG_OPERATION_CONFLICT' });
  await expect(f.service.renameBranch(request, { ...rename, expectedVersion: 2 })).rejects.toMatchObject({ reason: 'ORG_OPERATION_CONFLICT' });
  expect(f.store.branches.size).toBe(3); expect(f.store.departments.size).toBe(2);
  expect(f.store.branches.get(first.branch.id)!.name).toBe(creation.name);
  expect(f.store.branches.get(f.second.id)).toEqual(f.second);
  expect(f.store.receipts.size).toBe(2);
});

test('replay returns the original snapshot after a later intentional edit without undoing the later edit', async () => {
  const f = fixture(); const request = await f.login();
  const firstInput = { operationId: randomUUID(), branchId: f.first.id, expectedVersion: 1, name: 'First intentional rename' };
  const first = await f.service.renameBranch(request, firstInput);
  await f.service.renameBranch(request, { operationId: randomUUID(), branchId: f.first.id, expectedVersion: 2, name: 'Later intentional rename' });
  expect(await f.service.renameBranch(request, firstInput)).toEqual(first);
  expect(f.store.branches.get(f.first.id)).toMatchObject({ name: 'Later intentional rename', version: 3 });
});

test('matching-name operations retain completed receipts and replay changed false without changing versions', async () => {
  const f = fixture(); const request = await f.login();
  const branchInput = { operationId: randomUUID(), branchId: f.first.id, expectedVersion: 1, name: f.first.name };
  const departmentInput = { operationId: randomUUID(), branchId: f.first.id, departmentId: f.department.id, expectedVersion: 1, name: f.department.name };
  const branch = await f.service.renameBranch(request, branchInput);
  const department = await f.service.renameDepartment(request, departmentInput);
  expect(await f.service.renameBranch(request, branchInput)).toEqual(branch);
  expect(await f.service.renameDepartment(request, departmentInput)).toEqual(department);
  expect(branch.changed).toBe(false); expect(department.changed).toBe(false);
  expect(f.store.branches.get(f.first.id)).toEqual(f.first);
  expect(f.store.departments.get(f.department.id)).toEqual(f.department);
  expect(f.store.receipts.size).toBe(2);
  expect([...f.store.receipts.values()].every(receipt => receipt.response !== null)).toBe(true);
  expect(f.store.events.filter(event => event.action.endsWith('.replay') && event.result === 'success')).toHaveLength(2);
});

test('an authorized second actor cannot use the first actor key or read its saved result', async () => {
  const f = fixture(); const request = await f.login();
  const input = { operationId: randomUUID(), name: 'Actor-owned operation' };
  const first = await f.service.createBranch(request, input);
  const other: AuthUser = { ...f.actor, id: randomUUID(), username: 'AnotherOrganizationActor', roleId: randomUUID() };
  f.store.users.set(other.id, other);
  const otherRequest = await f.login(other.username);
  await expect(f.service.createBranch(otherRequest, input)).rejects.toMatchObject({ reason: 'ORG_OPERATION_CONFLICT' });
  expect(f.store.branches.size).toBe(3);
  expect(f.store.receipts.get(input.operationId)!.actorUserId).toBe(f.actor.id);
  expect(f.store.events.at(-1)).toMatchObject({ actorUserId: other.id, result: 'denied', reasonCode: 'ORG_OPERATION_CONFLICT' });
  expect(f.store.events.at(-1)?.afterValues ?? null).toBeNull();
  expect(f.store.events.filter(event => event.action === 'organization.branches.create.replay')).toHaveLength(0);
  expect(f.store.branches.get(first.branch.id)!.name).toBe(input.name);
});

test('every replay rechecks current permission, session and CSRF before exposing the stored response', async () => {
  const f = fixture(); const request = await f.login();
  const input = { operationId: randomUUID(), name: 'Guarded replay' };
  await f.service.createBranch(request, input);
  await expect(f.service.createBranch({ ...request, csrf: undefined }, input)).rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  await expect(f.service.createBranch({ ...request, origin: 'https://foreign.invalid' }, input)).rejects.toMatchObject({ reason: 'AUTH_CSRF' });
  f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'settings.manage', effect: 'deny' }];
  await expect(f.service.createBranch(request, input)).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'organization.read', effect: 'deny' }];
  await expect(f.service.createBranch(request, input)).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  f.store.users.get(f.actor.id)!.overrides = [];
  const session = [...f.store.sessions.values()].find(row => row.userId === f.actor.id)!;
  session.revokedAt = new Date();
  await expect(f.service.createBranch(request, input)).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  expect(f.store.branches.size).toBe(3); expect(f.store.receipts.size).toBe(1);
  expect(f.store.events.filter(event => event.action === 'organization.branches.create.replay' && event.result === 'success')).toHaveLength(0);
});

test('expected business rejection releases its own unfinished claim and permits a later valid attempt', async () => {
  const f = fixture(); const request = await f.login(); const branchId = randomUUID();
  const input = { operationId: randomUUID(), branchId, name: 'Department after parent exists' };
  await expect(f.service.createDepartment(request, input)).rejects.toMatchObject({ reason: 'ORG_BRANCH_NOT_FOUND' });
  expect(f.store.receipts.size).toBe(0);
  expect(f.store.events.at(-1)).toMatchObject({ result: 'denied', reasonCode: 'ORG_BRANCH_NOT_FOUND' });
  f.store.branches.set(branchId, { id: branchId, name: 'Later fixture parent', version: 1 });
  expect((await f.service.createDepartment(request, input)).department.branchId).toBe(branchId);
  expect(f.store.receipts.size).toBe(1);
  expect(f.store.departments.size).toBe(3);
});

test('receipt completion and audit failures atomically roll back the domain row, audit and claim', async () => {
  const f = fixture(); const request = await f.login(); const initialEvents = f.store.events.length;
  const branchInput = { operationId: randomUUID(), name: 'No partial receipt' };
  f.store.setAuditFailure(true);
  await expect(f.service.createBranch(request, branchInput)).rejects.toThrow();
  expect(f.store.branches.size).toBe(2); expect(f.store.receipts.size).toBe(0); expect(f.store.events).toHaveLength(initialEvents);
  f.store.setAuditFailure(false);
  await f.service.createBranch(request, branchInput);
  const eventsAfterSuccess = f.store.events.length;
  const departmentInput = { operationId: randomUUID(), branchId: f.first.id, name: 'Receipt failure department' };
  f.store.setReceiptFailure(true);
  await expect(f.service.createDepartment(request, departmentInput)).rejects.toThrow();
  expect(f.store.departments.size).toBe(2); expect(f.store.receipts.size).toBe(1); expect(f.store.events).toHaveLength(eventsAfterSuccess);
  f.store.setReceiptFailure(false);
  await f.service.createDepartment(request, departmentInput);
  expect(f.store.departments.size).toBe(3); expect(f.store.receipts.size).toBe(2);
});

test('replay audit failure rolls back its event without changing the original receipt or business result', async () => {
  const f = fixture(); const request = await f.login();
  const input = { operationId: randomUUID(), name: 'Receipt remains committed' };
  const first = await f.service.createBranch(request, input); const eventCount = f.store.events.length;
  f.store.setAuditFailure(true);
  await expect(f.service.createBranch(request, input)).rejects.toThrow();
  expect(f.store.branches.size).toBe(3); expect(f.store.receipts.size).toBe(1); expect(f.store.events).toHaveLength(eventCount);
  f.store.setAuditFailure(false);
  expect(await f.service.createBranch(request, input)).toEqual(first);
});
