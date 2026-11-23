import { foreignKey, index, mysqlTable, primaryKey, uniqueIndex } from 'drizzle-orm/mysql-core';
import { asciiKey, identifier, unicodeText, utcTimestamp, version } from './columns.ts';

export const roles = mysqlTable('roles', {
  id: identifier('id').notNull(),
  code: asciiKey('code', { length: 64 }).notNull(),
  name: unicodeText('name', { length: 150 }).notNull(),
  version: version('version'),
  createdAt: utcTimestamp('created_at').notNull(),
  updatedAt: utcTimestamp('updated_at').notNull(),
}, table => [
  primaryKey({ name: 'pk_roles', columns: [table.id] }),
  // Resolve one role by its stable code.
  uniqueIndex('uq_roles_code').on(table.code),
]);

export const permissions = mysqlTable('permissions', {
  code: asciiKey('code', { length: 96 }).notNull(),
}, table => [primaryKey({ name: 'pk_permissions', columns: [table.code] })]);

export const rolePermissions = mysqlTable('role_permissions', {
  roleId: identifier('role_id').notNull(),
  permissionCode: asciiKey('permission_code', { length: 96 }).notNull(),
}, table => [
  primaryKey({ name: 'pk_role_permissions', columns: [table.roleId, table.permissionCode] }),
  // Support the permission-side foreign key and reverse lookup.
  index('ix_role_permissions_permission').on(table.permissionCode, table.roleId),
  foreignKey({ name: 'fk_role_permissions_role', columns: [table.roleId], foreignColumns: [roles.id] })
    .onUpdate('restrict').onDelete('restrict'),
  foreignKey({ name: 'fk_role_permissions_permission', columns: [table.permissionCode], foreignColumns: [permissions.code] })
    .onUpdate('restrict').onDelete('restrict'),
]);
