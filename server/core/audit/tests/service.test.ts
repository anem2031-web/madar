import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { hashPassword } from '../../auth/password.ts';
import { createAuthService } from '../../../modules/auth/service.ts';
import type { AuthRequest, AuthResult } from '../../../modules/auth/service.ts';
import type { AuthUser } from '../../../modules/auth/store.ts';
import { createAuditService } from '../service.ts';
import { createMemoryAuditStore, memoryAuditEvent } from './memory-store.ts';

const password = 'Synthetic audit reader password';
const period = { from: '2026-11-23T00:00:00.000Z', to: '2026-11-25T00:00:00.000Z' };
let passwordHash = '';
beforeAll(async () => { passwordHash = await hashPassword(password); });
function fixture(granted = true, temporary = false) {
  const actor: AuthUser = { id: randomUUID(), username: 'ADMIN', passwordHash, roleId: randomUUID(), roleCode: granted ? 'system_admin' : 'hr',
    accountStatus: 'active', mustChangePassword: temporary, authVersion: 1, rolePermissions: granted ? ['audit.read'] : [], overrides: [] };
  const store = createMemoryAuditStore([actor]);
  const now = () => new Date('2026-11-24T12:00:00Z');
  const auth = createAuthService(store, { origin: 'http://localhost:3000', secret: 'synthetic-audit-secret-'.repeat(3), now });
  const audit = createAuditService(store, auth, { now });
  async function login() {
    let request: AuthRequest = { origin: 'http://localhost:3000', peer: '127.0.0.1', requestId: randomUUID() };
    const accept = (value: AuthResult) => { request = { ...request, token: value.token ?? request.token, csrf: value.view.csrfToken }; };
    accept(await auth.session(request)); accept(await auth.login(request, { username: actor.username, password })); return request;
  }
  return { actor, store, audit, auth, login };
}

test('audit.read honors explicit grants and denies and requires a full session for every read', async () => {
  const f = fixture(false); const request = await f.login();
  await expect(f.audit.list(request, period)).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'audit.read', effect: 'grant' }];
  expect((await f.audit.list(request, period)).events).toEqual([]);
  f.store.users.get(f.actor.id)!.roleCode = 'system_admin';
  f.store.users.get(f.actor.id)!.rolePermissions = ['audit.read'];
  f.store.users.get(f.actor.id)!.overrides = [{ permissionCode: 'audit.read', effect: 'deny' }];
  await expect(f.audit.detail(request, { eventId: randomUUID() })).rejects.toMatchObject({ reason: 'AUTH_FORBIDDEN' });
  expect(f.store.events.at(-1)).toMatchObject({ actorUserId: f.actor.id, actorRoleCode: 'system_admin', module: 'audit', result: 'denied' });
  const temporary = fixture(true, true);
  await expect(temporary.audit.list(await temporary.login(), period)).rejects.toMatchObject({ reason: 'AUTH_REQUIRED' });
});

test('equal-time cursor pages have stable descending keys and one audit event per request', async () => {
  const f = fixture(); const request = await f.login();
  const records = Array.from({ length: 35 }, (_, index) => memoryAuditEvent({ eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` }));
  f.store.seedEvents(records);
  const countBefore = f.store.events.length;
  const first = await f.audit.list(request, period);
  expect(first.events).toHaveLength(25);
  const second = await f.audit.list(request, { ...period, cursor: first.nextCursor });
  expect(second.events).toHaveLength(10);
  expect(second.nextCursor).toBeUndefined();
  const ids = [...first.events, ...second.events].map(event => event.eventId);
  expect(new Set(ids).size).toBe(35);
  expect(ids).toEqual(records.map(event => event.eventId).reverse());
  expect(first.events[0].occurredAt).toBe('2026-11-24T10:00:00.000Z');
  expect(first.events[0]).not.toHaveProperty('beforeValues');
  expect(f.store.events.length - countBefore).toBe(2);
  expect(f.store.events.at(-1)).toMatchObject({ action: 'audit.list', metadata: { count: 10, filterTypes: ['period'] } });
  expect(f.store.deliveredEvents.size).toBe(35);
});

test('period, actor, module and result filters apply together without dropping null historical actors', async () => {
  const f = fixture(); const request = await f.login();
  const actorId = randomUUID();
  const wanted = memoryAuditEvent({ actorUserId: actorId, result: 'denied' });
  const anonymous = memoryAuditEvent({ actorUserId: null, actorRoleId: null, actorRoleCode: null });
  f.store.seedEvents([wanted, anonymous, memoryAuditEvent({ actorUserId: actorId }), memoryAuditEvent({ actorUserId: actorId, module: 'users' }),
    memoryAuditEvent({ actorUserId: actorId, result: 'denied', occurredAt: '2026-10-01 10:00:00.000' })]);
  const result = await f.audit.list(request, { ...period, actorUserId: actorId, module: 'organization', result: 'denied' });
  expect(result.events.map(event => event.eventId)).toEqual([wanted.eventId]);
  expect(f.store.events.at(-1)).toMatchObject({ metadata: { count: 1, filterTypes: ['period', 'actorUserId', 'module', 'result'] } });
  expect((await f.audit.list(request, period)).events.some(event => event.eventId === anonymous.eventId)).toBe(true);
});

test('details preserve known NULL changes and omit legacy metadata while rejecting unsafe JSON without a protected response', async () => {
  const f = fixture(); const request = await f.login();
  const legacy = memoryAuditEvent({ beforeValues: { roleId: null, overrides: null }, afterValues: { enabled: false },
    metadata: { source: 'authorized_local_recovery', revokedSessions: 2, changed: true } });
  f.store.seedEvents([legacy]);
  const result = await f.audit.detail(request, { eventId: legacy.eventId });
  expect(result.event.beforeValues).toEqual({ roleId: null, overrides: null });
  expect(result.event.metadata).toEqual({ changed: true });
  expect(result.event).not.toHaveProperty('deliveryState');
  const legacyOnly = memoryAuditEvent({ metadata: { source: 'authorized_local_recovery', revokedSessions: 2 } });
  const falseValues = memoryAuditEvent({ metadata: { count: 0, changed: false } });
  f.store.seedEvents([legacyOnly, falseValues]);
  expect((await f.audit.detail(request, { eventId: legacyOnly.eventId })).event.metadata).toBeNull();
  expect((await f.audit.detail(request, { eventId: falseValues.eventId })).event.metadata).toEqual({ count: 0, changed: false });
  const bad = memoryAuditEvent({ afterValues: { password: 'SYNTHETIC_MUST_NOT_EXPOSE', token: 'synthetic token' } });
  f.store.seedEvents([bad]);
  const before = f.store.events.length;
  await expect(f.audit.detail(request, { eventId: bad.eventId })).rejects.toThrow('AUDIT_UNSAFE_EVENT');
  expect(f.store.events.length).toBe(before);
  await expect(f.audit.detail(request, { eventId: randomUUID() })).rejects.toMatchObject({ reason: 'AUDIT_NOT_FOUND' });
  expect(f.store.events.at(-1)).toMatchObject({ module: 'audit', result: 'denied', reasonCode: 'AUDIT_NOT_FOUND' });
});

test('delivery status is bounded and returns safe permanent-error codes rather than private diagnostics', async () => {
  const f = fixture(); const request = await f.login();
  f.store.setDeliveryStatus({ pending: 20, leased: 1, failed: 12, oldestPendingAt: '2026-11-24 09:00:00.000',
    failures: Array.from({ length: 12 }, () => ({ eventId: randomUUID(), occurredAt: '2026-11-24 10:00:00.000', errorCode: 'Sensitive SQL connection text' })) });
  const result = await f.audit.list(request, period);
  expect(result.delivery).toMatchObject({ pending: 20, leased: 1, failed: 12, oldestPendingAt: '2026-11-24T09:00:00.000Z' });
  expect(result.delivery.failures).toHaveLength(10);
  expect(result.delivery.failures.every(failure => failure.errorCode === 'AUDIT_DELIVERY_FAILED')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('Sensitive SQL');
  f.store.setDeliveryStatus({ pending: 1, leased: 0, failed: 1, oldestPendingAt: '0000-00-00 00:00:00',
    failures: [{ eventId: 'not-a-safe-identifier', occurredAt: '2026-02-30 00:00:00', errorCode: 'Private error text' }] });
  const malformed = await f.audit.list(request, period);
  expect(malformed.delivery.oldestPendingAt).toBeNull();
  expect(malformed.delivery.failures[0]).toEqual({ eventId: 'UNKNOWN_EVENT_1', occurredAt: null, errorCode: 'AUDIT_DELIVERY_FAILED' });
});

test('read, status and durable-read-audit failures return no data and cannot leave a misleading success event', async () => {
  const f = fixture(); const request = await f.login(); const record = memoryAuditEvent(); f.store.seedEvents([record]);
  for (const fail of [f.store.setListFailure, f.store.setStatusFailure, f.store.setAuditFailure]) {
    const before = f.store.events.length; fail(true);
    try { await expect(f.audit.list(request, period)).rejects.toThrow(); expect(f.store.events.length).toBe(before); }
    finally { fail(false); }
  }
  f.store.setDetailFailure(true);
  await expect(f.audit.detail(request, { eventId: record.eventId })).rejects.toThrow();
  expect(f.store.deliveredEvents.size).toBe(1);
});
