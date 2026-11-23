import { AuthFault } from './errors.ts';

function strings(input: unknown, keys: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AuthFault('AUTH_INVALID_INPUT');
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => typeof record[key] !== 'string')) {
    throw new AuthFault('AUTH_INVALID_INPUT');
  }
  for (const key of keys) if ((record[key] as string).length > 512) throw new AuthFault('AUTH_INVALID_INPUT');
  return record as Record<string, string>;
}

export function loginInput(input: unknown) {
  const value = strings(input, ['username', 'password']);
  const username = value.username.trim();
  if (!username || Array.from(username).length > 64 || Array.from(value.password).length > 128) throw new AuthFault('AUTH_INVALID_INPUT');
  return { username, password: value.password };
}

export function passwordInput(input: unknown) {
  const value = strings(input, ['currentPassword', 'newPassword']);
  if (Array.from(value.currentPassword).length > 128) throw new AuthFault('AUTH_INVALID_INPUT');
  return { currentPassword: value.currentPassword, newPassword: value.newPassword };
}
