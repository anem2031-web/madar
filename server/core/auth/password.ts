import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const cost = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
let active = 0;

export class PasswordBusyError extends Error {}

async function derive(password: string, salt: Buffer) {
  if (active >= 2) throw new PasswordBusyError('Password verification busy.');
  active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, cost, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally {
    active--;
  }
}

export function isPasswordAllowed(password: string) {
  const length = Array.from(password).length;
  return length >= 15 && length <= 128;
}

export async function hashPassword(password: string) {
  if (!isPasswordAllowed(password)) throw new Error('Invalid password length.');
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$1$32768$8$3$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const fields = encoded.split('$');
  const valid = fields.length === 7 && fields.slice(0, 5).join('$') === 'scrypt$1$32768$8$3'
    && /^[A-Za-z0-9_-]{22}$/.test(fields[5]) && /^[A-Za-z0-9_-]{43}$/.test(fields[6]);
  const salt = valid ? Buffer.from(fields[5], 'base64url') : Buffer.alloc(16, 17);
  const key = await derive(password, salt);
  const expected = valid ? Buffer.from(fields[6], 'base64url') : Buffer.alloc(32);
  return timingSafeEqual(key, expected) && valid;
}
