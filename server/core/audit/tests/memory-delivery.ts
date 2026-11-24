import type { AuditDeliveryClaim, AuditDeliveryRecord, AuditDeliveryStore } from '../delivery-store.ts';
import type { NormalizedAuditEvent } from '../event.ts';

type Row = AuditDeliveryRecord & { nextAttemptAt: number; deliveredAt: number | null; lastErrorCode: string | null };
export function createMemoryDeliveryStore(events: NormalizedAuditEvent[] = []) {
  let now = Date.parse('2026-11-24T10:00:00Z');
  let data = { outbox: new Map<string, Row>(events.map(event => [event.eventId, { eventId: event.eventId, event, deliveryState: 'pending',
    attemptCount: 0, leaseToken: null, leaseExpiresAt: null, nextAttemptAt: now, deliveredAt: null, lastErrorCode: null }])), events: new Map<string, unknown>() };
  let tail = Promise.resolve();
  let insertFailure = false;
  let acknowledgeFailure = false;
  let loseCommitResponse = false;
  let beforeInsert: (() => Promise<void>) | undefined;
  const calls: string[] = [];
  const clock = () => new Date(now).toISOString().slice(0, 23).replace('T', ' ');
  const owned = (row: Row | undefined, token: string) => row && row.deliveryState === 'leased' && row.leaseToken === token && !!row.leaseExpiresAt && row.leaseExpiresAt > clock();
  const store: AuditDeliveryStore = {
    async listDue(limit) { calls.push('listDue'); return [...data.outbox.values()].filter(row => row.deliveryState === 'pending' && row.nextAttemptAt <= now).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.eventId.localeCompare(b.eventId)).slice(0, limit).map(row => row.eventId); },
    async listExpired(limit) { calls.push('listExpired'); return [...data.outbox.values()].filter(row => row.deliveryState === 'leased' && !!row.leaseExpiresAt && row.leaseExpiresAt <= clock()).slice(0, limit).map(({ eventId, leaseToken, leaseExpiresAt }) => ({ eventId, leaseToken, leaseExpiresAt })); },
    async recoverExpired(claim: AuditDeliveryClaim) {
      calls.push('recover'); const row = data.outbox.get(claim.eventId);
      if (!row || row.deliveryState !== 'leased' || row.leaseToken !== claim.leaseToken || row.leaseExpiresAt !== claim.leaseExpiresAt || !row.leaseExpiresAt || row.leaseExpiresAt > clock()) return false;
      Object.assign(row, { deliveryState: 'pending', nextAttemptAt: now, leaseToken: null, leaseExpiresAt: null, lastErrorCode: 'AUDIT_LEASE_EXPIRED' }); return true;
    },
    async claim(id, token, leaseMs) {
      calls.push('claim'); const row = data.outbox.get(id);
      if (!row || row.deliveryState !== 'pending' || row.nextAttemptAt > now) return false;
      Object.assign(row, { deliveryState: 'leased', leaseToken: token, leaseExpiresAt: new Date(now + leaseMs).toISOString().slice(0, 23).replace('T', ' '), attemptCount: Math.min(4_294_967_295, row.attemptCount + 1) }); return true;
    },
    async transaction(work) {
      let release!: () => void;
      const previous = tail; tail = new Promise<void>(resolve => { release = resolve; }); await previous;
      const copy = structuredClone(data);
      try {
        const value = await work({
          async getOutbox(id) { calls.push('lock'); return copy.outbox.get(id) ?? null; },
          async now() { calls.push('clock'); return clock(); },
          async getEvent(id) { return copy.events.get(id) ?? null; },
          async insertEvent(event) { calls.push('insert'); if (beforeInsert) await beforeInsert(); if (insertFailure) throw new Error('Synthetic private store failure'); copy.events.set(event.eventId, event); },
          async acknowledge(id, token) {
            calls.push('ack'); const row = copy.outbox.get(id);
            if (acknowledgeFailure || !owned(row, token)) return false;
            Object.assign(row!, { deliveryState: 'delivered', deliveredAt: now, leaseToken: null, leaseExpiresAt: null, lastErrorCode: null }); return true;
          },
          async fail(id, token, errorCode, delay) {
            const row = copy.outbox.get(id); if (!owned(row, token)) return false;
            Object.assign(row!, { deliveryState: delay === null ? 'failed' : 'pending', nextAttemptAt: delay === null ? row!.nextAttemptAt : now + delay,
              leaseToken: null, leaseExpiresAt: null, lastErrorCode: errorCode }); return true;
          },
        });
        data = copy;
        if (loseCommitResponse) { loseCommitResponse = false; throw new Error('Synthetic lost commit response'); }
        return value;
      } finally { release(); }
    },
  };
  return { ...store, calls, get rows() { return data.outbox; }, get events() { return data.events; }, advance(ms: number) { now += ms; },
    setInsertFailure(value: boolean) { insertFailure = value; }, setAcknowledgeFailure(value: boolean) { acknowledgeFailure = value; },
    loseNextCommitResponse() { loseCommitResponse = true; }, beforeInsert(work?: () => Promise<void>) { beforeInsert = work; } };
}
