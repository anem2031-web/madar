import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/mysql2';
import type { Pool } from 'mysql2/promise';
import { expect, test } from 'vitest';
import type { DatabaseConnection } from '../../database/connection.ts';
import { createAuthStore } from '../../../modules/auth/repository.ts';
import type { AuthAudit } from '../../../modules/auth/store.ts';
import { createAuditDeliveryStore } from '../delivery-repository.ts';
import { normalizeAuditEvent } from '../event.ts';

type Call = { sql: string; params: unknown[] };
const write = { affectedRows: 1, insertId: 0 };
function recording(answer: (call: Call) => unknown = () => write) {
  const calls: Call[] = [];
  const client = { async query(query: { sql: string }, params: unknown[] = []) {
    const call = { sql: query.sql, params }; calls.push(call); return [answer(call), []];
  } };
  const db = drizzle({ client: client as unknown as Pool });
  const connection: DatabaseConnection = { db, transaction: db.transaction.bind(db), ping: async () => {}, close: async () => {} };
  return { calls, store: createAuditDeliveryStore(connection), auth: createAuthStore(connection) };
}
function audit(): AuthAudit { return { eventId: randomUUID(), occurredAt: new Date('2026-11-24T10:00:00Z'), actorUserId: randomUUID(), actorRoleId: randomUUID(),
  actorRoleCode: 'system_admin', module: 'audit', action: 'audit.list', entityId: null, requestId: randomUUID(), result: 'success', reasonCode: null,
  metadata: { count: 25, filterTypes: ['period', 'result'] } }; }

test('due and expired candidates have separate bounded state/date ranges, stable ordering, and no source payload scan', async () => {
  const id = randomUUID(); const token = randomUUID(); const expiry = '2026-11-24 10:00:30.000';
  const { store, calls } = recording(({ sql }) => sql.includes('`lease_token`') ? [[id, token, expiry]] : [[id]]);
  expect(await store.listDue(25)).toEqual([id]);
  expect(await store.listExpired(25)).toEqual([{ eventId: id, leaseToken: token, leaseExpiresAt: expiry }]);
  expect(calls[0].sql).toContain('`audit_outbox`.`next_attempt_at` <= utc_timestamp(3)');
  expect(calls[0].sql).toContain('order by `audit_outbox`.`next_attempt_at` asc, `audit_outbox`.`event_id` asc limit ?');
  expect(calls[0].params).toEqual(['pending', 25]);
  expect(calls[1].sql).toContain('`audit_outbox`.`lease_expires_at` <= utc_timestamp(3)');
  expect(calls[1].sql).toContain('order by `audit_outbox`.`lease_expires_at` asc, `audit_outbox`.`event_id` asc limit ?');
  expect(calls[1].params).toEqual(['leased', 25]);
  for (const call of calls) expect(call.sql).not.toMatch(/offset|skip locked|before_values|after_values|metadata|count\(/i);
});

test('claim/recovery and terminal transitions only update delivery metadata with state, token, expiry and database clock fences', async () => {
  const { store, calls } = recording(); const id = randomUUID(); const token = randomUUID(); const expiry = '2026-11-24 09:59:30.000';
  expect(await store.claim(id, token, 30_000)).toBe(true);
  expect(await store.recoverExpired({ eventId: id, leaseToken: token, leaseExpiresAt: expiry })).toBe(true);
  await store.transaction(async tx => {
    expect(await tx.acknowledge(id, token)).toBe(true);
    expect(await tx.fail(id, token, 'AUDIT_DELIVERY_FAILED', 60_000)).toBe(true);
    expect(await tx.fail(id, token, 'AUDIT_UNSAFE_EVENT', null)).toBe(true);
  });
  const updates = calls.filter(call => call.sql.startsWith('update'));
  expect(updates[0].sql).toContain('least(`audit_outbox`.`attempt_count` + 1, 4294967295)');
  expect(updates[0].sql).toContain('timestampadd(microsecond, ?, utc_timestamp(3))');
  expect(updates[0].params).toEqual(['leased', token, 30_000_000, id, 'pending']);
  expect(updates[1].sql).toContain('`audit_outbox`.`lease_token` = ?');
  expect(updates[1].sql).toContain('`audit_outbox`.`lease_expires_at` = ?');
  expect(updates[1].sql).toContain('`audit_outbox`.`lease_expires_at` <= utc_timestamp(3)');
  expect(updates[1].params).toEqual(['pending', null, null, 'AUDIT_LEASE_EXPIRED', id, 'leased', token, expiry]);
  for (const update of updates.slice(2)) {
    expect(update.sql).toContain('`audit_outbox`.`lease_token` = ?');
    expect(update.sql).toContain('`audit_outbox`.`lease_expires_at` > utc_timestamp(3)');
    expect(update.params.slice(-3)).toEqual([id, 'leased', token]);
  }
  for (const update of updates) expect(update.sql.split(' where ')[0]).not.toMatch(/`(?:occurred_at|before_values|after_values|metadata|action|module|entity_id|request_id)` =/);
  expect(updates[3].params).toContain(60_000_000); expect(updates[4].params).toContain('failed');
});

test('delivery locks source before a fresh database UTC read, and failed ack rolls back the inserted target', async () => {
  const source = normalizeAuditEvent(audit()); const token = randomUUID();
  const persisted = [source.eventId, source.occurredAt, source.actorUserId, source.actorRoleId, source.actorRoleCode, source.module,
    source.action, source.entityId, source.entityVersion, source.requestId, source.result, source.reasonCode, null, null, source.metadata];
  const { store, calls } = recording(({ sql }) => {
    if (sql.includes('as audit_clock')) return [{ audit_clock: '2026-11-24 10:00:01.000' }];
    if (sql.startsWith('select') && sql.includes('from `audit_outbox`')) return [[...persisted, 'leased', 1, token, '2026-11-24 10:00:30.000']];
    if (sql.startsWith('update')) return { affectedRows: 0, insertId: 0 };
    return write;
  });
  await expect(store.transaction(async tx => {
    const row = await tx.getOutbox(source.eventId); expect(normalizeAuditEvent(row!.event)).toEqual(source);
    expect(await tx.now()).toBe('2026-11-24 10:00:01.000');
    await tx.insertEvent(source);
    if (!await tx.acknowledge(source.eventId, token)) throw new Error('AUDIT_LEASE_LOST');
  })).rejects.toThrow('AUDIT_LEASE_LOST');
  const select = calls.findIndex(call => call.sql.startsWith('select') && call.sql.includes('from `audit_outbox`'));
  expect(calls[select].sql).toContain('for update');
  expect(calls.findIndex(call => call.sql.includes('as audit_clock'))).toBeGreaterThan(select);
  expect(calls.some(call => call.sql.startsWith('insert into `audit_events`'))).toBe(true);
  expect(calls.at(-1)?.sql).toBe('rollback'); expect(calls.some(call => call.sql === 'commit')).toBe(false);
});

test('central appendAudit binds normalized safe source content and rejects secret/invalid data before an insert', async () => {
  const safe = audit(); const { auth, calls } = recording();
  await auth.transaction(tx => tx.appendAudit(safe));
  const inserted = calls.find(call => call.sql.startsWith('insert into `audit_outbox`'))!;
  expect(inserted.params).toContain('2026-11-24 10:00:00.000'); expect(inserted.params).toContain(JSON.stringify(safe.metadata));
  const prior = calls.filter(call => call.sql.startsWith('insert')).length;
  await expect(auth.transaction(tx => tx.appendAudit({ ...safe, metadata: { csrfToken: 'Synthetic private value' } } as unknown as AuthAudit))).rejects.toThrow('AUDIT_UNSAFE_EVENT');
  expect(calls.filter(call => call.sql.startsWith('insert'))).toHaveLength(prior);
  expect(calls.at(-1)?.sql).toBe('rollback');
});
