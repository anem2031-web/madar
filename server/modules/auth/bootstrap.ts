import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { auditOutbox } from '../../../database/schema/audit.ts';
import { users } from '../../../database/schema/auth.ts';
import { permissions, rolePermissions, roles } from '../../../database/schema/permissions.ts';
import { initialRolePermissions, permissionCodes } from '../../../shared/permissions/catalog.ts';
import type { DatabaseConnection } from '../../core/database/connection.ts';
import { sqlUtc } from './repository.ts';

/** Explicit one-time setup, never called by server startup or a public request. */
export async function bootstrapAdmin(connection: DatabaseConnection, passwordHash: string) {
  if (!passwordHash.startsWith('scrypt$')) throw new Error('Invalid administrator setup.');
  return connection.transaction(async tx => {
    async function hasExistingAdmin() {
      const existingUsers = await tx.select({ usernameNormalized: users.usernameNormalized }).from(users).limit(1).for('update');
      if (!existingUsers.length) return false;
      const [admin] = await tx.select({ id: users.id }).from(users).where(eq(users.usernameNormalized, 'admin')).limit(1).for('update');
      if (admin) return true;
      // Abort/rollback instead of taking over an installation containing another account.
      throw new Error('Administrator setup already initialized.');
    }
    // A rerun must not recreate even an unused role on an existing installation.
    if (await hasExistingAdmin()) return { status: 'already_initialized' as const };
    const now = sqlUtc(new Date());
    const candidateRoleId = randomUUID();
    // This unique persisted row serializes concurrent runs, including on an empty database.
    await tx.insert(roles).values({ id: candidateRoleId, code: 'system_admin', name: 'مدير النظام',
      createdAt: now, updatedAt: now }).onDuplicateKeyUpdate({ set: { id: sql`${roles.id}` } });
    const [adminRole] = await tx.select().from(roles).where(eq(roles.code, 'system_admin')).limit(1).for('update');
    if (!adminRole) throw new Error('Administrator setup unavailable.');

    // Recheck after the persisted unique-role lock; a concurrent setup may have completed.
    if (await hasExistingAdmin()) return { status: 'already_initialized' as const };

    for (const code of permissionCodes) {
      await tx.insert(permissions).values({ code }).onDuplicateKeyUpdate({ set: { code: sql`${permissions.code}` } });
    }
    for (const code of initialRolePermissions.system_admin) {
      await tx.insert(rolePermissions).values({ roleId: adminRole.id, permissionCode: code })
        .onDuplicateKeyUpdate({ set: { roleId: sql`${rolePermissions.roleId}` } });
    }
    await tx.insert(roles).values({ id: randomUUID(), code: 'hr', name: 'الموارد البشرية', createdAt: now, updatedAt: now })
      .onDuplicateKeyUpdate({ set: { id: sql`${roles.id}` } });
    const [hrRole] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.code, 'hr')).limit(1).for('update');
    if (!hrRole) throw new Error('Administrator setup unavailable.');
    for (const code of initialRolePermissions.hr) {
      await tx.insert(rolePermissions).values({ roleId: hrRole.id, permissionCode: code })
        .onDuplicateKeyUpdate({ set: { roleId: sql`${rolePermissions.roleId}` } });
    }
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, username: 'ADMIN', passwordHash, roleId: adminRole.id,
      accountStatus: 'active', mustChangePassword: true, createdAt: now, updatedAt: now });
    await tx.insert(auditOutbox).values({ eventId: randomUUID(), occurredAt: now,
      actorUserId: null, actorRoleId: null, actorRoleCode: null, module: 'auth', action: 'auth.bootstrap_admin',
      entityId: userId, requestId: randomUUID(), result: 'success', nextAttemptAt: now,
      deliveryState: 'pending', attemptCount: 0 });
    return { status: 'created' as const };
  });
}
