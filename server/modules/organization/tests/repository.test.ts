import { drizzle } from 'drizzle-orm/mysql2';
import type { Pool } from 'mysql2/promise';
import { expect, test } from 'vitest';
import type { DatabaseConnection } from '../../../core/database/connection.ts';
import { createOrganizationStore } from '../repository.ts';

type Call = { sql: string; params: unknown[] };
const write = { affectedRows: 1, insertId: 0 };
// Recording driver checks SQL contracts and transaction boundaries, not TiDB execution.
function recording(answer: (call: Call) => unknown = () => write) {
  const calls: Call[] = [];
  const client = { async query(query: { sql: string }, params: unknown[] = []) {
    const call = { sql: query.sql, params }; calls.push(call); return [answer(call), []];
  } };
  const db = drizzle({ client: client as unknown as Pool });
  const connection: DatabaseConnection = { db, transaction: db.transaction.bind(db), ping: async () => {}, close: async () => {} };
  return { store: createOrganizationStore(connection), calls };
}

test('branch paging binds a bounded primary-key cursor without offset or an invented name filter', async () => {
  const { store, calls } = recording(({ sql }) => sql.startsWith('select') ? [['branch-id', 'اسم الفرع', 3]] : write);
  expect(await store.transaction(tx => tx.listBranches('cursor-id', 26))).toEqual([{ id: 'branch-id', name: 'اسم الفرع', version: 3 }]);
  const query = calls.find(call => call.sql.startsWith('select'))!;
  expect(query.sql).toContain('`branches`.`id` > ?'); expect(query.sql).toContain('order by `branches`.`id` asc limit ?');
  expect(query.sql).not.toMatch(/offset|like|count\(/i); expect(query.params).toEqual(['cursor-id', 26]);
});

test('department paging and locked reads bind the selected parent as well as department identity', async () => {
  const { store, calls } = recording(({ sql }) => sql.startsWith('select') ? [['department-id', 'branch-id', 'Operations', 4]] : write);
  expect(await store.transaction(tx => tx.listDepartments('branch-id', 'cursor-id', 26))).toEqual([
    { id: 'department-id', branchId: 'branch-id', name: 'Operations', version: 4 },
  ]);
  const list = calls.find(call => call.sql.startsWith('select'))!;
  expect(list.sql).toContain('`departments`.`branch_id` = ?'); expect(list.sql).toContain('`departments`.`id` > ?');
  expect(list.sql).toContain('order by `departments`.`id` asc limit ?'); expect(list.params).toEqual(['branch-id', 'cursor-id', 26]);
  await store.transaction(tx => tx.getDepartment('branch-id', 'department-id'));
  const locked = calls.filter(call => call.sql.startsWith('select')).at(-1)!;
  expect(locked.sql).toContain('`departments`.`branch_id` = ?'); expect(locked.sql).toContain('`departments`.`id` = ?');
  expect(locked.sql).toContain('for update'); expect(locked.params).toEqual(['branch-id', 'department-id', 1]);
});

test('rename compare-and-swap updates only name/version/time and cannot move a department', async () => {
  const { store, calls } = recording(); const now = new Date('2026-11-23T14:00:00Z');
  expect(await store.transaction(tx => tx.renameBranch('branch-id', 3, 'الاسم الجديد', now))).toBe(true);
  expect(await store.transaction(tx => tx.renameDepartment('branch-id', 'department-id', 4, 'New department', now))).toBe(true);
  const updates = calls.filter(call => call.sql.startsWith('update'));
  expect(updates[0].sql).toContain('`branches`.`version` = ?'); expect(updates[0].params).toEqual(['الاسم الجديد', '2026-11-23 14:00:00.000', 'branch-id', 3]);
  const setPart = updates[1].sql.split(' where ')[0];
  expect(setPart).not.toContain('branch_id'); expect(setPart).not.toMatch(/created_at|auth_version|role_id|password/);
  expect(updates[1].sql).toContain('`departments`.`branch_id` = ?'); expect(updates[1].sql).toContain('`departments`.`version` = ?');
  expect(updates[1].params).toEqual(['New department', '2026-11-23 14:00:00.000', 'branch-id', 'department-id', 4]);
  const lost = recording(({ sql }) => sql.startsWith('update') ? { affectedRows: 0, insertId: 0 } : write);
  expect(await lost.store.transaction(tx => tx.renameBranch('branch-id', 3, 'Stale writer', now))).toBe(false);
});

test('inserts bind Unicode values and server timestamps without name uniqueness probes', async () => {
  const { store, calls } = recording(); const now = new Date('2026-11-23T14:00:00Z');
  await store.transaction(async tx => {
    await tx.insertBranch({ id: 'branch-id', name: 'فرع عربي', version: 1 }, now);
    await tx.insertDepartment({ id: 'department-id', branchId: 'branch-id', name: 'القسم', version: 1 }, now);
  });
  const inserts = calls.filter(call => call.sql.startsWith('insert'));
  expect(inserts[0].params).toEqual(['branch-id', 'فرع عربي', '2026-11-23 14:00:00.000', '2026-11-23 14:00:00.000', 1]);
  expect(inserts[1].params).toEqual(['department-id', 'branch-id', 'القسم', '2026-11-23 14:00:00.000', '2026-11-23 14:00:00.000', 1]);
  expect(inserts[0].sql).not.toContain('فرع عربي'); expect(calls.some(call => call.sql.startsWith('select'))).toBe(false);
});

test('outbox failure rolls back organizational writes and entity version is bound to the same event', async () => {
  const { store, calls } = recording(({ sql }) => { if (sql.startsWith('insert into `audit_outbox`')) throw new Error('Synthetic outbox failure'); return write; });
  const now = new Date('2026-11-23T14:00:00Z');
  await expect(store.transaction(async tx => {
    await tx.renameBranch('branch-id', 1, 'Renamed', now);
    await tx.appendAudit({ eventId: 'event-id', occurredAt: now, actorUserId: 'actor-id', actorRoleId: 'role-id', actorRoleCode: 'system_admin',
      module: 'organization', action: 'organization.branches.rename', entityId: 'branch-id', entityVersion: 2, requestId: 'request-id', result: 'success', reasonCode: null,
      beforeValues: { name: 'Original', version: 1 }, afterValues: { name: 'Renamed', version: 2 }, metadata: { entityType: 'branch', changed: true } });
  })).rejects.toThrow();
  const insertion = calls.find(call => call.sql.startsWith('insert into `audit_outbox`'))!;
  expect(insertion.sql).toContain('`entity_version`'); expect(insertion.params).toContain(2);
  expect(calls.at(-1)?.sql).toBe('rollback'); expect(calls.some(call => call.sql === 'commit')).toBe(false);
});
