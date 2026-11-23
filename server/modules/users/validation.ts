import { UsersFault } from './errors.ts';

function record(input: unknown, required: string[], optional: string[] = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UsersFault('USERS_INVALID_INPUT');
  const value = input as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new UsersFault('USERS_INVALID_INPUT');
  }
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new UsersFault('USERS_INVALID_INPUT');
  return value;
}
function currentPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || Array.from(value).length > 128) throw new UsersFault('USERS_INVALID_INPUT');
  return value;
}
function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 4_294_967_295) throw new UsersFault('USERS_INVALID_INPUT');
  return value;
}
export function listInput(input: unknown) {
  if (input === undefined) return {};
  const value = record(input, [], ['cursor']);
  return value.cursor === undefined ? {} : { cursor: identifier(value.cursor) };
}
export function createInput(input: unknown) {
  const value = record(input, ['username', 'roleId', 'currentPassword']);
  if (typeof value.username !== 'string') throw new UsersFault('USERS_INVALID_INPUT');
  const username = value.username.trim();
  if (!username || Array.from(username).length > 64 || /[\u0000-\u001f\u007f]/u.test(username)) throw new UsersFault('USERS_INVALID_INPUT');
  return { username, roleId: identifier(value.roleId), currentPassword: currentPassword(value.currentPassword) };
}
export function targetInput(input: unknown) {
  const value = record(input, ['userId', 'expectedAuthVersion', 'currentPassword']);
  return { userId: identifier(value.userId), expectedAuthVersion: version(value.expectedAuthVersion), currentPassword: currentPassword(value.currentPassword) };
}
export function assignRoleInput(input: unknown) {
  const value = record(input, ['userId', 'roleId', 'expectedAuthVersion', 'currentPassword']);
  return { userId: identifier(value.userId), roleId: identifier(value.roleId), expectedAuthVersion: version(value.expectedAuthVersion), currentPassword: currentPassword(value.currentPassword) };
}
