import { and, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { auditEvents, auditOutbox } from '../../../database/schema/audit.ts';
import type { DatabaseConnection, DatabaseTransaction } from '../database/connection.ts';
import { authTransaction } from '../../modules/auth/repository.ts';
import type { AuditStore, AuditTransaction } from './store.ts';
import { AuditFault } from './errors.ts';

const fields = { eventId: auditEvents.eventId, occurredAt: auditEvents.occurredAt, actorUserId: auditEvents.actorUserId,
  actorRoleId: auditEvents.actorRoleId, actorRoleCode: auditEvents.actorRoleCode, module: auditEvents.module,
  action: auditEvents.action, entityId: auditEvents.entityId, entityVersion: auditEvents.entityVersion,
  requestId: auditEvents.requestId, result: auditEvents.result, reasonCode: auditEvents.reasonCode };
const utc = (iso: string) => iso.slice(0, 23).replace('T', ' ');
function count(value: unknown) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new AuditFault('AUDIT_UNAVAILABLE'); return number; }
function auditTransaction(tx: DatabaseTransaction): AuditTransaction {
  return { ...authTransaction(tx),
    async listEvents(input, limit) {
      const conditions = [gte(auditEvents.occurredAt, utc(input.from)), lte(auditEvents.occurredAt, utc(input.to))];
      if (input.actorUserId) conditions.push(eq(auditEvents.actorUserId, input.actorUserId));
      if (input.module) conditions.push(eq(auditEvents.module, input.module));
      if (input.result) conditions.push(eq(auditEvents.result, input.result));
      if (input.cursor) conditions.push(or(lt(auditEvents.occurredAt, utc(input.cursor.occurredAt)),
        and(eq(auditEvents.occurredAt, utc(input.cursor.occurredAt)), lt(auditEvents.eventId, input.cursor.eventId)))!);
      return tx.select(fields).from(auditEvents).where(and(...conditions))
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.eventId)).limit(limit);
    },
    async getEvent(eventId) {
      const [event] = await tx.select({ ...fields, beforeValues: auditEvents.beforeValues, afterValues: auditEvents.afterValues, metadata: auditEvents.metadata })
        .from(auditEvents).where(eq(auditEvents.eventId, eventId)).limit(1);
      return event ?? null;
    },
    async deliveryStatus() {
      const counts = await tx.select({ state: auditOutbox.deliveryState, count: sql<number>`count(*)` }).from(auditOutbox)
        .where(inArray(auditOutbox.deliveryState, ['pending', 'leased', 'failed'])).groupBy(auditOutbox.deliveryState);
      const [oldest] = await tx.select({ occurredAt: sql<string>`min(${auditOutbox.occurredAt})` }).from(auditOutbox).where(eq(auditOutbox.deliveryState, 'pending'));
      const failures = await tx.select({ eventId: auditOutbox.eventId, occurredAt: auditOutbox.occurredAt, errorCode: auditOutbox.lastErrorCode })
        .from(auditOutbox).where(eq(auditOutbox.deliveryState, 'failed')).orderBy(desc(auditOutbox.nextAttemptAt), desc(auditOutbox.eventId)).limit(10);
      return { pending: count(counts.find(row => row.state === 'pending')?.count ?? 0),
        leased: count(counts.find(row => row.state === 'leased')?.count ?? 0), failed: count(counts.find(row => row.state === 'failed')?.count ?? 0),
        oldestPendingAt: oldest?.occurredAt ?? null, failures };
    },
  };
}
export function createAuditStore(connection: DatabaseConnection): AuditStore { return { transaction: work => connection.transaction(tx => work(auditTransaction(tx))) }; }
