import { foreignKey, mysqlTable, primaryKey, uniqueIndex } from 'drizzle-orm/mysql-core';
import { identifier, unicodeText, utcTimestamp, version } from './columns.ts';

export const branches = mysqlTable('branches', {
  id: identifier('id').notNull(),
  name: unicodeText('name', { length: 150 }).notNull(),
  createdAt: utcTimestamp('created_at').notNull(),
  updatedAt: utcTimestamp('updated_at').notNull(),
  version: version('version'),
}, table => [
  primaryKey({ name: 'pk_branches', columns: [table.id] }),
]);

export const departments = mysqlTable('departments', {
  id: identifier('id').notNull(),
  branchId: identifier('branch_id').notNull(),
  name: unicodeText('name', { length: 150 }).notNull(),
  createdAt: utcTimestamp('created_at').notNull(),
  updatedAt: utcTimestamp('updated_at').notNull(),
  version: version('version'),
}, table => [
  primaryKey({ name: 'pk_departments', columns: [table.id] }),
  // Serve branch lookups and provide the parent key for the employee's branch/department pair.
  uniqueIndex('uq_departments_branch_id').on(table.branchId, table.id),
  foreignKey({ name: 'fk_departments_branch', columns: [table.branchId], foreignColumns: [branches.id] })
    .onUpdate('restrict').onDelete('restrict'),
]);
