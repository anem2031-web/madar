import { randomUUID } from 'node:crypto';
import { AuditEventValidationError, auditEventsEqual, normalizeAuditEvent } from './event.ts';
import type { AuditDeliveryErrorCode, AuditDeliveryRecord, AuditDeliveryStore } from './delivery-store.ts';
import { logTechnicalFailure } from '../errors/technical-log.ts';

const batchSize = 25;
const leaseMs = 30_000;
const pollMs = 5_000;
type DeliveryResult = 'delivered' | 'deferred' | 'failed' | 'skipped';
export type AuditDispatchResult = { recovered: number; claimed: number; delivered: number; deferred: number; failed: number; skipped: number };
class LeaseLost extends Error { constructor() { super('AUDIT_LEASE_LOST'); } }
class EventConflict extends Error { constructor() { super('AUDIT_EVENT_CONFLICT'); } }
const liveClaim = (row: AuditDeliveryRecord | null, token: string, now: string): row is AuditDeliveryRecord =>
  !!row && row.deliveryState === 'leased' && row.leaseToken === token && !!row.leaseExpiresAt && row.leaseExpiresAt > now;
const retryDelay = (attempt: number) => Math.min(60_000, 5_000 * 2 ** Math.min(4, Math.max(0, attempt - 1)));

export function createAuditDispatcher(store: AuditDeliveryStore) {
  let active: Promise<AuditDispatchResult> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let stopping = false;

  async function deliver(eventId: string, token: string): Promise<DeliveryResult> {
    try {
      return await store.transaction(async tx => {
        const row = await tx.getOutbox(eventId);
        // Read the database clock only after the potentially blocking parent lock.
        if (!liveClaim(row, token, await tx.now())) return 'skipped' as const;
        const event = normalizeAuditEvent(row.event);
        const existing = await tx.getEvent(eventId);
        if (existing) {
          try { if (!auditEventsEqual(event, existing)) throw new EventConflict(); }
          catch { throw new EventConflict(); }
        } else await tx.insertEvent(event);
        if (!await tx.acknowledge(eventId, token)) throw new LeaseLost();
        return 'delivered' as const;
      });
    } catch (error) {
      if (error instanceof LeaseLost) return 'skipped';
      const code: AuditDeliveryErrorCode = error instanceof AuditEventValidationError ? 'AUDIT_UNSAFE_EVENT'
        : error instanceof EventConflict ? 'AUDIT_EVENT_CONFLICT' : 'AUDIT_DELIVERY_FAILED';
      const permanent = code !== 'AUDIT_DELIVERY_FAILED';
      // Any partial copy rolled back first. Only the still-current lease may record a failure.
      return store.transaction(async tx => {
        const row = await tx.getOutbox(eventId);
        if (!liveClaim(row, token, await tx.now())) return 'skipped' as const;
        const changed = await tx.fail(eventId, token, code, permanent ? null : retryDelay(row.attemptCount));
        return changed ? permanent ? 'failed' as const : 'deferred' as const : 'skipped' as const;
      });
    }
  }
  async function cycle(): Promise<AuditDispatchResult> {
    const result: AuditDispatchResult = { recovered: 0, claimed: 0, delivered: 0, deferred: 0, failed: 0, skipped: 0 };
    const expired = await store.listExpired(batchSize);
    for (const claim of expired) {
      if (stopping) return result;
      if (await store.recoverExpired(claim)) result.recovered++;
    }
    const ids = await store.listDue(batchSize);
    for (const eventId of ids) {
      if (stopping) break;
      const token = randomUUID();
      if (!await store.claim(eventId, token, leaseMs)) continue;
      result.claimed++;
      result[await deliver(eventId, token)]++;
    }
    return result;
  }
  function runOnce(): Promise<AuditDispatchResult> {
    if (active) return active;
    if (stopping) return Promise.resolve({ recovered: 0, claimed: 0, delivered: 0, deferred: 0, failed: 0, skipped: 0 });
    const task = cycle();
    active = task;
    void task.finally(() => { if (active === task) active = null; }).catch(() => {});
    return task;
  }
  function schedule(delay: number) {
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce().catch(error => {
        logTechnicalFailure({ scope: 'audit', operation: 'delivery', code: 'AUDIT_DELIVERY_FAILED', error });
      }).finally(() => { if (running) schedule(pollMs); });
    }, delay);
    timer.unref();
  }
  function start() {
    if (running) return;
    running = true; stopping = false; schedule(0);
  }
  async function stop() {
    running = false; stopping = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (active) await active.catch(() => {});
  }
  return { runOnce, start, stop };
}
