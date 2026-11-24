import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createApp } from '../../../app.ts';
import { hashPassword } from '../../auth/password.ts';
import { UsersFault } from '../../../modules/users/errors.ts';
import { createMemoryUsersStore } from '../../../modules/users/tests/memory-store.ts';

const configuredOrigin = 'http://localhost:3000';
const password = 'Synthetic error regression password';
const privateMarker = 'SYNTHETIC_PRIVATE_DATABASE_PASSWORD';
const period = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-24T00:00:00.000Z' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const listeners: ReturnType<ReturnType<typeof createApp>['listen']>[] = [];
let passwordHash = '';
beforeAll(async () => { passwordHash = await hashPassword(password); });
afterEach(async () => {
  for (const listener of listeners.splice(0)) if (listener.listening) { const closed = once(listener, 'close'); listener.close(); await closed; }
  vi.restoreAllMocks();
});
async function serve(options: Parameters<typeof createApp>[0] = {}) {
  const listener = createApp(options).listen(0, '127.0.0.1'); listeners.push(listener); await once(listener, 'listening');
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture listener.');
  return `http://127.0.0.1:${address.port}`;
}
function reference(response: Response, body: any) {
  const requestId = body.error?.data?.requestId ?? body.requestId;
  expect(requestId).toMatch(uuid);
  expect(response.headers.get('x-request-id')).toBe(requestId);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toContain('application/json');
  const messageKey = body.error?.data?.messageKey ?? body.messageKey;
  expect(typeof messageKey).toBe('string'); expect(messageKey.length).toBeGreaterThan(0);
  return requestId as string;
}
function sensitiveError() {
  return Object.assign(new Error(`mysql://private-user:${privateMarker}@private.invalid/madar`), {
    code: 'ER_ACCESS_DENIED_ERROR', sql: `SELECT '${privateMarker}'`, cause: { code: 'ETIMEDOUT', stack: privateMarker },
  });
}

test('all six service boundaries return one safe classified log and the same server-owned reference in header and error body', async () => {
  const sink = vi.spyOn(console, 'error').mockImplementation(() => {});
  const broken = { async transaction(): Promise<never> { throw sensitiveError(); } };
  const origin = await serve({ authStore: broken, usersStore: broken, permissionOverridesStore: broken, organizationStore: broken,
    numberingSettingsStore: broken, auditStore: broken, authConfig: { origin: configuredOrigin, secret: 'synthetic-errors-secret-'.repeat(3) } });
  const endpoints = [
    ['auth.session', undefined, 'AUTH_UNAVAILABLE'], ['users.list', undefined, 'USERS_UNAVAILABLE'],
    ['permissionOverrides.list', undefined, 'OVERRIDES_UNAVAILABLE'], ['organization.listBranches', undefined, 'ORG_UNAVAILABLE'],
    ['numberingSettings.list', undefined, 'NUMBERING_UNAVAILABLE'], ['audit.list', period, 'AUDIT_UNAVAILABLE'],
  ] as const;
  for (const [path, input, expected] of endpoints) {
    const before = sink.mock.calls.length; const clientId = randomUUID();
    const response = await fetch(`${origin}/api/trpc/${path}${input ? '?input=' + encodeURIComponent(JSON.stringify(input)) : ''}`, {
      headers: { 'x-request-id': clientId, cookie: `unknown=${privateMarker}` },
    });
    const body = await response.json();
    expect(response.status).toBe(503); expect(body.error.message).toBe(expected);
    const requestId = reference(response, body); expect(requestId).not.toBe(clientId);
    expect(sink.mock.calls.length - before).toBe(1);
    const emitted = JSON.stringify(sink.mock.calls.slice(before));
    expect(emitted).toContain(requestId);
    expect(emitted).not.toMatch(new RegExp(`${privateMarker}|private-user|private.invalid|SELECT|mysql://|cookie|stack|sqlMessage`, 'i'));
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${privateMarker}|mysql://|private.invalid|SELECT|stack|sqlMessage`, 'i'));
  }
});

test('body syntax, size and media errors remain precise before any authentication-store access', async () => {
  const sink = vi.spyOn(console, 'error').mockImplementation(() => {});
  let storeCalls = 0;
  const broken = { async transaction(): Promise<never> { storeCalls++; throw sensitiveError(); } };
  const origin = await serve({ authStore: broken, authConfig: { origin: configuredOrigin, secret: 'synthetic-parser-secret-'.repeat(3) } });
  const clientId = randomUUID();
  const cases = [
    { type: 'application/json', body: `{"password":"${privateMarker}"`, status: 400, code: 'PARSE_ERROR' },
    { type: 'application/json', body: JSON.stringify({ password: privateMarker.repeat(600) }), status: 413, code: 'PAYLOAD_TOO_LARGE' },
    { type: 'text/plain', body: JSON.stringify({ password: privateMarker }), status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  ];
  for (const item of cases) {
    const response = await fetch(`${origin}/api/trpc/auth.login`, { method: 'POST', headers: {
      'content-type': item.type, origin: configuredOrigin, 'x-request-id': clientId,
    }, body: item.body });
    const body = await response.json();
    expect(response.status).toBe(item.status);
    expect(body.error?.message ?? body.code).toBe(item.code);
    expect(reference(response, body)).not.toBe(clientId);
    expect(JSON.stringify(body)).not.toContain(privateMarker);
  }
  expect(storeCalls).toBe(0);
  expect(JSON.stringify(sink.mock.calls)).not.toContain(privateMarker);
});

test('validation and unknown paths have traceable safe errors without trusting client references or dumping query values', async () => {
  const sink = vi.spyOn(console, 'error').mockImplementation(() => {});
  const origin = await serve(); const clientId = randomUUID();
  const invalid = await fetch(`${origin}/api/trpc/audit.list?input=${encodeURIComponent(JSON.stringify({ from: privateMarker, to: privateMarker }))}`, { headers: { 'x-request-id': clientId } });
  const invalidBody = await invalid.json();
  expect(invalid.status).toBe(400); expect(reference(invalid, invalidBody)).not.toBe(clientId);
  expect(JSON.stringify(invalidBody)).not.toContain(privateMarker);
  for (const path of [`/unknown?password=${privateMarker}`, `/api/trpc/unknown?password=${privateMarker}`]) {
    const response = await fetch(origin + path, { headers: { 'x-request-id': clientId } }); const body = await response.json();
    expect(response.status).toBe(404); reference(response, body);
    expect(body.error?.message ?? body.code).toBe('NOT_FOUND'); expect(JSON.stringify(body)).not.toContain(privateMarker);
  }
  expect(JSON.stringify(sink.mock.calls)).not.toContain(privateMarker);
});

test('a denied current-password confirmation retains401 semantics, preserves the session and links its durable audit to the error reference', async () => {
  const roleId = randomUUID(); const hrRoleId = randomUUID();
  const store = createMemoryUsersStore([{ id: randomUUID(), username: 'ADMIN', roleId, roleCode: 'system_admin', passwordHash,
    accountStatus: 'active', mustChangePassword: false, authVersion: 1, rolePermissions: ['users.manage'], overrides: [] }], [
    { id: roleId, code: 'system_admin', name: 'System admin', permissions: ['users.manage'] },
    { id: hrRoleId, code: 'hr', name: 'HR', permissions: [] },
  ]);
  const origin = await serve({ authStore: store, usersStore: store, authConfig: { origin: configuredOrigin, secret: 'synthetic-link-secret-'.repeat(3) } });
  let cookie = ''; let csrf = '';
  const send = async (path: string, input?: unknown, mutation = false) => {
    const response = await fetch(`${origin}/api/trpc/${path}`, { method: mutation ? 'POST' : 'GET', headers: {
      cookie, origin: configuredOrigin, ...(mutation ? { 'content-type': 'application/json', 'x-madar-csrf': csrf } : {}),
    }, ...(mutation ? { body: JSON.stringify(input) } : {}) });
    const body = await response.json(); const next = response.headers.get('set-cookie'); if (next) cookie = next.split(';')[0];
    if (body.result?.data?.csrfToken) csrf = body.result.data.csrfToken; return { response, body };
  };
  await send('auth.session'); expect((await send('auth.login', { username: 'ADMIN', password }, true)).response.status).toBe(200);
  const rejected = await send('users.create', { username: 'MustNotCreate', roleId: hrRoleId, currentPassword: 'Synthetic wrong confirmation' }, true);
  expect(rejected.response.status).toBe(401); expect(rejected.body.error.message).toBe('USERS_REAUTH_FAILED');
  const requestId = reference(rejected.response, rejected.body);
  expect(store.events.at(-1)).toMatchObject({ action: 'users.create', result: 'denied', reasonCode: 'USERS_REAUTH_FAILED', requestId });
  expect((await send('auth.session')).body.result.data.state).toBe('authenticated');
  expect(store.users.size).toBe(1);
});

test('forged fault reasons and request references cannot escape the error allowlist', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const attackerId = randomUUID(); const fault = new UsersFault('USERS_UNAVAILABLE', attackerId);
  Object.defineProperty(fault, 'reason', { value: privateMarker });
  const broken = { async transaction(): Promise<never> { throw fault; } };
  const origin = await serve({ authStore: broken, usersStore: broken, authConfig: { origin: configuredOrigin, secret: 'synthetic-forged-secret-'.repeat(3) } });
  const response = await fetch(`${origin}/api/trpc/users.list`, { headers: { 'x-request-id': attackerId } }); const body = await response.json();
  expect(response.status).toBe(503); expect(body.error.message).toBe('USERS_UNAVAILABLE');
  expect(reference(response, body)).not.toBe(attackerId); expect(JSON.stringify(body)).not.toContain(privateMarker);
});

test('a throwing technical-log sink cannot change the HTTP result or start recursive logging', async () => {
  const sink = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error(privateMarker); });
  const broken = { async transaction(): Promise<never> { throw sensitiveError(); } };
  const origin = await serve({ authStore: broken, authConfig: { origin: configuredOrigin, secret: 'synthetic-sink-secret-'.repeat(3) } });
  const response = await fetch(`${origin}/api/trpc/auth.session`); const body = await response.json();
  expect(response.status).toBe(503); reference(response, body);
  expect(body.error.message).toBe('AUTH_UNAVAILABLE'); expect(sink).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(body)).not.toContain(privateMarker);
});
