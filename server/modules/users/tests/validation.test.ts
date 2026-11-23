import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { assignRoleInput, createInput, listInput, targetInput } from '../validation.ts';

const roleId = randomUUID();
const userId = randomUUID();

test('user management input rejects unknown fields and client-controlled state or secret hashes', () => {
  const valid = { username: 'HR02', roleId, currentPassword: 'Current private fixture' };
  for (const extra of [{ passwordHash: 'attacker-hash' }, { accountStatus: 'active' }, { authVersion: 99 }, { mustChangePassword: false }, { permissionCode: 'users.manage' }]) {
    expect(() => createInput({ ...valid, ...extra })).toThrow('USERS_INVALID_INPUT');
  }
  expect(() => targetInput({ userId, expectedAuthVersion: 1, currentPassword: 'Current private fixture', accountStatus: 'active' })).toThrow('USERS_INVALID_INPUT');
});

test('username normalization trims only the edges and preserves letters, zeroes and interior spaces', () => {
  const currentPassword = '  A private current secret  ';
  expect(createInput({ username: '  00 Ab C  ', roleId, currentPassword })).toEqual({ username: '00 Ab C', roleId, currentPassword });
  for (const username of ['', ' ', 'a'.repeat(65), 'Name\nOther']) {
    expect(() => createInput({ username, roleId, currentPassword })).toThrow('USERS_INVALID_INPUT');
  }
});

test('cursor and target contracts bound identities and require a valid positive auth version', () => {
  expect(listInput(undefined)).toEqual({});
  expect(listInput({ cursor: userId })).toEqual({ cursor: userId });
  for (const input of [{ limit: 1000 }, { cursor: 'not-a-uuid' }, { cursor: userId, roleId }]) expect(() => listInput(input)).toThrow('USERS_INVALID_INPUT');
  for (const expectedAuthVersion of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER]) {
    expect(() => targetInput({ userId, expectedAuthVersion, currentPassword: 'private' })).toThrow('USERS_INVALID_INPUT');
  }
  expect(assignRoleInput({ userId, roleId, expectedAuthVersion: 1, currentPassword: 'private' })).toEqual({ userId, roleId, expectedAuthVersion: 1, currentPassword: 'private' });
});
