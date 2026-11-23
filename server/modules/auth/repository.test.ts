import { describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import type { Pool } from 'mysql2/promise';
import type { DatabaseConnection } from '../../core/database/connection.ts';
import { bootstrapAdmin } from './bootstrap.ts';
import { createAuthStore } from './repository.ts';

type Call = { sql: string; params: unknown[] };
type DriverResult = unknown[][] | { affectedRows: number; insertId: number };

// This fake covers driver SQL/transaction contracts only, never TiDB execution or locking guarantees.
function recordingConnection(answer: (call: Call) => DriverResult) {
  const calls: Call[] = [];
  const client = {
    async query(query: { sql: string }, params: unknown[] = []) {
      const call = { sql: query.sql, params };
      calls.push(call);
      return [answer(call), []];
    },
  };
  const db = drizzle({ client: client as unknown as Pool });
  const connection: DatabaseConnection = {
    db, transaction: db.transaction.bind(db), ping: async () => {}, close: async () => {},
  };
  return { connection, calls };
}

const writeResult = { affectedRows: 1, insertId: 0 };
const hash = 'scrypt$1$32768$8$3$abcdefghijklmnopqrstuv$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

describe('authentication repository driver contract', () => {
  test('an existing ADMIN is a true no-op without credential or grant mutations', async () => {
    const { connection, calls } = recordingConnection(({ sql }) => {
      if (sql.startsWith('select `username_normalized`')) return [['admin']];
      if (sql.startsWith('select `id` from `users`')) return [['existing-admin']];
      return writeResult;
    });
    await expect(bootstrapAdmin(connection, hash)).resolves.toEqual({ status: 'already_initialized' });
    expect(calls.map(c => c.sql.split(' ')[0])).toEqual(['begin', 'select', 'select', 'commit']);
    expect(calls.some(c => c.params.includes(hash))).toBe(false);
  });

  test('refuses taking over an installation with users but without ADMIN', async () => {
    const { connection, calls } = recordingConnection(({ sql }) => {
      if (sql.startsWith('select `username_normalized`')) return [['somebody']];
      if (sql.startsWith('select `id` from `users`')) return [];
      return writeResult;
    });
    await expect(bootstrapAdmin(connection, hash)).rejects.toThrow('already initialized');
    expect(calls.at(-1)?.sql).toBe('rollback');
    expect(calls.some(c => c.sql.startsWith('insert'))).toBe(false);
  });

  test('initial setup rolls back when its durable audit write fails', async () => {
    const { connection, calls } = recordingConnection(({ sql }) => {
      if (sql.startsWith('select `username_normalized`')) return [];
      if (sql.startsWith('select `id`, `code`')) return [['admin-role', 'system_admin', 'مدير النظام', 1,
        '2026-11-23 00:00:00.000', '2026-11-23 00:00:00.000']];
      if (sql.startsWith('select `id` from `roles`')) return [['hr-role']];
      if (sql.startsWith('insert into `audit_outbox`')) throw new Error('simulated write failure');
      return writeResult;
    });
    await expect(bootstrapAdmin(connection, hash)).rejects.toThrow();
    expect(calls.at(-1)?.sql).toBe('rollback');
    expect(calls.some(c => c.sql === 'commit')).toBe(false);
    const userInsert = calls.find(c => c.sql.startsWith('insert into `users`'));
    expect(userInsert?.params).toContain('ADMIN');
    expect(userInsert?.params).toContain(hash);
    expect(userInsert?.sql).not.toContain(hash);
    expect(calls.filter(c => c.sql.includes('from `roles`')).every(c => c.sql.endsWith('for update'))).toBe(true);
  });

  test('session lookup binds the hash and locks the unique session row', async () => {
    const { connection, calls } = recordingConnection(({ sql }) => sql.startsWith('select') ? [] : writeResult);
    const tokenHash = Buffer.alloc(32, 99);
    await expect(createAuthStore(connection).transaction(tx => tx.getSession(tokenHash))).resolves.toBeNull();
    const lookup = calls.find(c => c.sql.includes('from `sessions`'));
    expect(lookup?.sql).toContain('`sessions`.`token_hash` = ?');
    expect(lookup?.sql).toMatch(/for update$/);
    expect(lookup?.params[0]).toEqual(tokenHash);
    expect(calls.at(-1)?.sql).toBe('commit');
  });

  test('password update includes account status and auth-version compare-and-swap', async () => {
    const { connection, calls } = recordingConnection(() => writeResult);
    await expect(createAuthStore(connection).transaction(tx => tx.updatePassword('user-id', 7, hash,
      new Date('2026-11-23T12:00:00Z')))).resolves.toBe(true);
    const update = calls.find(c => c.sql.startsWith('update `users`'));
    expect(update?.sql).toContain('`users`.`auth_version` = ?');
    expect(update?.sql).toContain('`users`.`account_status` = ?');
    expect(update?.params.slice(-3)).toEqual(['user-id', 7, 'active']);
    expect(update?.sql).not.toContain(hash);
  });

  test('persisted throttle blocks the sixth attempt without extending its fixed window', async () => {
    const key = Buffer.alloc(32, 5);
    const now = new Date('2026-11-23T12:05:00Z');
    const { connection, calls } = recordingConnection(({ sql }) => {
      if (sql.startsWith('select') && sql.includes('from `auth_throttles`')) return [[key,
        '2026-11-23 12:00:00.000', '2026-11-23 12:15:00.000', '2026-11-23 12:04:00.000', 5, null]];
      return writeResult;
    });
    await expect(createAuthStore(connection).transaction(tx => tx.consumeThrottle([key], now, 5, 900_000))).resolves.toBe(false);
    const update = calls.find(c => c.sql.startsWith('update `auth_throttles`'));
    expect(update?.params).toContain(6);
    expect(update?.params.filter(p => p === '2026-11-23 12:15:00.000')).toHaveLength(2);
    expect(update?.params).not.toContain('2026-11-23 12:20:00.000');
    expect(calls.find(c => c.sql.startsWith('select'))?.sql).toMatch(/for update$/);
    expect(calls.at(-1)?.sql).toBe('commit');
  });

  test('expired throttle restarts its count and clears the prior block', async () => {
    const key = Buffer.alloc(32, 6);
    const now = new Date('2026-11-23T12:15:00Z');
    const { connection, calls } = recordingConnection(({ sql }) => {
      if (sql.startsWith('select') && sql.includes('from `auth_throttles`')) return [[key,
        '2026-11-23 12:00:00.000', '2026-11-23 12:15:00.000', '2026-11-23 12:14:00.000', 40, '2026-11-23 12:15:00.000']];
      return writeResult;
    });
    await expect(createAuthStore(connection).transaction(tx => tx.consumeThrottle([key], now, 5, 900_000))).resolves.toBe(true);
    const update = calls.find(c => c.sql.startsWith('update `auth_throttles`'));
    expect(update?.params).toContain(1);
    expect(update?.params).toContain(null);
    expect(update?.params).toContain('2026-11-23 12:30:00.000');
  });

  test.each([
    { label: 'legacy fifteen-minute row before two minutes', storedExpiry: '2026-11-23 12:15:00.000',
      now: '2026-11-23T12:01:59.999Z', allowed: false, count: 6, expiry: '2026-11-23 12:02:00.000' },
    { label: 'legacy fifteen-minute row exactly at two minutes', storedExpiry: '2026-11-23 12:15:00.000',
      now: '2026-11-23T12:02:00.000Z', allowed: true, count: 1, expiry: '2026-11-23 12:04:00.000' },
    { label: 'shorter stored window before its earlier expiry', storedExpiry: '2026-11-23 12:01:00.000',
      now: '2026-11-23T12:00:59.999Z', allowed: false, count: 6, expiry: '2026-11-23 12:01:00.000' },
    { label: 'shorter stored window exactly at its earlier expiry', storedExpiry: '2026-11-23 12:01:00.000',
      now: '2026-11-23T12:01:00.000Z', allowed: true, count: 1, expiry: '2026-11-23 12:03:00.000' },
  ])('$label honors the current duration without prolonging an existing block', async ({ storedExpiry, now, allowed, count, expiry }) => {
    const key = Buffer.alloc(32, 7);
    const { connection, calls } = recordingConnection(({ sql }) => {
      if (sql.startsWith('select') && sql.includes('from `auth_throttles`')) return [[key,
        '2026-11-23 12:00:00.000', storedExpiry, '2026-11-23 12:00:00.000', 5, storedExpiry]];
      return writeResult;
    });
    await expect(createAuthStore(connection).transaction(tx => tx.consumeThrottle([key], new Date(now), 5, 120_000)))
      .resolves.toBe(allowed);
    const update = calls.find(c => c.sql.startsWith('update `auth_throttles`'));
    expect(update?.params).toContain(count);
    expect(update?.params.filter(value => value === expiry)).toHaveLength(allowed ? 1 : 2);
    if (allowed) expect(update?.params).toContain(null);
    if (storedExpiry > expiry) expect(update?.params).not.toContain(storedExpiry);
    expect(update?.params.at(-1)).toEqual(key);
    expect(calls.find(c => c.sql.includes('from `auth_throttles`'))?.sql).toMatch(/for update$/);
    expect(calls.at(-1)?.sql).toBe('commit');
  });
});
