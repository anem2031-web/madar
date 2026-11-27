import { randomUUID } from 'node:crypto';
import { genericErrorCodes, isPublicErrorCode, isRequestId, messageKeyFor } from '../../../shared/errors/contracts.ts';
import type { GenericErrorCode, PublicErrorBody, PublicErrorCode } from '../../../shared/errors/contracts.ts';
import { currentRequestId } from './request-context.ts';
import { logTechnicalFailure } from './technical-log.ts';
import { databaseAcquisitionReason } from './database-failure.ts';

export function knownReason<T extends string>(error: unknown, allowed: readonly T[]): T | undefined {
  if (!error || typeof error !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'reason');
    const reason: unknown = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    return typeof reason === 'string' && allowed.includes(reason as T) ? reason as T : undefined;
  } catch { return undefined; }
}
export function safePublicError(reason: unknown, requestId: unknown, fallback: PublicErrorCode = 'INTERNAL_SERVER_ERROR'): PublicErrorBody {
  const code = isPublicErrorCode(reason) ? reason : isPublicErrorCode(fallback) ? fallback : 'INTERNAL_SERVER_ERROR';
  return { code, messageKey: messageKeyFor(code), requestId: isRequestId(requestId) ? requestId : currentRequestId() ?? randomUUID() };
}
type TRPCShape = { code: number; data: { code: string; httpStatus: number } };
export function formatPublicTRPCError({ shape, error, requestId, reason }: {
  shape: TRPCShape; error: unknown; requestId?: string; reason?: unknown;
}) {
  const transport = (genericErrorCodes as readonly string[]).includes(shape.data.code) ? shape.data.code as GenericErrorCode : 'INTERNAL_SERVER_ERROR';
  const response = safePublicError(databaseAcquisitionReason(error) ?? reason, requestId, transport);
  if (shape.data.httpStatus >= 500 || !isPublicErrorCode(reason)) {
    logTechnicalFailure({ requestId: response.requestId, scope: 'http', operation: transport === 'NOT_FOUND' ? 'not-found' : 'response',
      code: shape.data.httpStatus >= 500 ? 'TRPC_INTERNAL_FAILURE' : transport === 'NOT_FOUND' ? 'TRPC_NOT_FOUND' : 'TRPC_INVALID_REQUEST', error });
  }
  return { code: shape.code, message: response.code, data: { code: transport, httpStatus: shape.data.httpStatus,
    messageKey: response.messageKey, requestId: response.requestId } };
}
