import { genericErrorCodes, isRequestId } from '../../../shared/errors/contracts.ts';

export type RequestFailure = { code: string; requestId?: string };
const genericCodes = new Set<string>(genericErrorCodes);
const uncertainWriteCodes = new Set(['INTERNAL_SERVER_ERROR', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'BAD_GATEWAY', 'GATEWAY_TIMEOUT', 'CLIENT_CLOSED_REQUEST']);
const aliases: Record<string, string> = { UNAUTHORIZED: 'AUTH_REQUIRED', FORBIDDEN: 'AUTH_FORBIDDEN' };

export function requestReference(error: unknown): string | undefined {
  try {
    const data = error && typeof error === 'object' ? (error as { data?: unknown }).data : undefined;
    const value = data && typeof data === 'object' ? (data as { requestId?: unknown }).requestId : undefined;
    return isRequestId(value) ? value : undefined;
  } catch { return undefined; }
}

export function readRequestFailure(error: unknown, allowed: ReadonlySet<string>, fallback: string, write = false): RequestFailure {
  let candidate = '';
  try { if (error instanceof Error) candidate = error.message; } catch { /* Ignore an unsafe error object. */ }
  const alias = aliases[candidate];
  const uncertainWrite = write && (uncertainWriteCodes.has(candidate) || (allowed.has(candidate) && candidate.endsWith('_UNAVAILABLE')));
  const code = uncertainWrite ? fallback : alias && allowed.has(alias) ? alias : allowed.has(candidate) ? candidate
    : genericCodes.has(candidate) ? candidate : fallback;
  const requestId = requestReference(error);
  return { code, ...(requestId ? { requestId } : {}) };
}

export function relabelRequestFailure(failure: RequestFailure | null, code: string): RequestFailure {
  return { code, ...(failure?.requestId ? { requestId: failure.requestId } : {}) };
}
