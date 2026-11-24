import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { auditEvents, auditOutbox } from '../../../database/schema/audit.ts';
import type { DatabaseConnection, DatabaseTransaction } from '../database/connection.ts';
import type { AuditDeliveryStore, AuditDeliveryTransaction } from './delivery-store.ts';

const databaseNow = sql<string>`utc_timestamp(3)`;
const afterMilliseconds = (milliseconds: number) => sql<string>`timestampadd(microsecond, ${milliseconds * 1000}, utc_timestamp(3))`;
const ownedLiveClaim = (eventId: string, token: string) => and(eq(auditOutbox.eventId, eventId), eq(auditOutbox.deliveryState, 'leased'),
  eq(auditOutbox.leaseToken, token), sql`${auditOutbox.leaseExpiresAt} > utc_timestamp(3)`);
const eventFields = { eventId: auditOutbox.eventId, occurredAt: auditOutbox.occurredAt, actorUserId: auditOutbox.actorUserId,
  actorRoleId: auditOutbox.actorRoleId, actorRoleCode: auditOutbox.actorRoleCode, module: auditOutbox.module, action: auditOutbox.action,
  entityId: auditOutbox.entityId, entityVersion: auditOutbox.entityVersion, requestId: auditOutbox.requestId, result: auditOutbox.result,
  reasonCode: auditOutbox.reasonCode, beforeValues: auditOutbox.beforeValues, afterValues: auditOutbox.afterValues, metadata: auditOutbox.metadata };

function deliveryTransaction(tx: DatabaseTransaction): AuditDeliveryTransaction {
  return {
    async getOutbox(eventId) {
      const [row] = await tx.select({ ...eventFields, deliveryState: auditOutbox.deliveryState, attemptCount: auditOutbox.attemptCount,
        leaseToken: auditOutbox.leaseToken, leaseExpiresAt: auditOutbox.leaseExpiresAt }).from(auditOutbox)
        .where(eq(auditOutbox.eventId, eventId)).limit(1).for('update');
      if (!row) return null;
      const { deliveryState, attemptCount, leaseToken, leaseExpiresAt, ...event } = row;
      return { eventId: row.eventId, event, deliveryState, attemptCount, leaseToken, leaseExpiresAt };
    },
    async now() {
      const [rows] = await tx.execute(sql`select cast(utc_timestamp(3) as char) as audit_clock`);
      const value = (rows as unknown as { audit_clock: unknown }[])[0]?.audit_clock;
      if (typeof value !== 'string') throw new Error('AUDIT_DELIVERY_FAILED');
      return value;
    },
    async getEvent(eventId) {
      const [event] = await tx.select().from(auditEvents).where(eq(auditEvents.eventId, eventId)).limit(1).for('update');
      return event ?? null;
    },
    async insertEvent(event) { await tx.insert(auditEvents).values(event); },
    async acknowledge(eventId, token) {
      const [result] = await tx.update(auditOutbox).set({ deliveryState: 'delivered', deliveredAt: databaseNow,
        leaseToken: null, leaseExpiresAt: null, lastErrorCode: null }).where(ownedLiveClaim(eventId, token));
      return result.affectedRows === 1;
    },
    async fail(eventId, token, errorCode, retryDelayMs) {
      const [result] = await tx.update(auditOutbox).set({ deliveryState: retryDelayMs === null ? 'failed' : 'pending',
        ...(retryDelayMs === null ? {} : { nextAttemptAt: afterMilliseconds(retryDelayMs) }),
        leaseToken: null, leaseExpiresAt: null, lastErrorCode: errorCode }).where(ownedLiveClaim(eventId, token));
      return result.affectedRows === 1;
    },
  };
}
export function createAuditDeliveryStore(connection: DatabaseConnection): AuditDeliveryStore {
  return {
    async listDue(limit) {
      const rows = await connection.db.select({ eventId: auditOutbox.eventId }).from(auditOutbox)
        .where(and(eq(auditOutbox.deliveryState, 'pending'), lte(auditOutbox.nextAttemptAt, databaseNow)))
        .orderBy(asc(auditOutbox.nextAttemptAt), asc(auditOutbox.eventId)).limit(limit);
      return rows.map(row => row.eventId);
    },
    async listExpired(limit) {
      return connection.db.select({ eventId: auditOutbox.eventId, leaseToken: auditOutbox.leaseToken, leaseExpiresAt: auditOutbox.leaseExpiresAt }).from(auditOutbox)
        .where(and(eq(auditOutbox.deliveryState, 'leased'), lte(auditOutbox.leaseExpiresAt, databaseNow)))
        .orderBy(asc(auditOutbox.leaseExpiresAt), asc(auditOutbox.eventId)).limit(limit);
    },
    async recoverExpired(claim) {
      const [result] = await connection.db.update(auditOutbox).set({ deliveryState: 'pending', nextAttemptAt: databaseNow,
        leaseToken: null, leaseExpiresAt: null, lastErrorCode: 'AUDIT_LEASE_EXPIRED' })
        .where(and(eq(auditOutbox.eventId, claim.eventId), eq(auditOutbox.deliveryState, 'leased'),
          claim.leaseToken === null ? isNull(auditOutbox.leaseToken) : eq(auditOutbox.leaseToken, claim.leaseToken),
          claim.leaseExpiresAt === null ? isNull(auditOutbox.leaseExpiresAt) : eq(auditOutbox.leaseExpiresAt, claim.leaseExpiresAt),
          lte(auditOutbox.leaseExpiresAt, databaseNow)));
      return result.affectedRows === 1;
    },
    async claim(eventId, token, leaseMs) {
      const [result] = await connection.db.update(auditOutbox).set({ deliveryState: 'leased', leaseToken: token,
        leaseExpiresAt: afterMilliseconds(leaseMs), attemptCount: sql`least(${auditOutbox.attemptCount} + 1, 4294967295)` })
        .where(and(eq(auditOutbox.eventId, eventId), eq(auditOutbox.deliveryState, 'pending'), lte(auditOutbox.nextAttemptAt, databaseNow)));
      return result.affectedRows === 1;
    },
    transaction: work => connection.transaction(tx => work(deliveryTransaction(tx))),
  };
}
