export function readRuntimeConfig(env: NodeJS.ProcessEnv) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Invalid port.');
  }

  const mode = env.MADAR_RUNTIME_MODE ?? 'local';
  if (mode === 'local') {
    return { mode, port, host: '127.0.0.1' } as const;
  }
  const databaseUrl = env.DATABASE_URL;
  if (mode !== 'connected' || !databaseUrl) {
    throw new Error('Invalid runtime configuration.');
  }
  const appOrigin = env.APP_ORIGIN;
  const authSecret = env.AUTH_SECRET;
  if (!appOrigin || !authSecret || authSecret.length < 32) throw new Error('Invalid authentication configuration.');
  const origin = new URL(appOrigin);
  if (origin.origin !== appOrigin || origin.username || origin.password) throw new Error('Invalid application origin.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback && env.NODE_ENV !== 'production')) throw new Error('Invalid application origin.');
  return {
    mode,
    port,
    host: '0.0.0.0',
    databaseUrl,
    databaseCa: env.DATABASE_TLS_CA_PEM,
    authConfig: { origin: appOrigin, secret: authSecret },
  } as const;
}
