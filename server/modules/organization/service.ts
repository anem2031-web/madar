import { randomUUID } from 'node:crypto';
import { hasPermission } from '../../core/permissions/guard.ts';
import { executeWriteOperation, WriteOperationConflict } from '../../core/write-operations/service.ts';
import { AuthFault } from '../auth/errors.ts';
import type { AuthRequest, AuthService } from '../auth/service.ts';
import type { AuthAudit, AuthUser } from '../auth/store.ts';
import { OrganizationFault } from './errors.ts';
import type { Branch, Department, OrganizationStore, OrganizationTransaction } from './store.ts';
import { createBranchInput, createDepartmentInput, listBranchesInput, listDepartmentsInput, renameBranchInput, renameDepartmentInput } from './validation.ts';
import { readCreatedBranch, readCreatedDepartment, readRenamedBranch, readRenamedDepartment } from './write-response.ts';

type Options = { now?: () => Date };
type EntityType = 'branch' | 'department';
const maximumVersion = 4_294_967_295;

export function createOrganizationService(store: OrganizationStore, auth: AuthService, options: Options = {}) {
  const clock = options.now ?? (() => new Date());
  function audit(request: AuthRequest, action: string, actor: AuthUser | null, result: 'success' | 'denied',
    entityType: EntityType, entityId: string | null = null, reasonCode: string | null = null, operationId?: string): AuthAudit {
    return { eventId: randomUUID(), occurredAt: clock(), actorUserId: actor?.id ?? null,
      actorRoleId: actor?.roleId ?? null, actorRoleCode: actor?.roleCode ?? null,
      module: 'organization', action, entityId, requestId: request.requestId, result, reasonCode,
      metadata: { entityType, ...(operationId ? { operationId } : {}) } };
  }
  async function guarded<T>(request: AuthRequest, action: string, entityType: EntityType, write: boolean,
    work: (tx: OrganizationTransaction, actor: AuthUser) => Promise<T>, entityId: string | null = null): Promise<T> {
    const outcome = await store.transaction(async tx => {
      let actor: AuthUser | null = null;
      try {
        actor = (await auth.authorizeInTransaction(tx, request, 'organization.read', clock(), current => { actor = current; })).user;
        if (write && !hasPermission(actor, 'settings.manage')) throw new AuthFault('AUTH_FORBIDDEN');
        return { value: await work(tx, actor) };
      } catch (error) {
        // Expected rejections happen before a successful write. Unexpected store/audit failures roll back.
        if (!(error instanceof AuthFault || error instanceof OrganizationFault)) throw error;
        await tx.appendAudit(audit(request, action, actor, 'denied', entityType, entityId, error.reason));
        return { error };
      }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  async function branch(tx: OrganizationTransaction, id: string) {
    const row = await tx.getBranch(id);
    if (!row) throw new OrganizationFault('ORG_BRANCH_NOT_FOUND');
    return row;
  }
  function checkVersion(row: Branch, expectedVersion: number, changed: boolean) {
    if (row.version !== expectedVersion || (changed && row.version >= maximumVersion)) throw new OrganizationFault('ORG_CONFLICT');
  }
  async function writeOperation<T extends { branch: Branch } | { department: Department }>(request: AuthRequest,
    tx: OrganizationTransaction, actor: AuthUser, action: string, entityType: EntityType,
    input: { operationId: string } & Record<string, string | number>, readResponse: (value: unknown) => T,
    execute: () => Promise<T>): Promise<T> {
    const { operationId, ...payload } = input;
    try {
      const result = await executeWriteOperation(tx, { operationId, actorUserId: actor.id, operationCode: action,
        input: payload, now: clock(), readResponse, execute });
      if (result.replayed) {
        const row = 'branch' in result.value ? result.value.branch : result.value.department;
        await tx.appendAudit({ ...audit(request, `${action}.replay`, actor, 'success', entityType, row.id, null, operationId),
          entityVersion: row.version, metadata: { entityType, operationId, replayed: true } });
      }
      return result.value;
    } catch (error) {
      if (error instanceof WriteOperationConflict) throw new OrganizationFault('ORG_OPERATION_CONFLICT');
      throw error;
    }
  }
  async function listBranches(request: AuthRequest, input: { cursor?: string } = {}) {
    const parsed = listBranchesInput(input);
    return guarded(request, 'organization.branches.list', 'branch', false, async (tx, actor) => {
      const rows = await tx.listBranches(parsed.cursor, 26);
      const page = rows.slice(0, 25);
      await tx.appendAudit({ ...audit(request, 'organization.branches.list', actor, 'success', 'branch'), metadata: { entityType: 'branch', count: page.length } });
      return { branches: page, ...(rows.length > 25 ? { nextCursor: page.at(-1)!.id } : {}) };
    });
  }
  async function listDepartments(request: AuthRequest, input: { branchId: string; cursor?: string }) {
    const parsed = listDepartmentsInput(input);
    return guarded(request, 'organization.departments.list', 'branch', false, async (tx, actor) => {
      const parent = await branch(tx, parsed.branchId);
      const rows = await tx.listDepartments(parent.id, parsed.cursor, 26);
      const page = rows.slice(0, 25);
      await tx.appendAudit({ ...audit(request, 'organization.departments.list', actor, 'success', 'branch', parent.id), entityVersion: parent.version, metadata: { entityType: 'branch', count: page.length } });
      return { branch: parent, departments: page, ...(rows.length > 25 ? { nextCursor: page.at(-1)!.id } : {}) };
    }, parsed.branchId);
  }
  async function createBranch(request: AuthRequest, input: ReturnType<typeof createBranchInput>) {
    const parsed = createBranchInput(input);
    await auth.checkMutation(request);
    return guarded(request, 'organization.branches.create', 'branch', true, (tx, actor) => writeOperation(
      request, tx, actor, 'organization.branches.create', 'branch', parsed, readCreatedBranch, async () => {
      const value: Branch = { id: randomUUID(), name: parsed.name, version: 1 };
      await tx.insertBranch(value, clock());
      await tx.appendAudit({ ...audit(request, 'organization.branches.create', actor, 'success', 'branch', value.id, null, parsed.operationId), entityVersion: value.version, afterValues: { name: value.name, version: value.version } });
      return { branch: value };
    }));
  }
  async function renameBranch(request: AuthRequest, input: ReturnType<typeof renameBranchInput>) {
    const parsed = renameBranchInput(input);
    await auth.checkMutation(request);
    return guarded(request, 'organization.branches.rename', 'branch', true, (tx, actor) => writeOperation(
      request, tx, actor, 'organization.branches.rename', 'branch', parsed, readRenamedBranch, async () => {
      const before = await branch(tx, parsed.branchId);
      const changed = before.name !== parsed.name;
      checkVersion(before, parsed.expectedVersion, changed);
      if (changed && !await tx.renameBranch(before.id, before.version, parsed.name, clock())) throw new OrganizationFault('ORG_CONFLICT');
      const after: Branch = { ...before, name: parsed.name, version: before.version + Number(changed) };
      await tx.appendAudit({ ...audit(request, 'organization.branches.rename', actor, 'success', 'branch', before.id, null, parsed.operationId), entityVersion: after.version,
        beforeValues: { name: before.name, version: before.version }, afterValues: { name: after.name, version: after.version }, metadata: { entityType: 'branch', operationId: parsed.operationId, changed } });
      return { changed, branch: after };
    }), parsed.branchId);
  }
  async function createDepartment(request: AuthRequest, input: ReturnType<typeof createDepartmentInput>) {
    const parsed = createDepartmentInput(input);
    await auth.checkMutation(request);
    return guarded(request, 'organization.departments.create', 'branch', true, (tx, actor) => writeOperation(
      request, tx, actor, 'organization.departments.create', 'department', parsed, readCreatedDepartment, async () => {
      const parent = await branch(tx, parsed.branchId);
      const value: Department = { id: randomUUID(), branchId: parent.id, name: parsed.name, version: 1 };
      await tx.insertDepartment(value, clock());
      await tx.appendAudit({ ...audit(request, 'organization.departments.create', actor, 'success', 'department', value.id, null, parsed.operationId), entityVersion: value.version,
        afterValues: { name: value.name, branchId: value.branchId, version: value.version } });
      return { department: value };
    }), parsed.branchId);
  }
  async function renameDepartment(request: AuthRequest, input: ReturnType<typeof renameDepartmentInput>) {
    const parsed = renameDepartmentInput(input);
    await auth.checkMutation(request);
    return guarded(request, 'organization.departments.rename', 'department', true, (tx, actor) => writeOperation(
      request, tx, actor, 'organization.departments.rename', 'department', parsed, readRenamedDepartment, async () => {
      await branch(tx, parsed.branchId);
      const before = await tx.getDepartment(parsed.branchId, parsed.departmentId);
      if (!before) throw new OrganizationFault('ORG_DEPARTMENT_NOT_FOUND');
      const changed = before.name !== parsed.name;
      checkVersion(before, parsed.expectedVersion, changed);
      if (changed && !await tx.renameDepartment(before.branchId, before.id, before.version, parsed.name, clock())) throw new OrganizationFault('ORG_CONFLICT');
      const after: Department = { ...before, name: parsed.name, version: before.version + Number(changed) };
      await tx.appendAudit({ ...audit(request, 'organization.departments.rename', actor, 'success', 'department', before.id, null, parsed.operationId), entityVersion: after.version,
        beforeValues: { name: before.name, branchId: before.branchId, version: before.version }, afterValues: { name: after.name, branchId: after.branchId, version: after.version }, metadata: { entityType: 'department', operationId: parsed.operationId, changed } });
      return { changed, department: after };
    }), parsed.departmentId);
  }
  return { listBranches, listDepartments, createBranch, renameBranch, createDepartment, renameDepartment };
}

export type OrganizationService = ReturnType<typeof createOrganizationService>;
