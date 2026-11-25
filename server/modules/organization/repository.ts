import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { branches, departments } from '../../../database/schema/organization.ts';
import type { DatabaseConnection, DatabaseTransaction } from '../../core/database/connection.ts';
import { authTransaction, sqlUtc } from '../auth/repository.ts';
import { writeOperationsTransaction } from '../../core/write-operations/repository.ts';
import type { OrganizationStore, OrganizationTransaction } from './store.ts';

const branchFields = { id: branches.id, name: branches.name, version: branches.version };
const departmentFields = { id: departments.id, branchId: departments.branchId, name: departments.name, version: departments.version };

function organizationTransaction(tx: DatabaseTransaction): OrganizationTransaction {
  return {
    ...authTransaction(tx),
    ...writeOperationsTransaction(tx),
    async listBranches(cursor, limit) {
      return tx.select(branchFields).from(branches).where(cursor ? gt(branches.id, cursor) : undefined).orderBy(asc(branches.id)).limit(limit);
    },
    async listDepartments(branchId, cursor, limit) {
      return tx.select(departmentFields).from(departments)
        .where(and(eq(departments.branchId, branchId), cursor ? gt(departments.id, cursor) : undefined))
        .orderBy(asc(departments.id)).limit(limit);
    },
    async getBranch(branchId) {
      const [branch] = await tx.select(branchFields).from(branches).where(eq(branches.id, branchId)).limit(1).for('update');
      return branch ?? null;
    },
    async getDepartment(branchId, departmentId) {
      const [department] = await tx.select(departmentFields).from(departments)
        .where(and(eq(departments.branchId, branchId), eq(departments.id, departmentId))).limit(1).for('update');
      return department ?? null;
    },
    async insertBranch(branch, now) {
      await tx.insert(branches).values({ ...branch, createdAt: sqlUtc(now), updatedAt: sqlUtc(now) });
    },
    async renameBranch(branchId, expectedVersion, name, now) {
      const [result] = await tx.update(branches).set({ name, version: sql`${branches.version} + 1`, updatedAt: sqlUtc(now) })
        .where(and(eq(branches.id, branchId), eq(branches.version, expectedVersion)));
      return result.affectedRows === 1;
    },
    async insertDepartment(department, now) {
      await tx.insert(departments).values({ ...department, createdAt: sqlUtc(now), updatedAt: sqlUtc(now) });
    },
    async renameDepartment(branchId, departmentId, expectedVersion, name, now) {
      const [result] = await tx.update(departments).set({ name, version: sql`${departments.version} + 1`, updatedAt: sqlUtc(now) })
        .where(and(eq(departments.branchId, branchId), eq(departments.id, departmentId), eq(departments.version, expectedVersion)));
      return result.affectedRows === 1;
    },
  };
}

export function createOrganizationStore(connection: DatabaseConnection): OrganizationStore {
  return { transaction: work => connection.transaction(tx => work(organizationTransaction(tx))) };
}
