export type AuditValues = Partial<{
  roleId: string | null; accountStatus: 'active' | 'disabled' | null; mustChangePassword: boolean | null;
  authVersion: number | null; name: string | null; branchId: string | null; version: number | null;
  code: string | null; prefix: string | null; format: string | null; paddingWidth: number | null;
  resetPolicy: 'annual' | 'continuous' | null; enabled: boolean | null;
  overrides: { permissionCode: string; effect: 'grant' | 'deny' }[] | null;
}>;
export type AuditMetadata = Partial<{
  count: number; changed: boolean; entityType: 'branch' | 'department'; filterTypes: string[];
  source: string; revokedSessions: number;
}>;
export type NormalizedAuditEvent = {
  eventId: string; occurredAt: string; actorUserId: string | null; actorRoleId: string | null; actorRoleCode: string | null;
  module: string; action: string; entityId: string | null; entityVersion: number | null; requestId: string;
  result: 'success' | 'denied' | 'failed'; reasonCode: string | null;
  beforeValues: AuditValues | null; afterValues: AuditValues | null; metadata: AuditMetadata | null;
};

export class AuditEventValidationError extends Error {
  constructor() { super('AUDIT_UNSAFE_EVENT'); this.name = 'AuditEventValidationError'; }
}
export const auditEventMaximumBytes = 16 * 1024;
const maximumUnsignedInt = 4_294_967_295;
const eventKeys = ['eventId', 'occurredAt', 'actorUserId', 'actorRoleId', 'actorRoleCode', 'module', 'action',
  'entityId', 'entityVersion', 'requestId', 'result', 'reasonCode', 'beforeValues', 'afterValues', 'metadata'];
const valueKeys = ['roleId', 'accountStatus', 'mustChangePassword', 'authVersion', 'name', 'branchId', 'version',
  'code', 'prefix', 'format', 'paddingWidth', 'resetPolicy', 'enabled', 'overrides'];
const metadataKeys = ['count', 'changed', 'entityType', 'filterTypes', 'source', 'revokedSessions'];
const filterTypes = new Set(['period', 'actorUserId', 'module', 'result']);

function invalid(): never { throw new AuditEventValidationError(); }
function object(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))) return invalid();
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return invalid();
  return value;
}
function safeCode(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)) return invalid();
  return value;
}
function integer(value: unknown, minimum = 0, maximum = maximumUnsignedInt): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}
function boolean(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function text(value: unknown, maximum: number, ascii = false): string {
  if (typeof value !== 'string' || !value || value.length > maximum * 4 || Array.from(value).length > maximum
    || /[\u0000-\u001f\u007f]/.test(value) || (ascii && !/^[\x20-\x7e]+$/.test(value))) return invalid();
  return value;
}
function timestamp(value: unknown): string {
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)) date = new Date(value.replace(' ', 'T') + 'Z');
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) date = new Date(value);
  else return invalid();
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1000 || date.getUTCFullYear() > 9999) return invalid();
  if (typeof value === 'string' && date.toISOString().slice(0, 19) !== value.replace(' ', 'T').slice(0, 19)) return invalid();
  return date.toISOString().slice(0, 23).replace('T', ' ');
}
function values(input: unknown): AuditValues | null {
  if (input === null || input === undefined) return null;
  const value = object(input, valueKeys);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) { result[key] = null; continue; }
    if (key === 'roleId' || key === 'branchId') result[key] = uuid(entry);
    else if (key === 'accountStatus') result[key] = entry === 'active' || entry === 'disabled' ? entry : invalid();
    else if (key === 'mustChangePassword' || key === 'enabled') result[key] = boolean(entry);
    else if (key === 'authVersion' || key === 'version') result[key] = integer(entry, 1);
    else if (key === 'name') result[key] = text(entry, 150);
    else if (key === 'code') result[key] = text(entry, 64, true);
    else if (key === 'prefix') result[key] = text(entry, 16, true);
    else if (key === 'format') result[key] = text(entry, 100);
    else if (key === 'paddingWidth') result[key] = integer(entry, 1, 255);
    else if (key === 'resetPolicy') result[key] = entry === 'annual' || entry === 'continuous' ? entry : invalid();
    else if (key === 'overrides') {
      if (!Array.isArray(entry) || entry.length > 128) return invalid();
      const seen = new Set<string>();
      result[key] = entry.map(item => {
        const override = object(item, ['permissionCode', 'effect']);
        const permissionCode = safeCode(override.permissionCode, 96);
        if (seen.has(permissionCode)
          || (override.effect !== 'grant' && override.effect !== 'deny')) return invalid();
        seen.add(permissionCode);
        return { permissionCode, effect: override.effect };
      });
    }
  }
  return result as AuditValues;
}
function metadata(input: unknown): AuditMetadata | null {
  if (input === null || input === undefined) return null;
  const value = object(input, metadataKeys);
  const result: AuditMetadata = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'count' || key === 'revokedSessions') result[key] = integer(entry);
    else if (key === 'changed') result.changed = boolean(entry);
    else if (key === 'entityType') result.entityType = entry === 'branch' || entry === 'department' ? entry : invalid();
    else if (key === 'source') result.source = typeof entry === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(entry) ? entry : invalid();
    else if (key === 'filterTypes') {
      if (!Array.isArray(entry) || entry.length > filterTypes.size || new Set(entry).size !== entry.length
        || entry.some(item => typeof item !== 'string' || !filterTypes.has(item))) return invalid();
      result.filterTypes = entry as string[];
    }
  }
  return result;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

/** Validate before persistence and delivery. Never silently discard unexpected or secret-bearing fields. */
export function normalizeAuditEvent(input: unknown): NormalizedAuditEvent {
  const value = object(input, eventKeys);
  const event: NormalizedAuditEvent = {
    eventId: uuid(value.eventId), occurredAt: timestamp(value.occurredAt),
    actorUserId: value.actorUserId == null ? null : uuid(value.actorUserId), actorRoleId: value.actorRoleId == null ? null : uuid(value.actorRoleId),
    actorRoleCode: value.actorRoleCode == null ? null : safeCode(value.actorRoleCode, 64),
    module: safeCode(value.module, 64), action: safeCode(value.action, 96), entityId: value.entityId == null ? null : uuid(value.entityId),
    entityVersion: value.entityVersion == null ? null : integer(value.entityVersion, 1), requestId: uuid(value.requestId),
    result: value.result === 'success' || value.result === 'denied' || value.result === 'failed' ? value.result : invalid(),
    reasonCode: value.reasonCode == null ? null : safeCode(value.reasonCode, 96), beforeValues: values(value.beforeValues),
    afterValues: values(value.afterValues), metadata: metadata(value.metadata),
  };
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > auditEventMaximumBytes) return invalid();
  return event;
}
export function canonicalAuditEvent(input: unknown): string { return JSON.stringify(canonical(normalizeAuditEvent(input))); }
export function auditEventsEqual(left: unknown, right: unknown): boolean { return canonicalAuditEvent(left) === canonicalAuditEvent(right); }
