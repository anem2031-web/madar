import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { authThrottles, users } from '../../../database/schema/auth.ts';
import { userPermissionOverrides } from '../../../database/schema/permission-overrides.ts';
import { roles } from '../../../database/schema/permissions.ts';
import type { DatabaseConnection, DatabaseTransaction } from '../../core/database/connection.ts';
import { authTransaction, sqlUtc } from '../auth/repository.ts';
import type { PermissionOverridesStore, PermissionOverridesTransaction } from './store.ts';

const fields = { id: users.id, username: users.username, roleCode: roles.code,
  accountStatus: users.accountStatus, authVersion: users.authVersion };

function permissionOverridesTransaction(tx: DatabaseTransaction): PermissionOverridesTransaction {
  return {
    ...authTransaction(tx),
    async listPermissionUsers(cursor, limit) {
      const rows = await tx.select(fields).from(users).innerJoin(roles, eq(roles.id, users.roleId))
        .where(cursor ? gt(users.id, cursor) : undefined).orderBy(asc(users.id)).limit(limit);
      return rows.map(row => {
        if (row.accountStatus !== 'active' && row.accountStatus !== 'disabled') throw new Error('Invalid stored user state.');
        return { ...row, accountStatus: row.accountStatus };
      });
    },
    async clearReauthThrottle(key) {
      await tx.delete(authThrottles).where(eq(authThrottles.counterKey, key));
    },
    async bumpAuthVersion(userId, expectedAuthVersion, now) {
      const [result] = await tx.update(users).set({ authVersion: sql`${users.authVersion} + 1`, updatedAt: sqlUtc(now) })
        .where(and(eq(users.id, userId), eq(users.authVersion, expectedAuthVersion)));
      return result.affectedRows === 1;
    },
    async replaceOverrides(userId, overrides, now) {
      await tx.delete(userPermissionOverrides).where(eq(userPermissionOverrides.userId, userId));
      if (overrides.length) await tx.insert(userPermissionOverrides).values(overrides.map(entry => ({
        userId, permissionCode: entry.permissionCode, effect: entry.effect, updatedAt: sqlUtc(now),
      })));
    },
  };
}

export function createPermissionOverridesStore(connection: DatabaseConnection): PermissionOverridesStore {
  return { transaction: work => connection.transaction(tx => work(permissionOverridesTransaction(tx))) };
}
