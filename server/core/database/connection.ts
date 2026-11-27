import { drizzle } from 'drizzle-orm/mysql2';
import { createPool } from 'mysql2/promise';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { createAcquisitionManager } from './acquisition.ts';

export const databaseCapacity = { connectionLimit: 10, queueLimit: 10, acquisitionTimeoutMs: 3_000 } as const;

/** The driver pool never queues. This manager owns the only admission queue. */
export function manageDatabasePool(pool: Pick<Pool, 'getConnection' | 'end'>,
  policy: { connectionLimit: number; queueLimit: number; acquisitionTimeoutMs: number } = databaseCapacity) {
  const manager = createAcquisitionManager({
    connect: () => pool.getConnection(),
    release: (connection: PoolConnection) => {
      try { connection.release(); }
      catch { connection.destroy(); }
    },
    limit: policy.connectionLimit, queueLimit: policy.queueLimit, timeoutMs: policy.acquisitionTimeoutMs,
  });
  const runQuery = (method: 'query' | 'execute', args: unknown[]) => manager.use(async connection => {
    try { return await Reflect.apply(connection[method], connection, args); }
    catch (error) {
      // A timed-out command may still be executing on the server. Never lend it again.
      connection.destroy();
      throw error;
    }
  });
  const client = {
    query: ((...args: unknown[]) => runQuery('query', args)) as PoolConnection['query'],
    execute: ((...args: unknown[]) => runQuery('execute', args)) as PoolConnection['execute'],
  };
  // Drizzle's non-pool query contract uses these two promise methods only. Do not
  // expose the raw pool/getConnection: transactions must own the entire lease.
  const database = drizzle(client as PoolConnection);
  const transaction: typeof database.transaction = async (work, config) => {
    const lease = await manager.acquire();
    try {
      return await drizzle(lease.resource).transaction(work, config);
    } catch (error) {
      // Also covers BEGIN, COMMIT and ROLLBACK failures outside/inside Drizzle's
      // cleanup. Discard an uncertain connection rather than reusing its state.
      lease.resource.destroy();
      throw error;
    } finally { lease.release(); }
  };
  database.transaction = transaction;
  let closing: Promise<void> | undefined;
  return {
    db: database as Omit<typeof database, '$client'>,
    transaction,
    async ping() { await client.query({ sql: 'SELECT 1', timeout: 2_000 }); },
    close() { return closing ??= manager.close().then(() => pool.end()); },
    diagnostics: () => ({ ...databaseCapacity, ...policy, ...manager.stats() }),
  };
}

export function openDatabase(connectionString: string, ca?: string) {
  const url = new URL(connectionString);
  if (url.protocol !== 'mysql:' || !url.hostname || !url.username || !url.password || url.pathname.length < 2) {
    throw new Error('Invalid database configuration.');
  }

  return manageDatabasePool(createPool({
    host: url.hostname,
    port: url.port ? Number(url.port) : 4000,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    connectTimeout: 3_000,
    connectionLimit: databaseCapacity.connectionLimit,
    waitForConnections: false,
    timezone: 'Z',
    ssl: { ca, minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true },
  }));
}

export type DatabaseConnection = Pick<ReturnType<typeof openDatabase>, 'db' | 'transaction' | 'ping' | 'close'>;
export type DatabaseTransaction = Parameters<Parameters<DatabaseConnection['transaction']>[0]>[0];
