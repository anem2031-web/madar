import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../../../modules/auth/store.ts';
import { createMemoryNumberingStore } from '../../numbering/tests/memory-store.ts';
import type { AuditStore, StoredAuditEvent, StoredDeliveryStatus } from '../store.ts';

export function memoryAuditEvent(changes: Partial<StoredAuditEvent> = {}): StoredAuditEvent {
  return { eventId: randomUUID(), occurredAt: '2026-11-24 10:00:00.000', actorUserId: randomUUID(), actorRoleId: randomUUID(), actorRoleCode: 'system_admin',
    module: 'organization', action: 'organization.branches.rename', entityId: randomUUID(), entityVersion: 2,
    requestId: randomUUID(), result: 'success', reasonCode: null, beforeValues: { name: 'Before', version: 1 },
    afterValues: { name: 'بعد التعديل', version: 2 }, metadata: { entityType: 'branch', changed: true }, ...changes };
}
// Atomic auth/outbox fixture reused locally; delivered view records are read-only snapshots.
export function createMemoryAuditStore(initialUsers: AuthUser[] = [], initialEvents: StoredAuditEvent[] = []) {
  const base = createMemoryNumberingStore(initialUsers);
  const deliveredEvents = new Map(initialEvents.map(event => [event.eventId, structuredClone(event)]));
  let status: StoredDeliveryStatus = { pending: 0, leased: 0, failed: 0, oldestPendingAt: null, failures: [] };
  let failList = false; let failDetail = false; let failStatus = false;
  const stamp = (value: string) => Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  const store: AuditStore = { transaction: work => base.transaction(tx => work({ ...tx,
    async listEvents(input, limit) {
      if (failList) throw new Error('Synthetic audit listing failure.');
      return [...deliveredEvents.values()].filter(event => stamp(event.occurredAt) >= Date.parse(input.from) && stamp(event.occurredAt) <= Date.parse(input.to)
        && (!input.actorUserId || event.actorUserId === input.actorUserId) && (!input.module || event.module === input.module) && (!input.result || event.result === input.result)
        && (!input.cursor || stamp(event.occurredAt) < Date.parse(input.cursor.occurredAt) || (stamp(event.occurredAt) === Date.parse(input.cursor.occurredAt) && event.eventId < input.cursor.eventId)))
        .sort((left, right) => stamp(right.occurredAt) - stamp(left.occurredAt) || right.eventId.localeCompare(left.eventId)).slice(0, limit)
        .map(({ beforeValues: _before, afterValues: _after, metadata: _metadata, ...event }) => structuredClone(event));
    },
    async getEvent(eventId) { if (failDetail) throw new Error('Synthetic audit details failure.'); const event = deliveredEvents.get(eventId); return event ? structuredClone(event) : null; },
    async deliveryStatus() { if (failStatus) throw new Error('Synthetic audit status failure.'); return structuredClone(status); },
  })) };
  return { ...store, get users() { return base.users; }, get sessions() { return base.sessions; }, get events() { return base.events; },
    deliveredEvents, seedEvents(events: StoredAuditEvent[]) { for (const event of events) deliveredEvents.set(event.eventId, structuredClone(event)); },
    setDeliveryStatus(value: StoredDeliveryStatus) { status = structuredClone(value); },
    setListFailure(value: boolean) { failList = value; }, setDetailFailure(value: boolean) { failDetail = value; }, setStatusFailure(value: boolean) { failStatus = value; },
    setAuditFailure: base.setAuditFailure, setBeforeTransaction: base.setBeforeTransaction };
}
