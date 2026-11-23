import { isPermissionCode, permissionCodes } from '../../../shared/permissions/catalog.ts';
import { OverridesFault } from './errors.ts';
import type { UserOverride } from './store.ts';

function record(input: unknown, required: string[], optional: string[] = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OverridesFault('OVERRIDES_INVALID_INPUT');
  const value = input as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new OverridesFault('OVERRIDES_INVALID_INPUT');
  }
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new OverridesFault('OVERRIDES_INVALID_INPUT');
  return value.toLowerCase();
}
export function listInput(input: unknown) {
  if (input === undefined) return {};
  const value = record(input, [], ['cursor']);
  return value.cursor === undefined ? {} : { cursor: identifier(value.cursor) };
}
export function detailInput(input: unknown) {
  const value = record(input, ['userId']);
  return { userId: identifier(value.userId) };
}
export function saveInput(input: unknown) {
  const value = record(input, ['userId', 'expectedAuthVersion', 'currentPassword', 'overrides']);
  if (typeof value.expectedAuthVersion !== 'number' || !Number.isSafeInteger(value.expectedAuthVersion)
    || value.expectedAuthVersion < 1 || value.expectedAuthVersion > 4_294_967_295
    || typeof value.currentPassword !== 'string' || value.currentPassword.length > 512 || Array.from(value.currentPassword).length > 128
    || !Array.isArray(value.overrides) || value.overrides.length > permissionCodes.length) throw new OverridesFault('OVERRIDES_INVALID_INPUT');
  const seen = new Set<string>();
  const overrides: UserOverride[] = value.overrides.map((item): UserOverride => {
    const entry = record(item, ['permissionCode', 'effect']);
    if (typeof entry.permissionCode !== 'string' || !isPermissionCode(entry.permissionCode)
      || (entry.effect !== 'grant' && entry.effect !== 'deny') || seen.has(entry.permissionCode)) throw new OverridesFault('OVERRIDES_INVALID_INPUT');
    seen.add(entry.permissionCode);
    return { permissionCode: entry.permissionCode, effect: entry.effect };
  }).sort((left, right) => left.permissionCode.localeCompare(right.permissionCode));
  return { userId: identifier(value.userId), expectedAuthVersion: value.expectedAuthVersion,
    currentPassword: value.currentPassword, overrides };
}
