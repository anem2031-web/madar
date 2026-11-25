import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/mysql2';
import type { Pool } from 'mysql2/promise';
import { expect, test } from 'vitest';
import type { DatabaseConnection } from '../../database/connection.ts';
import { createOrganizationStore } from '../../../modules/organization/repository.ts';
import type { WriteOperationReceipt } from '../store.ts';

type Call = { sql: string; params: unknown[] };
const value: WriteOperationReceipt = {
  operationId: '00000000-0000-4000-8000-000000000001', actorUserId: '00000000-0000-4000-8000-000000000002',
  operationCode: 'organization.branches.create', inputHash: Buffer.alloc(32, 7),
  reservationToken: '00000000-0000-4000-8000-000000000003', response: null, createdAt: new Date('2026-11-25T09:00:00.123Z'),
};
const write = { affectedRows: 1, insertId: 0 };
const stored = (response: unknown = null, token = value.reservationToken) => [value.operationId, value.actorUserId, value.operationCode,
  value.inputHash, token, response, '2026-11-25 09:00:00.123'];

// Check generated SQL and transaction boundaries only; this is not a TiDB lock model.
function recording(answer: (call: Call) => unknown = () => write) {
  const calls: Call[] = [];
  const client = { async query(query: { sql: string }, params: unknown[] = []) {
    const call = { sql: query.sql, params }; calls.push(call); return [answer(call), []];
  } };
  const db = drizzle({ client: client as unknown as Pool });
  const connection: DatabaseConnection = { db, transaction: db.transaction.bind(db), ping: async () => {}, close: async () => {} };
  return { store: createOrganizationStore(connection), calls };
}

test.each([0, 1, 2])('claim materializes and locks one key without treating affectedRows=%s as ownership', async affectedRows => {
  const priorToken = '00000000-0000-4000-8000-000000000099';
  const { store, calls } = recording(({ sql }) => sql.startsWith('select') ? [stored({ branch: { id: 'existing' } }, priorToken)] : { affectedRows });
  const receipt = await store.transaction(tx => tx.claimWriteOperation(value));
  expect(receipt).toEqual({ ...value, reservationToken: priorToken, response: { branch: { id: 'existing' } } });
  const insert = calls.find(call => call.sql.startsWith('insert'))!;
  const locked = calls.find(call => call.sql.startsWith('select'))!;
  expect(insert.sql).toContain('on duplicate key update `operation_id` = `write_operation_receipts`.`operation_id`');
  expect(insert.params).toEqual([value.operationId, value.actorUserId, value.operationCode, value.inputHash, value.reservationToken, null, '2026-11-25 09:00:00.123']);
  expect(locked.sql).toContain('`write_operation_receipts`.`operation_id` = ?');
  expect(locked.sql).toContain('limit ? for update');
  expect(locked.params).toEqual([value.operationId, 1]);
  expect(calls.indexOf(insert)).toBeLessThan(calls.indexOf(locked));
  expect(calls.at(-1)?.sql).toBe('commit');
});

test('missing receipt after claim rolls back instead of returning an invented reservation', async () => {
  const { store, calls } = recording(({ sql }) => sql.startsWith('select') ? [] : write);
  await expect(store.transaction(tx => tx.claimWriteOperation(value))).rejects.toThrow('receipt unavailable');
  expect(calls.at(-1)?.sql).toBe('rollback');
});

test('completion and cancellation bind owner token and SQL-null result, not only operation identity', async () => {
  const { store, calls } = recording();
  const response = { branch: { id: value.operationId, name: 'فرع عربي', version: 1 } };
  expect(await store.transaction(tx => tx.completeWriteOperation(value.operationId, value.reservationToken, response))).toBe(true);
  await store.transaction(tx => tx.cancelWriteOperation(value.operationId, value.reservationToken));
  const update = calls.find(call => call.sql.startsWith('update'))!;
  const deletion = calls.find(call => call.sql.startsWith('delete'))!;
  for (const call of [update, deletion]) {
    expect(call.sql).toContain('`write_operation_receipts`.`operation_id` = ?');
    expect(call.sql).toContain('`write_operation_receipts`.`reservation_token` = ?');
    expect(call.sql).toContain('`write_operation_receipts`.`response_json` is null');
  }
  expect(update.params).toEqual([JSON.stringify(response), value.operationId, value.reservationToken]);
  expect(deletion.params).toEqual([value.operationId, value.reservationToken]);
  expect(update.sql).not.toContain('فرع عربي');
  const lost = recording(() => ({ affectedRows: 0 }));
  expect(await lost.store.transaction(tx => tx.completeWriteOperation(value.operationId, value.reservationToken, response))).toBe(false);
});

test.each([null, undefined])('SQL-null or undefined cannot mark a receipt complete', async response => {
  const { store, calls } = recording();
  await expect(store.transaction(tx => tx.completeWriteOperation(value.operationId, value.reservationToken, response))).rejects.toThrow('response required');
  expect(calls.some(call => call.sql.startsWith('update'))).toBe(false);
  expect(calls.at(-1)?.sql).toBe('rollback');
});

test('receipt completion failure rolls back business and outbox work in the same transaction', async () => {
  const { store, calls } = recording(({ sql }) => {
    if (sql.startsWith('select')) return [stored()];
    if (sql.startsWith('update `write_operation_receipts`')) throw new Error('Synthetic receipt failure');
    return write;
  });
  await expect(store.transaction(async tx => {
    await tx.claimWriteOperation(value);
    await tx.insertBranch({ id: value.operationId, name: 'Synthetic branch', version: 1 }, value.createdAt);
    await tx.appendAudit({ eventId: value.operationId, occurredAt: value.createdAt, actorUserId: value.actorUserId,
      actorRoleId: value.operationId, actorRoleCode: 'system_admin', module: 'organization', action: value.operationCode,
      entityId: value.operationId, requestId: value.reservationToken, result: 'success', reasonCode: null });
    await tx.completeWriteOperation(value.operationId, value.reservationToken, { branch: { id: value.operationId } });
  })).rejects.toThrow();
  expect(calls.some(call => call.sql.startsWith('insert into `branches`'))).toBe(true);
  expect(calls.some(call => call.sql.startsWith('insert into `audit_outbox`'))).toBe(true);
  expect(calls.at(-1)?.sql).toBe('rollback');
  expect(calls.some(call => call.sql === 'commit')).toBe(false);
});

test('additive migration builds its explicit index before the foreign key without altering applied tables', () => {
  const sql = readFileSync('database/migrations/0001_write_operation_receipts.sql', 'utf8');
  expect(sql).not.toMatch(/\b(?:drop|truncate|CHECK|SET GLOBAL)\b/);
  expect(sql.indexOf('CREATE INDEX')).toBeLessThan(sql.indexOf('ADD CONSTRAINT'));
  expect(sql).toContain('PRIMARY KEY(`operation_id`)');
  expect(sql).toContain('ON DELETE restrict ON UPDATE restrict');
  expect((sql.match(/CREATE TABLE/g) ?? [])).toHaveLength(1);
  expect((sql.match(/CREATE INDEX/g) ?? [])).toHaveLength(1);
  expect((sql.match(/ADD CONSTRAINT/g) ?? [])).toHaveLength(1);
});
