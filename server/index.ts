import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { readRuntimeConfig } from './config/env.ts';
import { openDatabase } from './core/database/connection.ts';
import { createAuthStore } from './modules/auth/repository.ts';
import { createUsersStore } from './modules/users/repository.ts';

try {
  const config = readRuntimeConfig(process.env);
  const database = config.mode === 'connected' ? openDatabase(config.databaseUrl, config.databaseCa) : undefined;
  const clientDirectory = process.argv.includes('--api-only')
    ? undefined
    : fileURLToPath(new URL('../client/', import.meta.url));

  const server = createApp({ clientDirectory, pingDatabase: database?.ping,
    authStore: database ? createAuthStore(database) : undefined,
    authConfig: config.mode === 'connected' ? config.authConfig : undefined,
    usersStore: database ? createUsersStore(database) : undefined,
  });
  const listener = server.listen(config.port, config.host, () => {
    console.info(`Madar listening on ${config.host}:${config.port} (${config.mode})`);
  });
  listener.once('error', () => {
    console.error('Madar could not start listening.');
    process.exitCode = 1;
    void database?.close().catch(() => {});
  });

  const stop = () => {
    listener.close(async () => {
      try {
        await database?.close();
      } catch {
        console.error('Madar could not close its database connection cleanly.');
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch {
  console.error('Madar could not load its runtime configuration.');
  process.exitCode = 1;
}
