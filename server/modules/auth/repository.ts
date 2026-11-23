import { and, eq, isNull, sql } from 'drizzle-orm';
import { auditOutbox } from '../../../database/schema/audit.ts';
import { authThrottles, sessions, users } from '../../../database/schema/auth.ts';
import { rolePermissions, roles } from '../../../database/schema/permissions.ts';
import { userPermissionOverrides } from '../../../database/schema/permission-overrides.ts';
import type { DatabaseConnection, DatabaseTransaction } from '../../core/database/connection.ts';
import type { AuthSession, AuthStore, AuthTransaction, AuthUser } from './store.ts';

export const sqlUtc = (date: Date) => date.toISOString().slice(0, 23).replace('T', ' ');
const readUtc = (value: string) => new Date(value.replace(' ', 'T') + 'Z');
const nullableDate = (value: string | null) => value === null ? null : readUtc(value);

function readSession(row: typeof sessions.$inferSelect): AuthSession {
  if (!['preauth', 'password_change', 'authenticated'].includes(row.stage)) {
    throw new Error('Invalid stored authentication state.');
  }
  return {
    ...row,
    stage: row.stage as AuthSession['stage'],
    tokenHash: Buffer.from(row.tokenHash),
    authenticatedAt: nullableDate(row.authenticatedAt),
    absoluteExpiresAt: nullableDate(row.absoluteExpiresAt),
    createdAt: readUtc(row.createdAt),
    lastActivityAt: readUtc(row.lastActivityAt),
    expiresAt: readUtc(row.expiresAt),
    revokedAt: nullableDate(row.revokedAt),
  };
}

export function authTransaction(tx: DatabaseTransaction): AuthTransaction {
  async function readUser(row: typeof users.$inferSelect | undefined): Promise<AuthUser | null> {
    if (!row) return null;
    const [role] = await tx.select().from(roles).where(eq(roles.id, row.roleId)).limit(1).for('update');
    if (!role) return null;
    const grants = await tx.select({ permissionCode: rolePermissions.permissionCode })
      .from(rolePermissions).where(eq(rolePermissions.roleId, row.roleId)).for('update');
    const overrides = await tx.select({ permissionCode: userPermissionOverrides.permissionCode, effect: userPermissionOverrides.effect })
      .from(userPermissionOverrides).where(eq(userPermissionOverrides.userId, row.id)).for('update');
    return { ...row, roleCode: role.code, rolePermissions: grants.map(g => g.permissionCode), overrides };
  }

  return {
    async findUserByUsername(normalizedUsername) {
      const [row] = await tx.select().from(users).where(eq(users.usernameNormalized, normalizedUsername)).limit(1).for('update');
      return readUser(row);
    },
    async getUser(userId) {
      const [row] = await tx.select().from(users).where(eq(users.id, userId)).limit(1).for('update');
      return readUser(row);
    },
    async getSession(tokenHash) {
      const [row] = await tx.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1).for('update');
      return row ? readSession(row) : null;
    },
    async insertSession(session) {
      await tx.insert(sessions).values({
        ...session,
        authenticatedAt: session.authenticatedAt ? sqlUtc(session.authenticatedAt) : null,
        absoluteExpiresAt: session.absoluteExpiresAt ? sqlUtc(session.absoluteExpiresAt) : null,
        createdAt: sqlUtc(session.createdAt), lastActivityAt: sqlUtc(session.lastActivityAt),
        expiresAt: sqlUtc(session.expiresAt), revokedAt: session.revokedAt ? sqlUtc(session.revokedAt) : null,
      });
    },
    async revokeSession(sessionId, now) {
      await tx.update(sessions).set({ revokedAt: sqlUtc(now), version: sql`${sessions.version} + 1` })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
    },
    async revokeUserSessions(userId, now) {
      await tx.update(sessions).set({ revokedAt: sqlUtc(now), version: sql`${sessions.version} + 1` })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    },
    async updatePassword(userId, expectedAuthVersion, passwordHash, now) {
      const [result] = await tx.update(users).set({ passwordHash, mustChangePassword: false,
        authVersion: sql`${users.authVersion} + 1`, updatedAt: sqlUtc(now) })
        .where(and(eq(users.id, userId), eq(users.authVersion, expectedAuthVersion), eq(users.accountStatus, 'active')));
      return result.affectedRows === 1;
    },
    async touchSession(sessionId, expectedVersion, now, expiresAt) {
      const [result] = await tx.update(sessions).set({ lastActivityAt: sqlUtc(now), expiresAt: sqlUtc(expiresAt),
        version: sql`${sessions.version} + 1` })
        .where(and(eq(sessions.id, sessionId), eq(sessions.version, expectedVersion), isNull(sessions.revokedAt)));
      return result.affectedRows === 1;
    },
    async consumeThrottle(keys, now, limit, windowMs) {
      let allowed = true;
      const ordered = [...new Map(keys.map(key => [key.toString('hex'), key])).values()].sort(Buffer.compare);
      for (const key of ordered) {
        // Materialize the unique key first; no reliance on a lock covering a missing row.
        await tx.insert(authThrottles).values({ counterKey: key, windowStartedAt: sqlUtc(now),
          expiresAt: sqlUtc(new Date(now.getTime() + windowMs)), updatedAt: sqlUtc(now), attempts: 0 })
          .onDuplicateKeyUpdate({ set: { counterKey: sql`${authThrottles.counterKey}` } });
        const [row] = await tx.select().from(authThrottles).where(eq(authThrottles.counterKey, key)).limit(1).for('update');
        if (!row) throw new Error('Authentication counter unavailable.');
        // Apply a shorter policy to existing windows without extending an earlier expiry.
        const effectiveExpiry = new Date(Math.min(readUtc(row.expiresAt).getTime(), readUtc(row.windowStartedAt).getTime() + windowMs));
        const reset = now.getTime() >= effectiveExpiry.getTime();
        const attempts = reset ? 1 : Math.min(row.attempts + 1, 4_294_967_295);
        const expires = reset ? new Date(now.getTime() + windowMs) : effectiveExpiry;
        const blocked = attempts > limit;
        await tx.update(authThrottles).set({ attempts, updatedAt: sqlUtc(now),
          windowStartedAt: reset ? sqlUtc(now) : row.windowStartedAt,
          expiresAt: sqlUtc(expires), blockedUntil: blocked ? sqlUtc(expires) : null,
        }).where(eq(authThrottles.counterKey, key));
        if (blocked) allowed = false;
      }
      return allowed;
    },
    async appendAudit(event) {
      await tx.insert(auditOutbox).values({ ...event, occurredAt: sqlUtc(event.occurredAt),
        nextAttemptAt: sqlUtc(event.occurredAt), deliveryState: 'pending', attemptCount: 0 });
    },
  };
}

export function createAuthStore(connection: DatabaseConnection): AuthStore {
  return { transaction: work => connection.transaction(tx => work(authTransaction(tx))) };
}
