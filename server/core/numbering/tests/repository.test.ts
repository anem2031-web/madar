import { drizzle } from 'drizzle-orm/mysql2';
import type { Pool } from 'mysql2/promise';
import { expect, test } from 'vitest';
import type { DatabaseConnection } from '../../database/connection.ts';
import { numberingFormat } from '../../../../shared/numbering/settings.ts';
import { createNumberingSettingsStore } from '../repository.ts';

type Call = { sql: string; params: unknown[] };
const write = { affectedRows: 1, insertId: 0 };
const storedRow = ['series-id', 'DocType', 'Fsw', numberingFormat, 4, 'annual', 1, 2];
// Recording driver validates bounded SQL and transaction shape, not TiDB plans or locks.
function recording(answer: (call: Call) => unknown = () => write) {
  const calls: Call[] = [];
  const client = { async query(query: { sql: string }, params: unknown[] = []) {
    const call = { sql: query.sql, params }; calls.push(call); return [answer(call), []];
  } };
  const db = drizzle({ client: client as unknown as Pool });
  const connection: DatabaseConnection = { db, transaction: db.transaction.bind(db), ping: async () => {}, close: async () => {} };
  return { store: createNumberingSettingsStore(connection), calls };
}

test('list uses primary-key pagination and indexed issuance existence rather than counts or document contents', async () => {
  const { store, calls } = recording(({ sql }) => sql.startsWith('select') ? [[...storedRow, 1]] : write);
  const result = await store.transaction(tx => tx.listSeries('cursor-id', 26));
  expect(result[0]).toMatchObject({ id: 'series-id', code: 'DocType', enabled: true, version: 2, hasIssued: true });
  const query = calls.find(call => call.sql.startsWith('select'))!;
  expect(query.sql).toContain('exists (select 1 from `numbering_issuances`');
  expect(query.sql).toContain('`numbering_issuances`.`series_id` = `numbering_series`.`id` limit 1');
  expect(query.sql).toContain('`numbering_series`.`id` > ?');
  expect(query.sql).toContain('order by `numbering_series`.`id` asc limit ?');
  expect(query.sql).not.toMatch(/count\(|target_id|issued_number|created_by|password_hash/i);
  expect(query.params).toEqual(['cursor-id', 26]);
});

test('parent series is locked before the current bounded issuance read', async () => {
  const { store, calls } = recording(({ sql }) => sql.startsWith('select')
    ? sql.includes('from `numbering_series`') ? [storedRow] : [['issuance-id']] : write);
  const result = await store.transaction(async tx => ({ series: await tx.getSeries('series-id'), hasIssued: await tx.hasIssuances('series-id') }));
  expect(result.series).toMatchObject({ id: 'series-id', version: 2 });
  expect(result.hasIssued).toBe(true);
  const queries = calls.filter(call => call.sql.startsWith('select'));
  expect(queries).toHaveLength(2);
  expect(queries[0].sql).toContain('from `numbering_series`');
  expect(queries[0].sql).toContain('for update');
  expect(queries[1].sql).toContain('from `numbering_issuances`');
  expect(queries[1].sql).toContain('`numbering_issuances`.`series_id` = ? limit ? for update');
  expect(queries[1].params).toEqual(['series-id', 1]);
});

test('update compares version without modifying code, format, padding, counters or issued records', async () => {
  const { store, calls } = recording(({ sql }) => sql.startsWith('update') ? { ...write, affectedRows: 0 } : write);
  const result = await store.transaction(tx => tx.updateSeries('series-id', 7,
    { prefix: 'Abc', resetPolicy: 'continuous', enabled: false }, 'actor-id', new Date('2026-11-24T10:00:00Z')));
  expect(result).toBe(false);
  const query = calls.find(call => call.sql.startsWith('update'))!;
  expect(query.sql).toContain('`numbering_series`.`version` = ?');
  expect(query.sql).toContain('`version` = `numbering_series`.`version` + 1');
  expect(query.sql).not.toMatch(/`code` =|`format` =|`padding_width` =|numbering_counters|numbering_issuances/);
  expect(query.params.slice(-2)).toEqual(['series-id', 7]);
  expect(query.params).toContain('actor-id');
  expect(query.params).toContain('2026-11-24 10:00:00.000');
});

test('outbox failure after a settings write rolls the transaction back', async () => {
  const { store, calls } = recording(({ sql }) => {
    if (sql.startsWith('insert into `audit_outbox`')) throw new Error('Synthetic protected audit failure.');
    return write;
  });
  await expect(store.transaction(async tx => {
    const now = new Date('2026-11-24T10:00:00Z');
    await tx.updateSeries('00000000-0000-4000-8000-000000000004', 1, { prefix: 'Fsw', resetPolicy: 'annual', enabled: false }, '00000000-0000-4000-8000-000000000002', now);
    await tx.appendAudit({ eventId: '00000000-0000-4000-8000-000000000001', occurredAt: now, actorUserId: '00000000-0000-4000-8000-000000000002', actorRoleId: '00000000-0000-4000-8000-000000000003', actorRoleCode: 'system_admin',
      module: 'numbering', action: 'numbering.series.update', entityId: '00000000-0000-4000-8000-000000000004', entityVersion: 2,
      requestId: '00000000-0000-4000-8000-000000000005', result: 'success', reasonCode: null });
  })).rejects.toThrow();
  expect(calls.at(-1)?.sql).toBe('rollback');
  expect(calls.some(call => call.sql.startsWith('insert into `audit_outbox`'))).toBe(true);
  expect(calls.some(call => call.sql === 'commit')).toBe(false);
});
