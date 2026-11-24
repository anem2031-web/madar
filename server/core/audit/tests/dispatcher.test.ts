import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { createAuditDispatcher } from '../dispatcher.ts';
import { canonicalAuditEvent, normalizeAuditEvent } from '../event.ts';
import { createMemoryDeliveryStore } from './memory-delivery.ts';

function event() { return normalizeAuditEvent({ eventId: randomUUID(), occurredAt: new Date('2026-11-24T10:00:00Z'), actorUserId: null,
  actorRoleId: null, actorRoleCode: null, module: 'auth', action: 'auth.login', entityId: null, requestId: randomUUID(), result: 'denied', reasonCode: 'invalid_credentials' }); }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('a bounded cycle claims just in time and copies immutable events without generating worker audit records', async () => {
  const input = Array.from({ length: 27 }, event); const store = createMemoryDeliveryStore(input);
  const worker = createAuditDispatcher(store); const result = await worker.runOnce();
  expect(result).toMatchObject({ claimed: 25, delivered: 25 }); expect(store.events.size).toBe(25); expect(store.rows.size).toBe(27);
  const operations = store.calls.filter(value => ['claim', 'insert', 'ack'].includes(value));
  expect(operations.slice(0, 6)).toEqual(['claim', 'insert', 'ack', 'claim', 'insert', 'ack']);
  for (const saved of store.events.values()) expect(input.some(source => canonicalAuditEvent(source) === canonicalAuditEvent(saved))).toBe(true);
  expect(store.calls.indexOf('clock')).toBeGreaterThan(store.calls.indexOf('lock'));
  expect((await worker.runOnce()).delivered).toBe(2);
});

test('two workers sharing the store use one lease owner per event and deduplicate an already matching target', async () => {
  const source = event(); const store = createMemoryDeliveryStore([source]);
  store.events.set(source.eventId, { ...source, occurredAt: source.occurredAt.replace(' ', 'T') + 'Z' });
  await Promise.all([createAuditDispatcher(store).runOnce(), createAuditDispatcher(store).runOnce()]);
  expect(store.events.size).toBe(1); expect(store.rows.get(source.eventId)?.deliveryState).toBe('delivered');
  expect(store.calls.filter(value => value === 'insert')).toHaveLength(0);
});

test('different complete content or an unsafe legacy source becomes failed without modifying either original', async () => {
  const source = event(); const unsafe = event(); const store = createMemoryDeliveryStore([source, unsafe]);
  const target = { ...source, metadata: { source: 'legacy_recovery', revokedSessions: 1 } }; store.events.set(source.eventId, target);
  const unsafeRow = store.rows.get(unsafe.eventId)!; unsafeRow.event = { ...unsafe, metadata: { password: 'Synthetic private value' } };
  const original = structuredClone(unsafeRow.event);
  expect((await createAuditDispatcher(store).runOnce()).failed).toBe(2);
  expect(store.events.get(source.eventId)).toEqual(target); expect(store.events.has(unsafe.eventId)).toBe(false);
  expect(store.rows.get(unsafe.eventId)?.event).toEqual(original);
  expect(store.rows.get(source.eventId)?.lastErrorCode).toBe('AUDIT_EVENT_CONFLICT');
  expect(store.rows.get(unsafe.eventId)?.lastErrorCode).toBe('AUDIT_UNSAFE_EVENT');
});

test('copy failures roll back and retry later with capped backoff without an attempt-count drop policy', async () => {
  const source = event(); const store = createMemoryDeliveryStore([source]); const worker = createAuditDispatcher(store);
  store.setInsertFailure(true);
  expect((await worker.runOnce()).deferred).toBe(1); expect(store.events.size).toBe(0);
  expect(store.rows.get(source.eventId)?.deliveryState).toBe('pending'); expect((await worker.runOnce()).claimed).toBe(0);
  store.advance(5_000); store.rows.get(source.eventId)!.attemptCount = 4_294_967_294;
  expect((await worker.runOnce()).deferred).toBe(1); expect(store.rows.get(source.eventId)?.attemptCount).toBe(4_294_967_295);
  store.advance(59_999); expect((await worker.runOnce()).claimed).toBe(0);
  store.advance(1); store.setInsertFailure(false); expect((await worker.runOnce()).delivered).toBe(1);
});

test('lost acknowledgment rolls the target insert back; expired fenced claims recover and stale tokens cannot acknowledge', async () => {
  const source = event(); const store = createMemoryDeliveryStore([source]); const worker = createAuditDispatcher(store);
  store.setAcknowledgeFailure(true); expect((await worker.runOnce()).skipped).toBe(1); expect(store.events.size).toBe(0);
  const old = { ...store.rows.get(source.eventId)! }; store.advance(30_000); store.setAcknowledgeFailure(false);
  expect(await store.recoverExpired({ eventId: source.eventId, leaseToken: 'different-token', leaseExpiresAt: old.leaseExpiresAt })).toBe(false);
  expect((await worker.runOnce()).recovered).toBe(1); expect(store.events.size).toBe(1);
  expect(await store.transaction(tx => tx.acknowledge(source.eventId, old.leaseToken!))).toBe(false);
});

test('expiry after insertion and ambiguous commit response never leave a second target event', async () => {
  const source = event(); const store = createMemoryDeliveryStore([source]); const worker = createAuditDispatcher(store);
  store.beforeInsert(async () => { store.advance(30_001); });
  expect((await worker.runOnce()).skipped).toBe(1); expect(store.events.size).toBe(0);
  store.beforeInsert(undefined); store.loseNextCommitResponse();
  await worker.runOnce(); expect(store.events.size).toBe(1); expect(store.rows.get(source.eventId)?.deliveryState).toBe('delivered');
  expect((await worker.runOnce()).claimed).toBe(0); expect(store.events.size).toBe(1);
});

test('runOnce is single-flight, start is idempotent, and stop drains the active transaction without new work', async () => {
  vi.useFakeTimers();
  const store = createMemoryDeliveryStore([event(), event()]); const worker = createAuditDispatcher(store);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  store.beforeInsert(async () => { entered(); await held; });
  const first = worker.runOnce(); expect(worker.runOnce()).toBe(first); await ready;
  worker.start(); worker.start(); const stopping = worker.stop(); let stopped = false; void stopping.then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); release(); await stopping;
  expect(store.events.size).toBe(1); const count = store.calls.length;
  await vi.advanceTimersByTimeAsync(60_000); await worker.runOnce(); expect(store.calls).toHaveLength(count);
});
