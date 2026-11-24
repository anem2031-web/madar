import { drizzle } from 'drizzle-orm/mysql2';
import type { Pool } from 'mysql2/promise';
import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../database/connection.ts';
import { createAuditStore } from '../repository.ts';

type Call = { sql: string; params: unknown[] };
const write = { affectedRows: 1, insertId: 0 };
function recording(answer: (call: Call) => unknown = ({ sql }) => sql.startsWith('select') ? [] : write) {
  const calls: Call[] = [];
  const client = { async query(query: { sql: string }, params: unknown[] = []) { const call = { sql: query.sql, params }; calls.push(call); return [answer(call), []]; } };
  const db = drizzle({ client: client as unknown as Pool });
  const connection: DatabaseConnection = { db, transaction: db.transaction.bind(db), ping: async () => {}, close: async () => {} };
  return { store: createAuditStore(connection), calls };
}
test('timeline SQL uses a bounded descending two-column cursor and residual typed filters without JSON or joins', async () => {
  const { store, calls } = recording();
  const actorId = randomUUID(); const eventId = randomUUID();
  await store.transaction(tx => tx.listEvents({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-24T00:00:00.000Z',
    actorUserId: actorId, module: 'organization', result: 'success', cursor: { occurredAt: '2026-11-20T00:00:00.000Z', eventId } }, 26));
  const query = calls.find(call => call.sql.startsWith('select'))!;
  expect(query.sql).toContain('`audit_events`.`actor_user_id` = ?');
  expect(query.sql).toContain('`audit_events`.`occurred_at` < ?');
  expect(query.sql).toContain('`audit_events`.`event_id` < ?');
  expect(query.sql).toContain('order by `audit_events`.`occurred_at` desc, `audit_events`.`event_id` desc limit ?');
  expect(query.sql).not.toMatch(/before_values|after_values|metadata|join|offset|like|count\(/i);
  expect(query.params).toEqual(['2026-11-01 00:00:00.000', '2026-11-24 00:00:00.000', actorId, 'organization', 'success', '2026-11-20 00:00:00.000', '2026-11-20 00:00:00.000', eventId, 26]);
});
test('detail reads only delivered events by primary key and status accesses state prefixes with a bounded safe failure projection', async () => {
  const { store, calls } = recording(); const eventId = randomUUID();
  expect(await store.transaction(tx => tx.getEvent(eventId))).toBeNull();
  const detail = calls.find(call => call.sql.startsWith('select'))!;
  expect(detail.sql).toContain('from `audit_events` where `audit_events`.`event_id` = ? limit ?');
  expect(detail.sql).not.toContain('audit_outbox');
  await store.transaction(tx => tx.deliveryStatus());
  const status = calls.filter(call => call.sql.startsWith('select') && call.sql.includes('audit_outbox'));
  expect(status).toHaveLength(3);
  expect(status[0].sql).toContain('`audit_outbox`.`delivery_state` in (?, ?, ?)');
  expect(status[0].params).toEqual(['pending', 'leased', 'failed']);
  expect(status[2].params).toEqual(['failed', 10]);
  expect(status[2].sql).not.toMatch(/before_values|after_values|metadata|lease_token/);
});
