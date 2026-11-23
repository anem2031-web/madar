import { boolean, foreignKey, index, int, mysqlTable, primaryKey, uniqueIndex } from 'drizzle-orm/mysql-core';
import { asciiKey, identifier, normalizedKey, sha256, unicodeText, utcTimestamp, version } from './columns.ts';
import { roles } from './permissions.ts';

export const users = mysqlTable('users', {
  id: identifier('id').notNull(),
  username: unicodeText('username', { length: 64 }).notNull(),
  usernameNormalized: normalizedKey('username_normalized', 'username').notNull(),
  passwordHash: asciiKey('password_hash', { length: 512 }).notNull(),
  roleId: identifier('role_id').notNull(),
  accountStatus: asciiKey('account_status', { length: 8 }).notNull(),
  mustChangePassword: boolean('must_change_password').notNull(),
  authVersion: version('auth_version'),
  createdAt: utcTimestamp('created_at').notNull(),
  updatedAt: utcTimestamp('updated_at').notNull(),
}, table => [
  primaryKey({ name: 'pk_users', columns: [table.id] }),
  // Resolve login by its normalized key and list the users assigned to a role.
  uniqueIndex('uq_users_username_normalized').on(table.usernameNormalized),
  index('ix_users_role').on(table.roleId, table.id),
  foreignKey({ name: 'fk_users_role', columns: [table.roleId], foreignColumns: [roles.id] })
    .onUpdate('restrict').onDelete('restrict'),
]);

export const sessions = mysqlTable('sessions', {
  id: identifier('id').notNull(),
  tokenHash: sha256('token_hash').notNull(),
  userId: identifier('user_id'),
  stage: asciiKey('stage', { length: 16 }).notNull(),
  authVersion: int('auth_version', { unsigned: true }),
  authenticatedAt: utcTimestamp('authenticated_at'),
  absoluteExpiresAt: utcTimestamp('absolute_expires_at'),
  createdAt: utcTimestamp('created_at').notNull(),
  lastActivityAt: utcTimestamp('last_activity_at').notNull(),
  expiresAt: utcTimestamp('expires_at').notNull(),
  revokedAt: utcTimestamp('revoked_at'),
  version: version('version'),
}, table => [
  primaryKey({ name: 'pk_sessions', columns: [table.id] }),
  // Resolve a session by its token hash.
  uniqueIndex('uq_sessions_token_hash').on(table.tokenHash),
  // List sessions for one user and scan expired sessions across users in small batches.
  index('ix_sessions_user_expiry').on(table.userId, table.expiresAt),
  index('ix_sessions_expiry').on(table.expiresAt, table.id),
  foreignKey({ name: 'fk_sessions_user', columns: [table.userId], foreignColumns: [users.id] })
    .onUpdate('restrict').onDelete('restrict'),
]);

export const authThrottles = mysqlTable('auth_throttles', {
  counterKey: sha256('counter_key').notNull(),
  windowStartedAt: utcTimestamp('window_started_at').notNull(),
  expiresAt: utcTimestamp('expires_at').notNull(),
  updatedAt: utcTimestamp('updated_at').notNull(),
  attempts: int('attempts', { unsigned: true }).notNull().default(0),
  blockedUntil: utcTimestamp('blocked_until'),
}, table => [
  primaryKey({ name: 'pk_auth_throttles', columns: [table.counterKey] }),
  // Find expiry candidates in stable order.
  index('ix_auth_throttles_expiry').on(table.expiresAt, table.counterKey),
]);
