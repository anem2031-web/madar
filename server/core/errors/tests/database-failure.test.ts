import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { DatabaseAcquisitionError } from '../../database/acquisition.ts';
import { databaseAcquisitionFailure, databaseAcquisitionReason } from '../database-failure.ts';
import { formatPublicTRPCError } from '../public-error.ts';

afterEach(() => { vi.restoreAllMocks(); });

test('known acquisition failures cross wrapped causes without trusting arbitrary code fields or getters', () => {
  for (const code of ['DB_BUSY', 'DB_WAIT_TIMEOUT', 'DB_CLOSED'] as const) {
    expect(databaseAcquisitionReason(new Error('Private SQL wrapper', { cause: new DatabaseAcquisitionError(code) }))).toBe(code);
    expect(databaseAcquisitionReason({ code })).toBeUndefined();
  }
  const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
  expect(databaseAcquisitionReason(cyclic)).toBeUndefined();
  const getter = Object.defineProperty({}, 'cause', { get() { throw new Error('Private accessor'); } });
  expect(databaseAcquisitionReason(getter)).toBeUndefined();
  expect(databaseAcquisitionReason(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('Private trap'); } }))).toBeUndefined();
  const forged = new DatabaseAcquisitionError('DB_BUSY'); Object.defineProperty(forged, 'code', { value: 'PRIVATE_SQL' });
  expect(databaseAcquisitionReason(forged)).toBeUndefined();
});

test('acquisition failure mapping is safe, referenceable and distinct from credentials or authorization failures', () => {
  const sink = vi.spyOn(console, 'error').mockImplementation(() => {});
  const requestId = randomUUID(); const error = new Error('PRIVATE SQL PASSWORD', { cause: new DatabaseAcquisitionError('DB_BUSY') });
  const mapped = databaseAcquisitionFailure(error, { requestId, scope: 'users', code: 'USERS_STORE_FAILURE' });
  expect(mapped?.code).toBe('SERVICE_UNAVAILABLE');
  const response = formatPublicTRPCError({ shape: { code: -32603, data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503 } }, error: mapped, requestId });
  expect(response).toEqual({ code: -32603, message: 'DB_BUSY', data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503,
    messageKey: 'databaseBusy', requestId } });
  expect(sink).toHaveBeenCalledTimes(1); expect(JSON.parse(sink.mock.calls[0][0])).toMatchObject({ requestId, category: 'busy' });
  expect(JSON.stringify([response, sink.mock.calls])).not.toMatch(/PRIVATE|PASSWORD|SQL/);
  expect(databaseAcquisitionFailure(new Error('Unrecognized'), { requestId, scope: 'users', code: 'USERS_STORE_FAILURE' })).toBeUndefined();
});
