import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { authErrorCodes, isPublicErrorCode, messageKeyFor, usersErrorCodes } from '../../../../shared/errors/contracts.ts';
import { AuthFault } from '../../../modules/auth/errors.ts';
import { UsersFault } from '../../../modules/users/errors.ts';
import { formatPublicTRPCError, knownReason, safePublicError } from '../public-error.ts';

afterEach(() => { vi.restoreAllMocks(); });
test('runtime reason checks reject forged known faults, foreign-domain codes, and throwing getters instead of echoing raw data', () => {
  expect(knownReason(new AuthFault('AUTH_REQUIRED'), authErrorCodes)).toBe('AUTH_REQUIRED');
  const forged = new UsersFault('Synthetic private SQL' as UsersFault['reason']);
  expect(knownReason(forged, usersErrorCodes)).toBeUndefined();
  expect(knownReason(new AuthFault('USERS_CONFLICT' as AuthFault['reason']), authErrorCodes)).toBeUndefined();
  const getter = Object.create(null); Object.defineProperty(getter, 'reason', { get() { throw new Error('Private getter'); } });
  expect(knownReason(getter, authErrorCodes)).toBeUndefined();
  expect(knownReason(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('Private trap'); } }), authErrorCodes)).toBeUndefined();
  const publicError = safePublicError(forged.reason, 'forged request ID');
  expect(publicError.code).toBe('INTERNAL_SERVER_ERROR'); expect(publicError.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(publicError)).not.toMatch(/private|SQL|forged/);
});
test('formatter preserves reauthentication business semantics and authoritative request ID while removing framework details', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const contextId = randomUUID(); const forgedId = randomUUID(); const fault = new UsersFault('USERS_REAUTH_FAILED', forgedId);
  const response = formatPublicTRPCError({ shape: { code: -32001, message: 'Synthetic private exception', data: {
    code: 'UNAUTHORIZED', httpStatus: 401, path: 'Synthetic private URL', stack: 'Synthetic private SQL',
  } } as never, error: fault, requestId: contextId, reason: knownReason(fault, usersErrorCodes) });
  expect(response).toEqual({ code: -32001, message: 'USERS_REAUTH_FAILED', data: { code: 'UNAUTHORIZED', httpStatus: 401, messageKey: 'requestFailed', requestId: contextId } });
  expect(JSON.stringify(response)).not.toContain('Synthetic'); expect(JSON.stringify(response)).not.toContain(forgedId);
  expect(messageKeyFor('USERS_REAUTH_FAILED')).not.toBe('sessionExpired'); expect(isPublicErrorCode('Sensitive untrusted message')).toBe(false);
});
test('unknown validation and transport failures use safe generic codes with a trace and one technical log', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {}); const requestId = randomUUID();
  const call = () => formatPublicTRPCError({ shape: { code: -32600, data: { code: 'BAD_REQUEST', httpStatus: 400 } },
    error: Object.assign(new Error('Synthetic private password'), { sql: 'Synthetic private password' }), requestId, reason: 'Synthetic private password' });
  expect(call()).toMatchObject({ message: 'BAD_REQUEST', data: { messageKey: 'invalidRequest', requestId } }); call();
  expect(spy).toHaveBeenCalledTimes(1); expect(JSON.stringify(spy.mock.calls)).not.toContain('password');
});
