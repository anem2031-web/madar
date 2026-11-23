import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { authThrottles, users } from '../../../database/schema/auth.ts';
import { roles } from '../../../database/schema/permissions.ts';
import type { DatabaseConnection, DatabaseTransaction } from '../../core/database/connection.ts';
import { authTransaction, sqlUtc } from '../auth/repository.ts';
import type { ManagedUser, UsersStore, UsersTransaction } from './store.ts';

const fields = { id: users.id, username: users.username, roleId: users.roleId, roleCode: roles.code,
  accountStatus: users.accountStatus, mustChangePassword: users.mustChangePassword, authVersion: users.authVersion };

function managed(row: Omit<ManagedUser, 'accountStatus'> & { accountStatus: string }): ManagedUser {
  if (row.accountStatus !== 'active' && row.accountStatus !== 'disabled') throw new Error('Invalid stored user state.');
  return { id: row.id, username: row.username, roleId: row.roleId, roleCode: row.roleCode,
    accountStatus: row.accountStatus, mustChangePassword: row.mustChangePassword, authVersion: row.authVersion };
}

function usersTransaction(tx: DatabaseTransaction): UsersTransaction {
  return {
    ...authTransaction(tx),
    async clearReauthThrottle(key) {
      await tx.delete(authThrottles).where(eq(authThrottles.counterKey, key));
    },
    async listUsers(cursor, limit) {
      const rows = await tx.select(fields).from(users).innerJoin(roles, eq(roles.id, users.roleId))
        .where(cursor ? gt(users.id, cursor) : undefined).orderBy(asc(users.id)).limit(limit);
      return rows.map(managed);
    },
    async listRoles() {
      return tx.select({ id: roles.id, code: roles.code, name: roles.name }).from(roles).orderBy(asc(roles.code)).limit(100);
    },
    async getManagedUser(userId) {
      const [row] = await tx.select(fields).from(users).innerJoin(roles, eq(roles.id, users.roleId))
        .where(eq(users.id, userId)).limit(1).for('update');
      return row ? managed(row) : null;
    },
    async getRole(roleId) {
      const [role] = await tx.select({ id: roles.id, code: roles.code, name: roles.name }).from(roles)
        .where(eq(roles.id, roleId)).limit(1).for('update');
      return role ?? null;
    },
    async insertUser(input) {
      await tx.insert(users).values({ id: input.id, username: input.username, roleId: input.roleId,
        passwordHash: input.passwordHash, accountStatus: 'active', mustChangePassword: true,
        authVersion: 1, createdAt: sqlUtc(input.now), updatedAt: sqlUtc(input.now) });
    },
    async assignRole(userId, expectedAuthVersion, roleId, now) {
      const [result] = await tx.update(users).set({ roleId, authVersion: sql`${users.authVersion} + 1`, updatedAt: sqlUtc(now) })
        .where(and(eq(users.id, userId), eq(users.authVersion, expectedAuthVersion)));
      return result.affectedRows === 1;
    },
    async disableUser(userId, expectedAuthVersion, now) {
      const [result] = await tx.update(users).set({ accountStatus: 'disabled', authVersion: sql`${users.authVersion} + 1`, updatedAt: sqlUtc(now) })
        .where(and(eq(users.id, userId), eq(users.authVersion, expectedAuthVersion), eq(users.accountStatus, 'active')));
      return result.affectedRows === 1;
    },
    async resetPassword(userId, expectedAuthVersion, passwordHash, now) {
      const [result] = await tx.update(users).set({ passwordHash, mustChangePassword: true,
        authVersion: sql`${users.authVersion} + 1`, updatedAt: sqlUtc(now) })
        .where(and(eq(users.id, userId), eq(users.authVersion, expectedAuthVersion)));
      return result.affectedRows === 1;
    },
  };
}

export function createUsersStore(connection: DatabaseConnection): UsersStore {
  return { transaction: work => connection.transaction(tx => work(usersTransaction(tx))) };
}
