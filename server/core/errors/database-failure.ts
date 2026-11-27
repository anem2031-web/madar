import { TRPCError } from '@trpc/server';
import { DatabaseAcquisitionError } from '../database/acquisition.ts';
import { logTechnicalFailure } from './technical-log.ts';
import type { TechnicalFailure } from './technical-log.ts';

const acquisitionCodes = ['DB_BUSY', 'DB_WAIT_TIMEOUT', 'DB_CLOSED'] as const;
type AcquisitionCode = typeof acquisitionCodes[number];

/** Inspect known errors only; do not invoke error getters or copy driver messages. */
export function databaseAcquisitionReason(error: unknown): AcquisitionCode | undefined {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'code');
      const code: unknown = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
      if (current instanceof DatabaseAcquisitionError && acquisitionCodes.includes(code as AcquisitionCode)) return code as AcquisitionCode;
      const cause = Object.getOwnPropertyDescriptor(current, 'cause');
      current = cause && Object.hasOwn(cause, 'value') ? cause.value : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

export function databaseAcquisitionFailure(error: unknown, metadata: Pick<TechnicalFailure, 'requestId' | 'scope' | 'code'>): TRPCError | undefined {
  const reason = databaseAcquisitionReason(error);
  if (!reason) return undefined;
  logTechnicalFailure({ ...metadata, operation: 'request', error });
  return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: reason, cause: error });
}
