import { auditModules, auditResults } from '../../../shared/audit/contracts.ts';
import type { AuditDetailInput, AuditListInput } from '../../../shared/audit/contracts.ts';
import { AuditFault } from './errors.ts';

function record(input: unknown, required: string[], optional: string[] = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AuditFault('AUDIT_INVALID_INPUT');
  const value = input as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new AuditFault('AUDIT_INVALID_INPUT');
  return value;
}
function identifier(input: unknown) {
  if (typeof input !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) throw new AuditFault('AUDIT_INVALID_INPUT');
  return input.toLowerCase();
}
function instant(input: unknown) {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input)) throw new AuditFault('AUDIT_INVALID_INPUT');
  const date = new Date(input);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1000 || date.toISOString() !== input.replace(/Z$/, input.includes('.') ? 'Z' : '.000Z')) throw new AuditFault('AUDIT_INVALID_INPUT');
  return date.toISOString();
}
export function listInput(input: unknown): AuditListInput {
  const value = record(input, ['from', 'to'], ['actorUserId', 'module', 'result', 'cursor']);
  const from = instant(value.from); const to = instant(value.to);
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > 31 * 24 * 60 * 60_000) throw new AuditFault('AUDIT_INVALID_INPUT');
  if (value.module !== undefined && !(auditModules as readonly unknown[]).includes(value.module)) throw new AuditFault('AUDIT_INVALID_INPUT');
  if (value.result !== undefined && !(auditResults as readonly unknown[]).includes(value.result)) throw new AuditFault('AUDIT_INVALID_INPUT');
  let cursor: AuditListInput['cursor'];
  if (value.cursor !== undefined) {
    const fields = record(value.cursor, ['occurredAt', 'eventId']);
    cursor = { occurredAt: instant(fields.occurredAt), eventId: identifier(fields.eventId) };
    if (cursor.occurredAt < from || cursor.occurredAt > to) throw new AuditFault('AUDIT_INVALID_INPUT');
  }
  return { from, to, ...(value.actorUserId !== undefined ? { actorUserId: identifier(value.actorUserId) } : {}),
    ...(value.module !== undefined ? { module: value.module as AuditListInput['module'] } : {}),
    ...(value.result !== undefined ? { result: value.result as AuditListInput['result'] } : {}), ...(cursor ? { cursor } : {}) };
}
export function detailInput(input: unknown): AuditDetailInput {
  const value = record(input, ['eventId']); return { eventId: identifier(value.eventId) };
}
