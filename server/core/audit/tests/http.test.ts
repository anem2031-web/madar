import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../../app.ts';
import { hashPassword } from '../../auth/password.ts';
import type { AuthUser } from '../../../modules/auth/store.ts';
import { createMemoryAuditStore, memoryAuditEvent } from './memory-store.ts';

const password = 'Synthetic HTTP audit password';
const configuredOrigin = 'http://localhost:3000';
const period = { from: '2026-11-23T00:00:00.000Z', to: '2026-11-25T00:00:00.000Z' };
let passwordHash = ''; let store: ReturnType<typeof createMemoryAuditStore>;
let listener: ReturnType<ReturnType<typeof createApp>['listen']>; let origin: string; let eventId: string;
beforeAll(async () => { passwordHash = await hashPassword(password); });
beforeEach(async () => {
  const user = (username: string, grant: boolean, temporary = false, overrides: AuthUser['overrides'] = []): AuthUser => ({
    id: randomUUID(), username, roleId: randomUUID(), roleCode: grant ? 'system_admin' : 'hr', passwordHash, accountStatus: 'active',
    mustChangePassword: temporary, authVersion: 1, rolePermissions: grant ? ['audit.read'] : [], overrides });
  const event = memoryAuditEvent(); eventId = event.eventId;
  store = createMemoryAuditStore([user('ADMIN', true), user('HR', false), user('TEMP', true, true),
    user('DENIED', true, false, [{ permissionCode: 'audit.read', effect: 'deny' }]), user('DELEGATED', false, false, [{ permissionCode: 'audit.read', effect: 'grant' }])], [event]);
  listener = createApp({ authStore: store, auditStore: store, authConfig: { origin: configuredOrigin, secret: 'synthetic-http-audit-secret-'.repeat(2) } }).listen(0, '127.0.0.1');
  await once(listener, 'listening'); const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Missing listener.');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { if (!listener?.listening) return; const closed = once(listener, 'close'); listener.close(); await closed; });
async function client(username?: string) {
  let cookie = ''; let csrf = '';
  const send = async (path: string, input?: unknown, mutation = false) => {
    const response = await fetch(`${origin}/api/trpc/${path}${!mutation && input !== undefined ? '?input=' + encodeURIComponent(JSON.stringify(input)) : ''}`, {
      method: mutation ? 'POST' : 'GET', headers: { cookie, origin: configuredOrigin, ...(mutation ? { 'content-type': 'application/json', 'x-madar-csrf': csrf } : {}) },
      ...(mutation ? { body: JSON.stringify(input) } : {}), redirect: 'manual' });
    const body = await response.json(); const next = response.headers.get('set-cookie'); if (next) cookie = next.split(';')[0];
    if (body.result?.data?.csrfToken) csrf = body.result.data.csrfToken; return { response, body };
  };
  await send('auth.session'); if (username) expect((await send('auth.login', { username, password }, true)).response.status).toBe(200);
  return { query: (path: string, input?: unknown) => send(path, input), mutate: (path: string, input: unknown) => send(path, input, true) };
}
test('audit list and detail enforce authentication and effective audit.read on direct API requests', async () => {
  for (const [username, status] of [[undefined, 401], ['HR', 403], ['TEMP', 401], ['DENIED', 403]] as const) {
    const api = await client(username);
    for (const result of [await api.query('audit.list', period), await api.query('audit.detail', { eventId })]) {
      expect(result.response.status).toBe(status); expect(result.response.headers.get('cache-control')).toBe('no-store');
      expect(result.response.headers.get('location')).toBeNull(); expect(result.body).not.toHaveProperty('result');
    }
  }
  const api = await client('DELEGATED'); expect((await api.query('audit.list', period)).response.status).toBe(200);
  expect((await api.query('audit.detail', { eventId })).response.status).toBe(200);
});
test('safe reader DTOs use ISO timestamps, reject unsupported writes and never expose unsafe detail payloads', async () => {
  const api = await client('ADMIN'); const page = await api.query('audit.list', period);
  expect(page.body.result.data.events[0].occurredAt).toBe('2026-11-24T10:00:00.000Z');
  expect(page.body.result.data.events[0]).not.toHaveProperty('beforeValues');
  expect((await api.mutate('audit.delete', { eventId })).response.status).toBe(404);
  expect((await api.mutate('audit.update', { eventId })).response.status).toBe(404);
  const unsafe = memoryAuditEvent({ metadata: { password: 'SYNTHETIC_PRIVATE_CONTENT' } }); store.seedEvents([unsafe]);
  const rejected = await api.query('audit.detail', { eventId: unsafe.eventId });
  expect(rejected.response.status).toBe(503); expect(rejected.body.error.message).toBe('AUDIT_UNAVAILABLE');
  expect(JSON.stringify(rejected.body)).not.toMatch(/PRIVATE_CONTENT|passwordHash|SQL|scrypt\$/);
  expect(rejected.body.error.data.requestId).toMatch(/^[a-f0-9-]{36}$/);
});
test('invalid queries and failed durable read audit return safe errors rather than protected records', async () => {
  const api = await client('ADMIN');
  expect((await api.query('audit.list', { ...period, result: 'all' })).response.status).toBe(400);
  store.setAuditFailure(true);
  try {
    const response = await api.query('audit.list', period);
    expect(response.response.status).toBe(503); expect(response.body).not.toHaveProperty('result');
    expect(JSON.stringify(response.body)).not.toContain(password);
  } finally { store.setAuditFailure(false); }
});
