import { expect, test } from 'vitest';
import { readRequestFailure, relabelRequestFailure, requestReference } from '../../../../client/src/lib/request-failure.ts';

const requestId = '12345678-1234-1234-1234-123456789abc';
const allowed = new Set(['USERS_REAUTH_FAILED', 'AUTH_REQUIRED', 'AUTH_FORBIDDEN']);
const failure = (message: string, reference: unknown = requestId) => Object.assign(new Error(message), { data: { requestId: reference, messageKey: 'untrusted-secret' }, stack: 'private SQL password' });

test('only caller-allowed domain codes and valid request UUIDs cross the client boundary', () => {
  expect(readRequestFailure(failure('USERS_REAUTH_FAILED'), allowed, 'USERS_UNAVAILABLE')).toEqual({ code: 'USERS_REAUTH_FAILED', requestId });
  expect(readRequestFailure(failure('ORG_INVALID_INPUT'), allowed, 'USERS_UNAVAILABLE')).toEqual({ code: 'USERS_UNAVAILABLE', requestId });
  expect(readRequestFailure(failure('SELECT password FROM users'), allowed, 'USERS_UNAVAILABLE')).toEqual({ code: 'USERS_UNAVAILABLE', requestId });
  expect(readRequestFailure({ message: 'USERS_REAUTH_FAILED', stack: 'private', data: { requestId } }, allowed, 'USERS_UNAVAILABLE')).toEqual({ code: 'USERS_UNAVAILABLE', requestId });
});

test('malformed references, technical data and hostile accessors cannot produce a user reference', () => {
  for (const value of [null, undefined, '', 123, {}, 'token=secret', `${requestId}\nSQL`, ` ${requestId}`]) {
    expect(requestReference({ data: { requestId: value } })).toBeUndefined();
  }
  expect(requestReference({ get data() { throw new Error('private SQL'); } })).toBeUndefined();
  expect(readRequestFailure(null, allowed, 'USERS_UNAVAILABLE')).toEqual({ code: 'USERS_UNAVAILABLE' });
});

test('known transport rejections stay specific, while unconfirmed writes require review without inventing references', () => {
  for (const code of ['PARSE_ERROR', 'BAD_REQUEST', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'METHOD_NOT_SUPPORTED', 'TOO_MANY_REQUESTS']) {
    expect(readRequestFailure(failure(code), allowed, 'USERS_UNCERTAIN', true)).toEqual({ code, requestId });
  }
  for (const code of ['INTERNAL_SERVER_ERROR', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'BAD_GATEWAY', 'GATEWAY_TIMEOUT', 'CLIENT_CLOSED_REQUEST']) {
    expect(readRequestFailure(failure(code), allowed, 'USERS_UNCERTAIN', true)).toEqual({ code: 'USERS_UNCERTAIN', requestId });
    expect(readRequestFailure(failure(code), allowed, 'USERS_UNAVAILABLE')).toEqual({ code, requestId });
  }
  expect(readRequestFailure(new Error('Failed to fetch private-host'), allowed, 'USERS_UNCERTAIN', true)).toEqual({ code: 'USERS_UNCERTAIN' });
  expect(readRequestFailure(new Error('Aborted'), allowed, 'AUTH_UNAVAILABLE')).toEqual({ code: 'AUTH_UNAVAILABLE' });
});

test('generic authentication denial preserves the existing central guard semantics', () => {
  expect(readRequestFailure(failure('UNAUTHORIZED'), allowed, 'USERS_UNAVAILABLE')).toEqual({ code: 'AUTH_REQUIRED', requestId });
  expect(readRequestFailure(failure('FORBIDDEN'), allowed, 'USERS_UNAVAILABLE')).toEqual({ code: 'AUTH_FORBIDDEN', requestId });
});

test('domain unavailable responses after a possible commit remain uncertain only for writes', () => {
  for (const prefix of ['USERS', 'OVERRIDES', 'ORG', 'NUMBERING', 'AUTH']) {
    const code = `${prefix}_UNAVAILABLE`;
    const writeAllowed = new Set([...allowed, code, 'AUTH_UNAVAILABLE', 'USERS_CONFLICT']);
    expect(readRequestFailure(failure(code), writeAllowed, `${prefix}_UNCERTAIN`, true)).toEqual({ code: `${prefix}_UNCERTAIN`, requestId });
    expect(readRequestFailure(failure(code), writeAllowed, `${prefix}_UNAVAILABLE`)).toEqual({ code, requestId });
    expect(readRequestFailure(failure('AUTH_UNAVAILABLE'), writeAllowed, `${prefix}_UNCERTAIN`, true)).toEqual({ code: `${prefix}_UNCERTAIN`, requestId });
    for (const rejection of ['USERS_REAUTH_FAILED', 'AUTH_FORBIDDEN', 'AUTH_REQUIRED', 'USERS_CONFLICT', 'CONFLICT']) {
      expect(readRequestFailure(failure(rejection), writeAllowed, `${prefix}_UNCERTAIN`, true)).toEqual({ code: rejection, requestId });
    }
  }
});

test('a committed-write refresh failure retains the failed read reference and a distinct code', () => {
  const readFailure = readRequestFailure(failure('SERVICE_UNAVAILABLE'), allowed, 'USERS_UNAVAILABLE');
  expect(relabelRequestFailure(readFailure, 'USERS_REFRESH_FAILED')).toEqual({ code: 'USERS_REFRESH_FAILED', requestId });
  expect(relabelRequestFailure(null, 'USERS_REFRESH_FAILED')).toEqual({ code: 'USERS_REFRESH_FAILED' });
  expect(readFailure.code).toBe('SERVICE_UNAVAILABLE');
});
