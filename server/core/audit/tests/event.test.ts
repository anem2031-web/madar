import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { AuditEventValidationError, auditEventsEqual, canonicalAuditEvent, normalizeAuditEvent } from '../event.ts';

function event() { return { eventId: randomUUID(), occurredAt: new Date('2026-11-24T10:00:00Z'), actorUserId: randomUUID(), actorRoleId: randomUUID(),
  actorRoleCode: 'system_admin', module: 'organization', action: 'organization.branches.rename', entityId: randomUUID(), entityVersion: 2,
  requestId: randomUUID(), result: 'success', reasonCode: null, beforeValues: { version: 1, name: 'الفرع' },
  afterValues: { name: 'الاسم الجديد', version: 2 }, metadata: { changed: true, entityType: 'branch' } }; }

test('normalization preserves safe historical values and UTC milliseconds while optional database NULLs compare equally', () => {
  const source = event();
  const normalized = normalizeAuditEvent(source);
  expect(normalized.occurredAt).toBe('2026-11-24 10:00:00.000');
  const reordered = { ...normalized, afterValues: { version: 2, name: 'الاسم الجديد' }, metadata: { entityType: 'branch', changed: true } };
  expect(auditEventsEqual(source, reordered)).toBe(true);
  expect(canonicalAuditEvent({ ...source, beforeValues: undefined, afterValues: undefined, metadata: undefined, entityVersion: undefined }))
    .toBe(canonicalAuditEvent({ ...normalized, beforeValues: null, afterValues: null, metadata: null, entityVersion: null }));
  const recovery = normalizeAuditEvent({ ...source, metadata: { source: 'admin_recovery', revokedSessions: 3 } });
  expect(recovery.metadata).toEqual({ source: 'admin_recovery', revokedSessions: 3 });
  expect(auditEventsEqual(recovery, { ...recovery, metadata: { revokedSessions: 4, source: 'admin_recovery' } })).toBe(false);
});

test('safe field allowlists reject injected secrets rather than silently stripping them', () => {
  const source = event();
  for (const change of [
    { token: 'private-value' }, { metadata: { password: 'private-value' } }, { beforeValues: { passwordHash: 'private-value' } },
    { afterValues: { residencyNumber: 'private-value' } }, { metadata: { source: 'connection://private-value' } },
    { beforeValues: { overrides: [{ permissionCode: 'unsafe permission', effect: 'grant' }] } },
    { metadata: { filterTypes: ['rawSearch'] } }, { beforeValues: { version: -1 } }, { actorUserId: 'not-a-uuid' },
    { occurredAt: '2026-02-30 12:00:00.000' }, { result: 'unknown' }, { reasonCode: 'SELECT * FROM users' },
  ]) expect(() => normalizeAuditEvent({ ...source, ...change })).toThrow(AuditEventValidationError);
  expect(() => normalizeAuditEvent({ ...source, beforeValues: { name: 'x'.repeat(16_385) } })).toThrow('AUDIT_UNSAFE_EVENT');
  const getters = { ...source }; Object.defineProperty(getters, 'token', { get() { throw new Error('Getter must not run'); } });
  expect(() => normalizeAuditEvent(getters)).toThrow('AUDIT_UNSAFE_EVENT');
  const oversized = Array.from({ length: 128 }, (_, index) => ({ permissionCode: `legacy${index}.` + 'x'.repeat(80), effect: 'grant' }));
  expect(() => normalizeAuditEvent({ ...source, beforeValues: { overrides: oversized } })).toThrow('AUDIT_UNSAFE_EVENT');
});

test('write replay audit metadata accepts only a UUID and boolean without widening the secret allowlist', () => {
  const operationId = randomUUID();
  const source = { ...event(), action: 'organization.branches.create.replay', metadata: { operationId, replayed: true, entityType: 'branch' } };
  expect(normalizeAuditEvent(source).metadata).toEqual(source.metadata);
  for (const metadata of [{ operationId: 'not-a-uuid', replayed: true }, { operationId, replayed: 'yes' },
    { operationId, replayed: true, password: 'private' }]) {
    expect(() => normalizeAuditEvent({ ...source, metadata })).toThrow(AuditEventValidationError);
  }
});

test('full comparison preserves hidden permitted metadata and array ordering rather than comparing only a display projection', () => {
  const source = event();
  const list = [{ permissionCode: 'users.manage', effect: 'grant' }, { permissionCode: 'audit.read', effect: 'deny' }];
  const left = { ...source, afterValues: { overrides: list } };
  expect(auditEventsEqual(left, { ...left, afterValues: { overrides: [...list].reverse() } })).toBe(false);
  expect(() => canonicalAuditEvent({ ...source, metadata: { changed: true, arbitrary: 'hidden' } })).toThrow('AUDIT_UNSAFE_EVENT');
  expect(normalizeAuditEvent({ ...source, afterValues: { overrides: [{ permissionCode: 'removed.historical_permission', effect: 'deny' }] } })
    .afterValues?.overrides?.[0]?.permissionCode).toBe('removed.historical_permission');
});
