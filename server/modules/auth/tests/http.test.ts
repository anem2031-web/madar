import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createApp } from '../../../app.ts';
import { hashPassword } from '../../../core/auth/password.ts';
import { createMemoryAuthStore } from './memory-store.ts';

const password = 'A temporary secret password';
let listener: ReturnType<ReturnType<typeof createApp>['listen']>;
let origin: string;
const configuredOrigin = 'http://localhost:3000';
beforeAll(async () => {
  const store = createMemoryAuthStore([{ id: randomUUID(), username: 'ADMIN', passwordHash: await hashPassword(password),
    roleId: randomUUID(), roleCode: 'system_admin', accountStatus: 'active', mustChangePassword: true, authVersion: 1,
    rolePermissions: ['users.manage'], overrides: [] }]);
  listener = createApp({ authStore: store, authConfig: { origin: configuredOrigin, secret: 's'.repeat(48) } }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener address.');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { if (listener?.listening) { const close = once(listener, 'close'); listener.close(); await close; } });

async function initial() {
  const response = await fetch(`${origin}/api/trpc/auth.session`);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: body.result.data.csrfToken as string, response, body };
}

test('pre-authentication context uses HttpOnly cookie and is never cached', async () => {
  const result = await initial();
  expect(result.body.result.data.state).toBe('anonymous');
  expect(result.response.headers.get('cache-control')).toBe('no-store');
  expect(result.response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax');
  expect(result.body.result.data).not.toHaveProperty('token');
});

test('direct mutation requires matching Origin, cookie and CSRF header', async () => {
  const { cookie, csrf } = await initial();
  const cases: Record<string, string>[] = [
    { 'content-type': 'application/json', origin: configuredOrigin, cookie },
    { 'content-type': 'application/json', origin: 'https://evil.invalid', cookie, 'x-madar-csrf': csrf },
  ];
  for (const headers of cases) {
    const response = await fetch(`${origin}/api/trpc/auth.login`, { method: 'POST', headers, body: JSON.stringify({ username: 'ADMIN', password }) });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.message).toBe('AUTH_CSRF');
    expect(body.error.data.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(body)).not.toContain(password);
  }
});

test('valid login rotates cookie and provides only restricted temporary-password session', async () => {
  const { cookie, csrf } = await initial();
  const response = await fetch(`${origin}/api/trpc/auth.login`, { method: 'POST', headers: {
    'content-type': 'application/json', origin: configuredOrigin, cookie, 'x-madar-csrf': csrf,
  }, body: JSON.stringify({ username: ' ADMIN ', password }) });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.result.data.state).toBe('password_change');
  expect(body.result.data.user).toBeUndefined();
  expect(response.headers.get('set-cookie')!.split(';')[0]).not.toBe(cookie);
});

test('GET cannot execute login mutation and batch requests are rejected', async () => {
  const mutation = await fetch(`${origin}/api/trpc/auth.login`);
  expect(mutation.status).toBe(405);
  const batch = await fetch(`${origin}/api/trpc/auth.session,auth.session?batch=1`);
  expect(batch.status).not.toBe(200);
});
