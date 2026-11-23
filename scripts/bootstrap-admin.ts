import { openDatabase } from '../server/core/database/connection.ts';
import { hashPassword } from '../server/core/auth/password.ts';
import { bootstrapAdmin } from '../server/modules/auth/bootstrap.ts';
import { BootstrapConfigError, readBootstrapConfig } from '../server/modules/auth/bootstrap-config.ts';

let database: ReturnType<typeof openDatabase> | undefined;
try {
  const { databaseUrl, password } = readBootstrapConfig(process.env);
  // Remove the source secret from the process environment; never log it or pass it in argv.
  delete process.env.MADAR_ADMIN_PASSWORD;
  const passwordHash = await hashPassword(password);
  database = openDatabase(databaseUrl, process.env.DATABASE_TLS_CA_PEM);
  const result = await bootstrapAdmin(database, passwordHash);
  console.info(result.status === 'created'
    ? 'ADMIN was initialized. The temporary password must be changed on first sign-in.'
    : 'ADMIN is already initialized. No credentials or permission grants were changed.');
} catch (error) {
  console.error(error instanceof BootstrapConfigError
    ? error.message
    : 'Administrator setup could not complete. Check the private configuration and database access.');
  process.exitCode = 1;
} finally {
  try { await database?.close(); } catch {
    console.error('Administrator setup could not close its database connection cleanly.');
    process.exitCode = 1;
  }
}
