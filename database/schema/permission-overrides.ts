import { foreignKey, index, mysqlTable, primaryKey } from 'drizzle-orm/mysql-core';
import { users } from './auth.ts';
import { asciiKey, identifier, utcTimestamp } from './columns.ts';
import { permissions } from './permissions.ts';

export const userPermissionOverrides = mysqlTable('user_permission_overrides', {
  userId: identifier('user_id').notNull(),
  permissionCode: asciiKey('permission_code', { length: 96 }).notNull(),
  effect: asciiKey('effect', { length: 5 }).notNull(),
  updatedAt: utcTimestamp('updated_at').notNull(),
}, table => [
  primaryKey({ name: 'pk_user_permission_overrides', columns: [table.userId, table.permissionCode] }),
  // Support the permission-side foreign key and lookup by permission.
  index('ix_overrides_permission').on(table.permissionCode, table.userId),
  foreignKey({ name: 'fk_overrides_user', columns: [table.userId], foreignColumns: [users.id] })
    .onUpdate('restrict').onDelete('restrict'),
  foreignKey({ name: 'fk_overrides_permission', columns: [table.permissionCode], foreignColumns: [permissions.code] })
    .onUpdate('restrict').onDelete('restrict'),
]);
