import { drizzle } from 'drizzle-orm/mysql2';
import type { Pool } from 'mysql2/promise';
import { expect, test } from 'vitest';
import type { DatabaseConnection } from '../../core/database/connection.ts';
import { createUsersStore } from './repository.ts';

type Call = { sql: string; params: unknown[] };
const write = { affectedRows: 1, insertId: 0 };
// Recording driver only: verifies SQL contracts, not TiDB execution or lock semantics.
function recording(answer: (call: Call) => unknown = () => write) {
  const calls: Call[] = [];
  const client = { async query(query: { sql: string }, params: unknown[] = []) {
    const call = { sql: query.sql, params }; calls.push(call); return [answer(call), []];
  } };
  const db = drizzle({ client: client as unknown as Pool });
  const connection: DatabaseConnection = { db, transaction: db.transaction.bind(db), ping: async () => {}, close: async () => {} };
  return { store: createUsersStore(connection), calls };
}

test('management list uses bounded primary-key pagination and never selects credential columns', async () => {
  const { store, calls } = recording(({ sql }) => sql.startsWith('select')
    ? [['user-id', 'HR-USER', 'role-id', 'hr', 'disabled', 1, 3]] : write);
  const result = await store.transaction(tx => tx.listUsers('cursor-id', 26));
  expect(result).toEqual([{ id: 'user-id', username: 'HR-USER', roleId: 'role-id', roleCode: 'hr', accountStatus: 'disabled', mustChangePassword: true, authVersion: 3 }]);
  const query = calls.find(call => call.sql.startsWith('select'))!;
  expect(query.sql).not.toMatch(/password_hash|token_hash|username_normalized/);
  expect(query.sql).toContain('`users`.`id` > ?');
  expect(query.sql).toContain('order by `users`.`id` asc limit ?');
  expect(query.params).toEqual(['cursor-id', 26]);
});

test('role assignment uses expected auth-version and does not activate or reset the account', async () => {
  const { store, calls } = recording();
  expect(await store.transaction(tx => tx.assignRole('target', 4, 'new-role', new Date('2026-11-23T10:00:00Z')))).toBe(true);
  const query = calls.find(call => call.sql.startsWith('update'))!;
  expect(query.sql).toContain('`users`.`auth_version` = ?');
  expect(query.sql).not.toMatch(/account_status|password_hash|must_change_password/);
  expect(query.params.slice(-2)).toEqual(['target', 4]);
});

test('reset does not activate a disabled account and exposes conflict through affected-row result', async () => {
  const { store, calls } = recording(({ sql }) => sql.startsWith('update') ? { affectedRows: 0, insertId: 0 } : write);
  const fixtureHash = 'fixture-only-not-a-password';
  expect(await store.transaction(tx => tx.resetPassword('target', 9, fixtureHash, new Date('2026-11-23T10:00:00Z')))).toBe(false);
  const query = calls.find(call => call.sql.startsWith('update'))!;
  expect(query.sql).not.toContain('account_status');
  expect(query.sql).not.toContain(fixtureHash);
  expect(query.params).toContain(fixtureHash);
  expect(query.params.slice(-2)).toEqual(['target', 9]);
});

test('account mutation transaction rolls back when its outbox write fails', async () => {
  const { store, calls } = recording(({ sql }) => {
    if (sql.startsWith('insert into `audit_outbox`')) throw new Error('Synthetic outbox failure');
    return write;
  });
  await expect(store.transaction(async tx => {
    await tx.disableUser('target', 1, new Date('2026-11-23T10:00:00Z'));
    await tx.appendAudit({ eventId: 'event-id', occurredAt: new Date('2026-11-23T10:00:00Z'),
      actorUserId: 'actor', actorRoleId: 'role', actorRoleCode: 'system_admin', module: 'users',
      action: 'users.disable', entityId: 'target', requestId: 'request-id', result: 'success', reasonCode: null });
  })).rejects.toThrow();
  expect(calls.at(-1)?.sql).toBe('rollback');
  expect(calls.some(call => call.sql === 'commit')).toBe(false);
});
