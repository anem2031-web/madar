import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { hashPassword } from '../../auth/password.ts';
import { createAuthService } from '../../../modules/auth/service.ts';
import type { AuthRequest, AuthResult } from '../../../modules/auth/service.ts';
import type { AuthUser } from '../../../modules/auth/store.ts';
import { numberingFormat, numberingPaddingWidth } from '../../../../shared/numbering/settings.ts';
import type { NumberingSeries } from '../../../../shared/numbering/settings.ts';
import { createNumberingSettingsService } from '../service.ts';
import { createMemoryNumberingStore } from './memory-store.ts';

const password = 'Synthetic numbering service password';
let passwordHash = '';
beforeAll(async () => { passwordHash = await hashPassword(password); });
const creation = { code: 'FswDocument', prefix: 'Fsw', resetPolicy: 'annual' as const, enabled: true };
const series = (overrides: Partial<NumberingSeries> = {}): NumberingSeries => ({ id: randomUUID(), ...creation,
  format: numberingFormat, paddingWidth: numberingPaddingWidth, version: 1, hasIssued: false, ...overrides });

function fixture(options: { grant?: boolean; temporary?: boolean; records?: NumberingSeries[] } = {}) {
  const actor: AuthUser = { id: randomUUID(), username: 'ADMIN', passwordHash, roleId: randomUUID(), roleCode: options.grant === false ? 'hr' : 'system_admin',
    accountStatus: 'active', mustChangePassword: options.temporary ?? false, authVersion: 1,
    rolePermissions: options.grant === false ? [] : ['settings.manage'], overrides: [] };
  const store = createMemoryNumberingStore([actor], options.records);
  const now = () => new Date('2026-12-31T21:00:00.000Z');
  const auth = createAuthService(store, { origin: 'http://localhost:3000', secret: 'synthetic-numbering-secret-'.repeat(3), now });
  const service = createNumberingSettingsService(store, auth, { now });
  async function login() {
    let request: AuthRequest = { origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID() };
    const accept = (result: AuthResult) => { request = { ...request, token: result.token ?? request.token, csrf: result.view.csrfToken }; };
    accept(await auth.session(request));
    accept(await auth.login(request, { username: actor.username, password }));
    return request;
  }
  return { actor, store, service, auth, login };
}

test('settings.manage controls reads and writes without relying on ADMIN, role name or organization.read', async () => {
  const f = fixture({ grant: false }); const request = await f.login();
  await expect(f.service.list(request)).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  await expect(f.service.create(request, creation)).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'settings.manage', effect: 'grant' }];
  expect((await f.service.create(request, creation)).series.code).toBe(creation.code);
  f.store.users.get(f.actor.id)!.roleCode = 'system_admin';
  f.store.users.get(f.actor.id)!.rolePermissions = ['settings.manage'];
  f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'settings.manage', effect: 'deny' }];
  await expect(f.service.list(request)).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(f.store.events.at(-1)).toMatchObject({ actorUserId: f.actor.id, actorRoleCode: 'system_admin', result: 'denied' });
});

test('temporary and unauthenticated sessions cannot read or create settings', async () => {
  const f = fixture({ temporary: true }); const request = await f.login();
  await expect(f.service.list(request)).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  await expect(f.service.create(request, creation)).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  const anonymous = fixture();
  const initial: AuthRequest = { origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID() };
  const preauth = await anonymous.auth.session(initial);
  await expect(anonymous.service.create({ ...initial, token: preauth.token, csrf: preauth.view.csrfToken }, creation)).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
  expect(anonymous.store.series.size).toBe(0);
});

test('creation preserves trimmed ASCII code and fixes format, padding and initial version without issuing a number', async () => {
  const f = fixture(); const request = await f.login();
  const result = await f.service.create(request, { ...creation, code: '  Case_Code-1  ' });
  expect(result.series).toMatchObject({ code: 'Case_Code-1', prefix: 'Fsw', format: numberingFormat,
    paddingWidth: 4, version: 1, hasIssued: false, enabled: true, resetPolicy: 'annual' });
  expect(f.store.issued.size).toBe(0);
  expect(f.store.events.at(-1)).toMatchObject({ result: 'success', entityId: result.series.id, entityVersion: 1 });
  expect(JSON.stringify([result, f.store.events])).not.toMatch(/passwordHash|scrypt\$|tokenHash/);
});

test('listing is bounded with non-overlapping cursor pages, one event per request and Riyadh calendar year', async () => {
  const records = Array.from({ length: 29 }, (_, index) => series({ id: randomUUID(), code: `Doc${index}`, prefix: `A${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`, hasIssued: index === 0 }));
  const f = fixture({ records }); const request = await f.login();
  const before = f.store.events.length;
  const first = await f.service.list(request);
  expect(first.calendarYear).toBe(2027);
  expect(first.series).toHaveLength(25);
  expect(first.nextCursor).toBeTruthy();
  const second = await f.service.list(request, { cursor: first.nextCursor });
  expect(second.series).toHaveLength(4);
  expect(second.nextCursor).toBeUndefined();
  expect(new Set([...first.series, ...second.series].map(record => record.id)).size).toBe(29);
  expect([...first.series, ...second.series].filter(record => record.hasIssued)).toHaveLength(1);
  expect(f.store.events.length - before).toBe(2);
});

test('code and prefix remain reserved for disabled series while code case remains distinct', async () => {
  const f = fixture({ records: [series({ enabled: false, code: 'SameCode' })] }); const request = await f.login();
  await expect(f.service.create(request, { ...creation, code: 'SameCode', prefix: 'Abc' })).rejects.toMatchObject({ reason: 'NUMBERING_DUPLICATE_CODE' });
  await expect(f.service.create(request, { ...creation, code: 'OtherCode' })).rejects.toMatchObject({ reason: 'NUMBERING_DUPLICATE_PREFIX' });
  const lower = await f.service.create(request, { ...creation, code: 'samecode', prefix: 'Abc' });
  expect(lower.series.code).toBe('samecode');
  expect(f.store.series.size).toBe(2);
  expect(f.store.events.filter(event => event.result === 'denied')).toHaveLength(2);
});

test('issued configurations are frozen but enabled may change and no-op saves do not increment version', async () => {
  const record = series({ hasIssued: true }); const f = fixture({ records: [record] }); const request = await f.login();
  const update = { seriesId: record.id, expectedVersion: 1, prefix: record.prefix, resetPolicy: record.resetPolicy, enabled: false };
  await expect(f.service.update(request, { ...update, prefix: 'Abc' })).rejects.toMatchObject({ reason: 'NUMBERING_LOCKED' });
  await expect(f.service.update(request, { ...update, resetPolicy: 'continuous' })).rejects.toMatchObject({ reason: 'NUMBERING_LOCKED' });
  const disabled = await f.service.update(request, update);
  expect(disabled).toMatchObject({ changed: true, series: { id: record.id, enabled: false, version: 2, hasIssued: true, prefix: record.prefix } });
  const unchanged = await f.service.update(request, { ...update, expectedVersion: 2 });
  expect(unchanged.changed).toBe(false);
  expect(unchanged.series.version).toBe(2);
  expect(f.store.events.at(-1)).toMatchObject({ entityVersion: 2, metadata: { changed: false } });
  expect(f.store.issued.has(record.id)).toBe(true);
  expect((await f.auth.session(request)).view.state).toBe('authenticated');
  expect(f.store.users.get(f.actor.id)!.authVersion).toBe(1);
});

test('competing creates leave one reserved prefix and a single safe duplicate denial', async () => {
  const f = fixture(); const request = await f.login();
  const results = await Promise.allSettled([
    f.service.create(request, { ...creation, code: 'RaceOne' }),
    f.service.create(request, { ...creation, code: 'RaceTwo' }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ reason: 'NUMBERING_DUPLICATE_PREFIX' });
  expect(f.store.series.size).toBe(1);
  const events = f.store.events.filter(event => event.action === 'numbering.series.create');
  expect(events.filter(event => event.result === 'success')).toHaveLength(1);
  expect(events.filter(event => event.result === 'denied')).toHaveLength(1);
});

test('before issuance prefix and reset policy can change, and stale or competing versions cannot overwrite', async () => {
  const record = series(); const f = fixture({ records: [record] }); const request = await f.login();
  const update = { seriesId: record.id, expectedVersion: 1, prefix: 'Abc', resetPolicy: 'continuous' as const, enabled: true };
  const results = await Promise.allSettled([f.service.update(request, update), f.service.update(request, { ...update, prefix: 'Def' })]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  expect(failed.reason).toMatchObject({ reason: 'NUMBERING_CONFLICT' });
  expect(f.store.series.get(record.id)!.version).toBe(2);
  expect(f.store.series.get(record.id)!.resetPolicy).toBe('continuous');
});

test('toggling an issued legacy series preserves its exact prefix, format and padding bytes', async () => {
  const record = series({ prefix: ' OLD ', format: '{PREFIX}/{YYYY}/{SEQ}', paddingWidth: 6, hasIssued: true });
  const f = fixture({ records: [record] }); const request = await f.login();
  const result = await f.service.update(request, { seriesId: record.id, expectedVersion: 1,
    prefix: record.prefix, resetPolicy: record.resetPolicy, enabled: false });
  expect(result.series).toMatchObject({ prefix: ' OLD ', format: '{PREFIX}/{YYYY}/{SEQ}', paddingWidth: 6, enabled: false, version: 2 });
  expect(f.store.series.get(record.id)).toMatchObject({ prefix: record.prefix, format: record.format, paddingWidth: record.paddingWidth });
});

test('missing targets, version overflow and a newly committed permission denial reject before mutation', async () => {
  const record = series({ version: 4_294_967_295 }); const f = fixture({ records: [record] }); const request = await f.login();
  const update = { seriesId: record.id, expectedVersion: record.version, prefix: record.prefix, resetPolicy: record.resetPolicy, enabled: false };
  await expect(f.service.update(request, { ...update, seriesId: randomUUID() })).rejects.toMatchObject({ reason: 'NUMBERING_NOT_FOUND' });
  await expect(f.service.update(request, update)).rejects.toMatchObject({ reason: 'NUMBERING_CONFLICT' });
  f.store.setBeforeTransaction(() => { f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'settings.manage', effect: 'deny' }]; });
  await expect(f.service.create(request, creation)).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(f.store.series.size).toBe(1);
});

test('audit or write failure rolls back every settings change without touching issuance history', async () => {
  const record = series({ hasIssued: true }); const f = fixture({ records: [record] }); const request = await f.login();
  for (const failure of ['audit', 'write'] as const) {
    if (failure === 'audit') f.store.setAuditFailure(true); else f.store.setWriteFailure(true);
    try {
      await expect(f.service.create(request, { ...creation, code: 'Rollback', prefix: 'Abc' })).rejects.toThrow();
      await expect(f.service.update(request, { seriesId: record.id, expectedVersion: 1, prefix: record.prefix, resetPolicy: record.resetPolicy, enabled: false })).rejects.toThrow();
      expect(f.store.series.size).toBe(1);
      expect(f.store.series.get(record.id)).toMatchObject({ enabled: true, version: 1 });
      expect(f.store.issued.has(record.id)).toBe(true);
    } finally { f.store.setAuditFailure(false); f.store.setWriteFailure(false); }
  }
});
