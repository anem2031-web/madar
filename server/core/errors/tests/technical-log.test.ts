import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { classifyTechnicalFailure, createTechnicalLogger } from '../technical-log.ts';
import type { TechnicalFailure } from '../technical-log.ts';

test('technical logs serialize only bounded fixed metadata, classify safe driver codes, and deduplicate the same request', () => {
  const lines: string[] = []; const logger = createTechnicalLogger({ sink: line => lines.push(line), now: () => new Date('2026-11-24T10:00:00Z') });
  const requestId = randomUUID();
  const secret = 'SYNTHETIC_PRIVATE_SQL_COOKIE_PASSWORD';
  const driver = Object.assign(new Error(secret), { code: 'ECONNRESET', sql: secret, parameters: [secret], stack: secret });
  const failure = Object.assign(new Error(secret, { cause: driver }), { body: secret, cookie: secret, url: secret });
  const input = { requestId, scope: 'users', operation: 'request', code: 'USERS_STORE_FAILURE', error: failure } as const;
  logger(input); logger(input);
  expect(lines).toHaveLength(1); expect(lines[0]).not.toContain(secret); expect(lines[0].length).toBeLessThan(1024);
  expect(JSON.parse(lines[0])).toEqual({ event: 'technical_failure', occurredAt: '2026-11-24T10:00:00.000Z', requestId,
    scope: 'users', operation: 'request', code: 'USERS_STORE_FAILURE', category: 'connection' });
  logger({ requestId: secret, scope: secret, operation: secret, code: secret, error: new Error(secret) } as unknown as TechnicalFailure);
  expect(lines[1]).not.toContain(secret); expect(JSON.parse(lines[1])).toMatchObject({ scope: 'runtime', operation: 'request', code: 'HTTP_INTERNAL_FAILURE' });
});
test('safe cause traversal is bounded, handles cycles, and never invokes diagnostic getters or proxy traps unsafely', () => {
  const cyclic = { code: 'UNKNOWN_DRIVER_CODE' } as { code: string; cause?: unknown }; cyclic.cause = cyclic;
  expect(classifyTechnicalFailure(cyclic)).toBe('unexpected');
  expect(classifyTechnicalFailure({ cause: { errno: 1213 } })).toBe('transaction-conflict');
  expect(classifyTechnicalFailure({ code: 'ER_LOCK_WAIT_TIMEOUT' })).toBe('timeout');
  const getters = Object.create(null); Object.defineProperty(getters, 'code', { get() { throw new Error('Do not read code getter'); } });
  expect(classifyTechnicalFailure(getters)).toBe('unexpected');
  expect(classifyTechnicalFailure(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('Synthetic private trap'); } }))).toBe('unexpected');
});
test('sink failures are swallowed and duplicate tracking remains bounded rather than retaining all request IDs', () => {
  const broken = createTechnicalLogger({ sink() { throw new Error('Synthetic private logging failure'); } });
  expect(() => broken({ scope: 'audit', operation: 'delivery', code: 'AUDIT_DELIVERY_FAILED', error: new Error('Synthetic private source') })).not.toThrow();
  const lines: string[] = []; const log = createTechnicalLogger({ sink: line => lines.push(line) }); const first = randomUUID();
  const emit = (requestId: string) => log({ requestId, scope: 'runtime', operation: 'startup', code: 'RUNTIME_CONFIG_FAILURE' });
  emit(first); for (let index = 0; index < 2048; index++) emit(randomUUID()); emit(first);
  expect(lines).toHaveLength(2050);
});
