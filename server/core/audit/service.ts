import { randomUUID } from 'node:crypto';
import type { AuditDeliveryStatus, AuditDetailResult, AuditEventDetail, AuditEventSummary, AuditListInput, AuditListResult, AuditMetadata, AuditValues } from '../../../shared/audit/contracts.ts';
import type { AuthRequest, AuthService } from '../../modules/auth/service.ts';
import type { AuthAudit, AuthUser } from '../../modules/auth/store.ts';
import { AuthFault } from '../../modules/auth/errors.ts';
import { normalizeAuditEvent } from './event.ts';
import { auditDeliveryErrorCodes } from './delivery-store.ts';
import { AuditFault } from './errors.ts';
import type { AuditStore, AuditTransaction, StoredAuditEvent, StoredAuditSummary, StoredDeliveryStatus } from './store.ts';
import { detailInput, listInput } from './validation.ts';

const iso = (value: string) => new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z').toISOString();
function summary(value: StoredAuditSummary): AuditEventSummary {
  const row = normalizeAuditEvent({ ...value, beforeValues: null, afterValues: null, metadata: null });
  return { eventId: row.eventId, occurredAt: iso(row.occurredAt), actorUserId: row.actorUserId, actorRoleId: row.actorRoleId,
    actorRoleCode: row.actorRoleCode, module: row.module, action: row.action, entityId: row.entityId,
    entityVersion: row.entityVersion, requestId: row.requestId, result: row.result, reasonCode: row.reasonCode };
}
function values(input: unknown): AuditValues | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>; const result: AuditValues = {};
  const keys = ['roleId', 'accountStatus', 'mustChangePassword', 'authVersion', 'name', 'branchId', 'version', 'code', 'prefix', 'format', 'paddingWidth', 'resetPolicy', 'enabled'] as const;
  for (const key of keys) if (Object.hasOwn(row, key)) Object.assign(result, { [key]: row[key] });
  if (Array.isArray(row.overrides)) result.overrides = row.overrides.map(entry => ({ permissionCode: entry.permissionCode, effect: entry.effect }));
  else if (row.overrides === null) result.overrides = null;
  return result;
}
function detail(value: StoredAuditEvent): AuditEventDetail {
  const row = normalizeAuditEvent(value);
  const metadata: AuditMetadata | null = row.metadata ? {} : null;
  if (metadata && row.metadata) {
    for (const key of ['count', 'changed', 'entityType', 'filterTypes'] as const) {
      if (Object.hasOwn(row.metadata, key)) Object.assign(metadata, { [key]: row.metadata[key] });
    }
  }
  return { ...summary(row), beforeValues: values(row.beforeValues), afterValues: values(row.afterValues),
    metadata: metadata && Object.keys(metadata).length ? metadata : null };
}
function delivery(value: StoredDeliveryStatus): AuditDeliveryStatus {
  const safeTime = (value: string | null) => {
    if (!value || !/^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)$/.test(value) || Number(value.slice(0, 4)) < 1000) return null;
    try { const result = iso(value); return result.slice(0, 19) === value.replace(' ', 'T').slice(0, 19) ? result : null; } catch { return null; }
  };
  return { pending: value.pending, leased: value.leased, failed: value.failed, oldestPendingAt: safeTime(value.oldestPendingAt),
    failures: value.failures.slice(0, 10).map((row, index) => ({ eventId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.eventId) ? row.eventId : `UNKNOWN_EVENT_${index + 1}`,
      occurredAt: safeTime(row.occurredAt), errorCode: (auditDeliveryErrorCodes as readonly unknown[]).includes(row.errorCode) ? row.errorCode! : 'AUDIT_DELIVERY_FAILED' })) };
}
export function createAuditService(store: AuditStore, auth: AuthService, options: { now?: () => Date } = {}) {
  const clock = options.now ?? (() => new Date());
  function event(request: AuthRequest, action: string, actor: AuthUser | null, result: 'success' | 'denied', entityId: string | null = null, reasonCode: string | null = null): AuthAudit {
    return { eventId: randomUUID(), occurredAt: clock(), actorUserId: actor?.id ?? null, actorRoleId: actor?.roleId ?? null,
      actorRoleCode: actor?.roleCode ?? null, module: 'audit', action, entityId, requestId: request.requestId, result, reasonCode };
  }
  async function guarded<T>(request: AuthRequest, action: string, work: (tx: AuditTransaction, actor: AuthUser) => Promise<T>, entityId: string | null = null): Promise<T> {
    const outcome = await store.transaction(async tx => {
      let actor: AuthUser | null = null;
      try {
        actor = (await auth.authorizeInTransaction(tx, request, 'audit.read', clock(), current => { actor = current; })).user;
        return { value: await work(tx, actor) };
      } catch (error) {
        if (!(error instanceof AuditFault || error instanceof AuthFault)) throw error;
        await tx.appendAudit(event(request, action, actor, 'denied', entityId, error.reason));
        return { error };
      }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  async function list(request: AuthRequest, input: AuditListInput): Promise<AuditListResult> {
    const parsed = listInput(input);
    return guarded(request, 'audit.list', async (tx, actor) => {
      const rows = await tx.listEvents(parsed, 26);
      const events = rows.slice(0, 25).map(summary);
      const status = delivery(await tx.deliveryStatus());
      const filterTypes: NonNullable<AuditMetadata['filterTypes']> = ['period'];
      for (const key of ['actorUserId', 'module', 'result'] as const) if (parsed[key] !== undefined) filterTypes.push(key);
      await tx.appendAudit({ ...event(request, 'audit.list', actor, 'success'), metadata: { count: events.length, filterTypes } });
      const last = events.at(-1);
      return { events, delivery: status, ...(rows.length > 25 && last ? { nextCursor: { occurredAt: last.occurredAt, eventId: last.eventId } } : {}) };
    });
  }
  async function readDetail(request: AuthRequest, input: { eventId: string }): Promise<AuditDetailResult> {
    const parsed = detailInput(input);
    return guarded(request, 'audit.detail', async (tx, actor) => {
      const row = await tx.getEvent(parsed.eventId);
      if (!row) throw new AuditFault('AUDIT_NOT_FOUND');
      const result = detail(row);
      await tx.appendAudit(event(request, 'audit.detail', actor, 'success', row.eventId));
      return { event: result };
    }, parsed.eventId);
  }
  return { list, detail: readDetail };
}
export type AuditService = ReturnType<typeof createAuditService>;
