import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../../app.ts';
import { hashPassword } from '../../auth/password.ts';
import type { AuthUser } from '../../../modules/auth/store.ts';
import { numberingFormat, numberingPaddingWidth } from '../../../../shared/numbering/settings.ts';
import { createMemoryNumberingStore } from './memory-store.ts';

const password = 'Synthetic HTTP numbering password';
const configuredOrigin = 'http://localhost:3000';
const issued = { id: randomUUID(), code: 'IssuedDocument', prefix: 'Fsw', format: numberingFormat,
  paddingWidth: numberingPaddingWidth, resetPolicy: 'annual' as const, enabled: true, version: 1, hasIssued: true };
const creation = { code: 'NewDocument', prefix: 'Abc', resetPolicy: 'annual', enabled: true };
let passwordHash = '';
let listener: ReturnType<ReturnType<typeof createApp>['listen']>;
let origin: string;
let store: ReturnType<typeof createMemoryNumberingStore>;

beforeAll(async () => { passwordHash = await hashPassword(password); });
beforeEach(async () => {
  const user = (username: string, permissions: string[], overrides: AuthUser['overrides'] = [], temporary = false): AuthUser => ({
    id: randomUUID(), username, passwordHash, roleId: randomUUID(), roleCode: username === 'HR' || username === 'SETTINGS_ONLY' ? 'hr' : 'system_admin',
    accountStatus: 'active', mustChangePassword: temporary, authVersion: 1, rolePermissions: permissions, overrides,
  });
  store = createMemoryNumberingStore([user('ADMIN', ['settings.manage']), user('HR', ['organization.read']),
    user('TEMP', ['settings.manage'], [], true), user('DENIED', ['settings.manage'], [{ permissionCode: 'settings.manage', effect: 'deny' }]),
    user('SETTINGS_ONLY', [], [{ permissionCode: 'settings.manage', effect: 'grant' }]),
  ], [issued]);
  listener = createApp({ authStore: store, numberingSettingsStore: store,
    authConfig: { origin: configuredOrigin, secret: 'synthetic-numbering-http-secret-'.repeat(2) } }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener.');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  if (!listener?.listening) return;
  const closed = once(listener, 'close'); listener.close(); await closed;
});

async function client(username?: string) {
  let cookie = '';
  let csrf = '';
  const send = async (path: string, input?: unknown, mutation = false, headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}/api/trpc/${path}${!mutation && input !== undefined ? '?input=' + encodeURIComponent(JSON.stringify(input)) : ''}`, {
      method: mutation ? 'POST' : 'GET', headers: { cookie, origin: configuredOrigin,
        ...(mutation ? { 'content-type': 'application/json', 'x-madar-csrf': csrf } : {}), ...headers },
      ...(mutation ? { body: JSON.stringify(input) } : {}), redirect: 'manual',
    });
    const body = await response.json();
    const next = response.headers.get('set-cookie');
    if (next) cookie = next.split(';')[0];
    if (body.result?.data?.csrfToken) csrf = body.result.data.csrfToken;
    return { response, body };
  };
  await send('auth.session');
  if (username) expect((await send('auth.login', { username, password }, true)).response.status).toBe(200);
  return { query: (path: string, input?: unknown) => send(path, input),
    mutate: (path: string, input: unknown, headers?: Record<string, string>) => send(path, input, true, headers) };
}

test('every settings endpoint requires full authentication and effective settings.manage, with a grant independent of organization.read', async () => {
  const update = { seriesId: issued.id, expectedVersion: 1, prefix: issued.prefix, resetPolicy: issued.resetPolicy, enabled: false };
  for (const [username, status] of [[undefined, 401], ['TEMP', 401], ['HR', 403], ['DENIED', 403]] as const) {
    const api = await client(username);
    for (const result of [await api.query('numberingSettings.list'), await api.mutate('numberingSettings.create', creation), await api.mutate('numberingSettings.update', update)]) {
      expect(result.response.status).toBe(status);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
      expect(result.response.headers.get('location')).toBeNull();
      expect(result.body).not.toHaveProperty('result');
    }
  }
  const delegated = await client('SETTINGS_ONLY');
  expect((await delegated.query('auth.session')).body.result.data.user.permissions).not.toContain('organization.read');
  expect((await delegated.query('numberingSettings.list')).response.status).toBe(200);
  expect((await delegated.mutate('numberingSettings.create', creation)).response.status).toBe(200);
});

test('real HTTP settings saves enforce uniqueness, freeze issued configuration, permit disabling and preserve no-op version', async () => {
  const api = await client('ADMIN');
  const listed = await api.query('numberingSettings.list');
  expect(listed.response.status).toBe(200);
  expect(listed.body.result.data.series).toEqual([issued]);
  expect(typeof listed.body.result.data.calendarYear).toBe('number');
  const created = await api.mutate('numberingSettings.create', creation);
  expect(created.response.status).toBe(200);
  expect(created.body.result.data.series).toMatchObject({ ...creation, version: 1, hasIssued: false, paddingWidth: 4, format: numberingFormat });
  const duplicate = await api.mutate('numberingSettings.create', { ...creation, code: 'AnotherDocument' });
  expect(duplicate.response.status).toBe(409);
  expect(duplicate.body.error.message).toBe('NUMBERING_DUPLICATE_PREFIX');
  const update = { seriesId: issued.id, expectedVersion: 1, prefix: issued.prefix, resetPolicy: issued.resetPolicy, enabled: false };
  const frozen = await api.mutate('numberingSettings.update', { ...update, prefix: 'Def' });
  expect(frozen.response.status).toBe(409);
  expect(frozen.body.error.message).toBe('NUMBERING_LOCKED');
  const disabled = await api.mutate('numberingSettings.update', update);
  expect(disabled.response.status).toBe(200);
  expect(disabled.body.result.data).toMatchObject({ changed: true, series: { id: issued.id, version: 2, enabled: false, hasIssued: true } });
  const noop = await api.mutate('numberingSettings.update', { ...update, expectedVersion: 2 });
  expect(noop.body.result.data).toMatchObject({ changed: false, series: { version: 2 } });
  expect((await api.query('auth.session')).body.result.data.state).toBe('authenticated');
  expect(JSON.stringify([listed.body, created.body, duplicate.body, frozen.body, store.events])).not.toMatch(/scrypt\$|passwordHash|tokenHash|insert into|ER_DUP_ENTRY/);
  expect(JSON.stringify(store.events)).not.toContain(password);
});

test('CSRF, malformed prefixes, extra fields and unsupported issue or delete routes never create settings or numbers', async () => {
  const api = await client('ADMIN');
  const badHeaders: Record<string, string>[] = [{ origin: 'https://foreign.invalid' }, { 'x-madar-csrf': '' }];
  for (const headers of badHeaders) expect((await api.mutate('numberingSettings.create', creation, headers)).response.status).toBe(403);
  const invalidPrefix = await api.mutate('numberingSettings.create', { ...creation, prefix: 'FSW' });
  expect(invalidPrefix.response.status).toBe(400);
  expect(invalidPrefix.body.error.message).toBe('NUMBERING_INVALID_PREFIX');
  expect((await api.mutate('numberingSettings.create', { ...creation, hasIssued: true, lastValue: 50 })).response.status).toBe(400);
  expect((await api.query('numberingSettings.create')).response.status).toBe(405);
  expect((await api.mutate('numberingSettings.issue', {})).response.status).toBe(404);
  expect((await api.mutate('numberingSettings.delete', { seriesId: issued.id })).response.status).toBe(404);
  expect(store.series.size).toBe(1);
  expect(store.issued.size).toBe(1);
});

test('failed outbox and write transactions retain committed settings and return protected diagnostic references only', async () => {
  const api = await client('ADMIN');
  for (const failure of ['audit', 'write'] as const) {
    if (failure === 'audit') store.setAuditFailure(true); else store.setWriteFailure(true);
    try {
      const results = [await api.mutate('numberingSettings.create', creation),
        await api.mutate('numberingSettings.update', { seriesId: issued.id, expectedVersion: 1, prefix: issued.prefix, resetPolicy: issued.resetPolicy, enabled: false })];
      for (const result of results) {
        expect(result.response.status).toBe(503);
        expect(result.body.error.message).toBe('NUMBERING_UNAVAILABLE');
        expect(result.body.error.data.requestId).toMatch(/^[a-f0-9-]{36}$/);
        expect(result.response.headers.get('cache-control')).toBe('no-store');
        expect(JSON.stringify(result.body)).not.toMatch(/Synthetic|scrypt\$|passwordHash|insert into/i);
      }
      expect(store.series.size).toBe(1);
      expect(store.series.get(issued.id)).toMatchObject({ version: 1, enabled: true });
      expect(store.issued.has(issued.id)).toBe(true);
    } finally { store.setAuditFailure(false); store.setWriteFailure(false); }
  }
});
