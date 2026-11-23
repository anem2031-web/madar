import { drizzle } from 'drizzle-orm/mysql2';
import { createPool } from 'mysql2/promise';

export function openDatabase(connectionString: string, ca?: string) {
  const url = new URL(connectionString);
  if (url.protocol !== 'mysql:' || !url.hostname || !url.username || !url.password || url.pathname.length < 2) {
    throw new Error('Invalid database configuration.');
  }

  const database = drizzle(createPool({
    host: url.hostname,
    port: url.port ? Number(url.port) : 4000,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    connectTimeout: 3_000,
    connectionLimit: 5,
    waitForConnections: false,
    timezone: 'Z',
    ssl: { ca, minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true },
  }));

  return {
    db: database,
    transaction: database.transaction.bind(database),
    async ping() {
      await database.$client.query({ sql: 'SELECT 1', timeout: 2_000 });
    },
    close: () => database.$client.end(),
  };
}

export type DatabaseConnection = ReturnType<typeof openDatabase>;
export type DatabaseTransaction = Parameters<Parameters<DatabaseConnection['transaction']>[0]>[0];
