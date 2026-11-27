import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import { manageDatabasePool } from './connection.ts';

function fixture(policy = { connectionLimit: 1, queueLimit: 1, acquisitionTimeoutMs: 100 }) {
  const commands: string[] = [];
  const resources: { release: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];
  const failures = new Set<string>();
  const pool = {
    getConnection: vi.fn(async () => {
      const command = vi.fn(async (options: { sql: string } | string) => {
        const text = typeof options === 'string' ? options : options.sql;
        commands.push(text);
        if (failures.has(text)) throw new Error('synthetic driver failure');
        return [[], []];
      });
      const resource = { query: command, execute: command, release: vi.fn(), destroy: vi.fn() };
      resources.push(resource);
      return resource as unknown as PoolConnection;
    }),
    end: vi.fn(async () => {}),
  };
  return { connection: manageDatabasePool(pool, policy), pool, commands, resources, failures };
}
afterEach(() => vi.useRealTimers());

describe('managed database ownership', () => {
  it('uses the same gate for direct Drizzle queries, ping and both transaction entry points', async () => {
    const f = fixture();
    await f.connection.db.execute(sql`select 2`);
    await f.connection.ping();
    await f.connection.transaction(tx => tx.execute(sql`select 3`));
    await f.connection.db.transaction(tx => tx.execute(sql`select 4`));
    expect(f.commands).toEqual(['select 2', 'SELECT 1', 'begin', 'select 3', 'commit', 'begin', 'select 4', 'commit']);
    expect(f.resources).toHaveLength(4);
    expect(f.resources.every(resource => resource.release.mock.calls.length === 1)).toBe(true);
    expect(f.connection.diagnostics()).toMatchObject({ active: 0, waiting: 0, admitted: 4 });
    await f.connection.close();
  });

  it.each(['begin', 'commit', 'rollback'])('discards and releases the lease when %s fails, then recovers', async failed => {
    const f = fixture(); f.failures.add(failed);
    await expect(f.connection.transaction(async () => {
      if (failed === 'rollback') throw new Error('synthetic business failure');
      return true;
    })).rejects.toMatchObject({ cause: { message: 'synthetic driver failure' } });
    expect(f.resources[0].destroy).toHaveBeenCalledExactlyOnceWith();
    expect(f.resources[0].release).toHaveBeenCalledExactlyOnceWith();
    expect(f.connection.diagnostics().active).toBe(0);
    f.failures.clear();
    await f.connection.ping();
    expect(f.resources[1].destroy).not.toHaveBeenCalled();
    await f.connection.close();
  });

  it('rolls back a callback failure before discarding and releasing the connection', async () => {
    const f = fixture();
    const cause = new Error('synthetic business failure');
    await expect(f.connection.transaction(async () => { throw cause; })).rejects.toBe(cause);
    expect(f.commands).toEqual(['begin', 'rollback']);
    expect(f.resources[0].destroy).toHaveBeenCalledTimes(1);
    expect(f.resources[0].release).toHaveBeenCalledTimes(1);
    await f.connection.close();
  });

  it('does not lend a connection again after a direct command fails', async () => {
    const f = fixture(); f.failures.add('SELECT 1');
    await expect(f.connection.ping()).rejects.toThrow();
    expect(f.resources[0].destroy).toHaveBeenCalledTimes(1);
    expect(f.resources[0].release).toHaveBeenCalledTimes(1);
    f.failures.clear(); await f.connection.ping();
    expect(f.connection.diagnostics().active).toBe(0);
    await f.connection.close();
  });

  it('queues a direct read behind a transaction, rejects overflow and executes no SQL for expired work', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: () => void;
    const running = f.connection.transaction(() => new Promise<void>(resolve => { finish = resolve; }));
    await vi.waitFor(() => expect(f.commands).toEqual(['begin']));
    const queued = f.connection.db.execute(sql`select 8`);
    const expired = expect(queued).rejects.toMatchObject({ cause: { code: 'DB_WAIT_TIMEOUT' } });
    await expect(f.connection.ping()).rejects.toMatchObject({ code: 'DB_BUSY' });
    await vi.advanceTimersByTimeAsync(101); await expired;
    finish(); await running;
    expect(f.commands).toEqual(['begin', 'commit']);
    expect(f.connection.diagnostics()).toMatchObject({ active: 0, waiting: 0, timedOut: 1, busy: 1 });
    await f.connection.ping(); await f.connection.close();
  });

  it('closes admission immediately but drains the running transaction before closing the driver', async () => {
    const f = fixture(); let finish!: () => void;
    const running = f.connection.transaction(() => new Promise<void>(resolve => { finish = resolve; }));
    await vi.waitFor(() => expect(f.commands).toEqual(['begin']));
    const queued = f.connection.ping();
    const closed = expect(queued).rejects.toMatchObject({ code: 'DB_CLOSED' });
    const stopping = f.connection.close();
    expect(f.connection.close()).toBe(stopping);
    await closed;
    expect(f.pool.end).not.toHaveBeenCalled();
    await expect(f.connection.ping()).rejects.toMatchObject({ code: 'DB_CLOSED' });
    finish(); await running; await stopping;
    expect(f.pool.end).toHaveBeenCalledTimes(1);
    expect(f.commands).toEqual(['begin', 'commit']);
  });

  it('destroys a connection if its public release throws and still drains the gate', async () => {
    const f = fixture();
    await f.connection.transaction(async () => { f.resources[0].release.mockImplementation(() => { throw new Error('synthetic release failure'); }); });
    expect(f.resources[0].destroy).toHaveBeenCalledTimes(1);
    expect(f.connection.diagnostics().active).toBe(0);
    await f.connection.close();
  });
});
