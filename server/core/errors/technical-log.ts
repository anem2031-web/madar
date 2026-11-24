import { randomUUID } from 'node:crypto';
import { isRequestId } from '../../../shared/errors/contracts.ts';

export const technicalScopes = ['auth', 'users', 'permissions', 'organization', 'numbering', 'audit', 'http', 'runtime'] as const;
export const technicalOperations = ['request', 'validation', 'body', 'not-found', 'response', 'delivery', 'startup', 'listen', 'shutdown', 'health'] as const;
export const technicalCodes = ['AUTH_STORE_FAILURE', 'USERS_STORE_FAILURE', 'OVERRIDES_STORE_FAILURE', 'ORG_STORE_FAILURE', 'NUMBERING_STORE_FAILURE',
  'AUDIT_STORE_FAILURE', 'HTTP_INVALID_REQUEST', 'HTTP_BODY_TOO_LARGE', 'HTTP_UNSUPPORTED_MEDIA', 'HTTP_NOT_FOUND', 'HTTP_INTERNAL_FAILURE',
  'TRPC_INVALID_REQUEST', 'TRPC_NOT_FOUND', 'TRPC_INTERNAL_FAILURE', 'AUDIT_DELIVERY_FAILED', 'RUNTIME_CONFIG_FAILURE', 'RUNTIME_LISTEN_FAILURE',
  'RUNTIME_SHUTDOWN_FAILURE', 'HEALTH_CHECK_FAILURE'] as const;
type Scope = typeof technicalScopes[number];
type Operation = typeof technicalOperations[number];
type Code = typeof technicalCodes[number];
export type TechnicalFailure = { requestId?: string; scope: Scope; operation: Operation; code: Code; error?: unknown };
type Category = 'connection' | 'timeout' | 'transaction-conflict' | 'invalid-request' | 'unexpected';
const value = (object: unknown, key: string) => {
  if (!object || typeof object !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value as unknown : undefined;
  } catch { return undefined; }
};
export function classifyTechnicalFailure(error: unknown): Category {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    const code = value(current, 'code'); const errno = value(current, 'errno'); const type = value(current, 'type');
    if (code === 'ETIMEDOUT' || code === 'PROTOCOL_SEQUENCE_TIMEOUT' || code === 'ER_LOCK_WAIT_TIMEOUT' || errno === 1205) return 'timeout';
    if (code === 'ER_LOCK_DEADLOCK' || code === 'ER_DUP_ENTRY' || errno === 1213 || errno === 1062) return 'transaction-conflict';
    if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'PROTOCOL_CONNECTION_LOST', 'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR'].includes(code as string)) return 'connection';
    if (['entity.parse.failed', 'entity.too.large', 'charset.unsupported', 'encoding.unsupported', 'request.aborted'].includes(type as string)) return 'invalid-request';
    current = value(current, 'cause');
  }
  return 'unexpected';
}

/** Serialize a bounded allowlist only. Never serialize an exception, URL, input, or headers. */
export function createTechnicalLogger(options: { sink?: (line: string) => void; now?: () => Date } = {}) {
  const seen = new Set<string>();
  const sink = options.sink ?? ((line: string) => console.error(line));
  return (input: TechnicalFailure): void => {
    try {
      const requestId = isRequestId(input.requestId) ? input.requestId : randomUUID();
      if (seen.has(requestId)) return;
      if (seen.size >= 2048) seen.delete(seen.values().next().value!);
      seen.add(requestId);
      const scope = (technicalScopes as readonly unknown[]).includes(input.scope) ? input.scope : 'runtime';
      const operation = (technicalOperations as readonly unknown[]).includes(input.operation) ? input.operation : 'request';
      const code = (technicalCodes as readonly unknown[]).includes(input.code) ? input.code : 'HTTP_INTERNAL_FAILURE';
      sink(JSON.stringify({ event: 'technical_failure', occurredAt: (options.now?.() ?? new Date()).toISOString(), requestId,
        scope, operation, code, category: classifyTechnicalFailure(input.error) }));
    } catch { /* Logging must not fail a request, recurse, or change durable business outcomes. */ }
  };
}
export const logTechnicalFailure = createTechnicalLogger();
