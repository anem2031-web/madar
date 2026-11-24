import { drizzle } from 'drizzle-orm/mysql2';
import type { Pool } from 'mysql2/promise';
import { expect, test } from 'vitest';
import type { DatabaseConnection } from '../../../core/database/connection.ts';
import { createPermissionOverridesStore } from '../repository.ts';

type Call = { sql: string; params: unknown[] };
const write = { affectedRows: 1, insertId: 0 };
// Recording driver validates SQL shape and transaction boundaries, not TiDB execution.
function recording(answer: (call: Call) => unknown = () => write) {
  const calls: Call[] = [];
  const client = { async query(query: { sql: string }, params: unknown[] = []) {
    const call = { sql: query.sql, params }; calls.push(call); return [answer(call), []];
  } };
  const db = drizzle({ client: client as unknown as Pool });
  const connection: DatabaseConnection = { db, transaction: db.transaction.bind(db), ping: async () => {}, close: async () => {} };
  return { store: createPermissionOverridesStore(connection), calls };
}

test('safe account picker uses a bounded primary-key cursor and no credential columns', async () => {
  const { store, calls } = recording(({ sql }) => sql.startsWith('select') ? [['user-id', 'Synthetic', 'hr', 'active', 7]] : write);
  expect(await store.transaction(tx => tx.listPermissionUsers('cursor-id', 26))).toEqual([
    { id: 'user-id', username: 'Synthetic', roleCode: 'hr', accountStatus: 'active', authVersion: 7 },
  ]);
  const query = calls.find(call => call.sql.startsWith('select'))!;
  expect(query.sql).not.toMatch(/password_hash|token_hash|username_normalized|must_change_password/);
  expect(query.sql).toContain('`users`.`id` > ?');
  expect(query.sql).toContain('order by `users`.`id` asc limit ?');
  expect(query.params).toEqual(['cursor-id', 26]);
});

test('version compare-and-swap touches no role/state/password fields and reports lost update', async () => {
  const { store, calls } = recording(({ sql }) => sql.startsWith('update') ? { affectedRows: 0, insertId: 0 } : write);
  expect(await store.transaction(tx => tx.bumpAuthVersion('target-id', 9, new Date('2026-11-23T14:00:00Z')))).toBe(false);
  const query = calls.find(call => call.sql.startsWith('update'))!;
  expect(query.sql).toContain('`users`.`auth_version` = ?');
  expect(query.sql).not.toMatch(/role_id|account_status|password_hash|must_change_password/);
  expect(query.params.slice(-2)).toEqual(['target-id', 9]);
});

test('full override replacement deletes only target prefix and binds explicit effects', async () => {
  const { store, calls } = recording();
  await store.transaction(tx => tx.replaceOverrides('target-id', [{ permissionCode: 'audit.read', effect: 'grant' }], new Date('2026-11-23T14:00:00Z')));
  const deletion = calls.find(call => call.sql.startsWith('delete'))!;
  expect(deletion.sql).toContain('where `user_permission_overrides`.`user_id` = ?');
  expect(deletion.params).toEqual(['target-id']);
  const insertion = calls.find(call => call.sql.startsWith('insert'))!;
  expect(insertion.params).toEqual(['target-id', 'audit.read', 'grant', '2026-11-23 14:00:00.000']);
  expect(insertion.sql).not.toContain('audit.read');
  const empty = recording();
  await empty.store.transaction(tx => tx.replaceOverrides('target-id', [], new Date()));
  expect(empty.calls.some(call => call.sql.startsWith('insert'))).toBe(false);
});

test('an outbox failure rolls back override changes and session revocation together', async () => {
  const { store, calls } = recording(({ sql }) => {
    if (sql.startsWith('insert into `audit_outbox`')) throw new Error('Synthetic outbox failure');
    return write;
  });
  const now = new Date('2026-11-23T14:00:00Z');
  await expect(store.transaction(async tx => {
    await tx.bumpAuthVersion('00000000-0000-4000-8000-000000000004', 1, now);
    await tx.replaceOverrides('00000000-0000-4000-8000-000000000004', [{ permissionCode: 'audit.read', effect: 'deny' }], now);
    await tx.revokeUserSessions('00000000-0000-4000-8000-000000000004', now);
    await tx.appendAudit({ eventId: '00000000-0000-4000-8000-000000000001', occurredAt: now, actorUserId: '00000000-0000-4000-8000-000000000002', actorRoleId: '00000000-0000-4000-8000-000000000003',
      actorRoleCode: 'system_admin', module: 'permissions', action: 'permissions.overrides.save', entityId: '00000000-0000-4000-8000-000000000004',
      requestId: '00000000-0000-4000-8000-000000000005', result: 'success', reasonCode: null });
  })).rejects.toThrow();
  expect(calls.at(-1)?.sql).toBe('rollback'); expect(calls.some(call => call.sql === 'commit')).toBe(false);
  expect(calls.some(call => call.sql.startsWith('insert into `audit_outbox`'))).toBe(true);
});
