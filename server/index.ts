import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { readRuntimeConfig } from './config/env.ts';
import { openDatabase } from './core/database/connection.ts';
import { createAuthStore } from './modules/auth/repository.ts';
import { createUsersStore } from './modules/users/repository.ts';
import { createPermissionOverridesStore } from './modules/permission-overrides/repository.ts';
import { createOrganizationStore } from './modules/organization/repository.ts';
import { createNumberingSettingsStore } from './core/numbering/repository.ts';
import { createAuditStore } from './core/audit/repository.ts';
import { createAuditDeliveryStore } from './core/audit/delivery-repository.ts';
import { createAuditDispatcher } from './core/audit/dispatcher.ts';
import { logTechnicalFailure } from './core/errors/technical-log.ts';

try {
  const config = readRuntimeConfig(process.env);
  const database = config.mode === 'connected' ? openDatabase(config.databaseUrl, config.databaseCa) : undefined;
  const auditDispatcher = database ? createAuditDispatcher(createAuditDeliveryStore(database)) : undefined;
  const clientDirectory = process.argv.includes('--api-only')
    ? undefined
    : fileURLToPath(new URL('../client/', import.meta.url));

  const server = createApp({ clientDirectory, pingDatabase: database?.ping,
    authStore: database ? createAuthStore(database) : undefined,
    authConfig: config.mode === 'connected' ? config.authConfig : undefined,
    usersStore: database ? createUsersStore(database) : undefined,
    permissionOverridesStore: database ? createPermissionOverridesStore(database) : undefined,
    organizationStore: database ? createOrganizationStore(database) : undefined,
    numberingSettingsStore: database ? createNumberingSettingsStore(database) : undefined,
    auditStore: database ? createAuditStore(database) : undefined,
  });
  const listener = server.listen(config.port, config.host);
  listener.once('listening', () => {
    auditDispatcher?.start();
    console.info(`Madar listening on ${config.host}:${config.port} (${config.mode})`);
  });
  listener.once('error', error => {
    logTechnicalFailure({ scope: 'runtime', operation: 'listen', code: 'RUNTIME_LISTEN_FAILURE', error });
    process.exitCode = 1;
    void (async () => { await auditDispatcher?.stop(); await database?.close(); })().catch(() => {});
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deliveryStopped = auditDispatcher?.stop();
    listener.close(async () => {
      try {
        await deliveryStopped;
        await database?.close();
      } catch (error) {
        logTechnicalFailure({ scope: 'runtime', operation: 'shutdown', code: 'RUNTIME_SHUTDOWN_FAILURE', error });
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  logTechnicalFailure({ scope: 'runtime', operation: 'startup', code: 'RUNTIME_CONFIG_FAILURE', error });
  process.exitCode = 1;
}
