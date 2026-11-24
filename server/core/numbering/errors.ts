export type NumberingReason = 'NUMBERING_INVALID_INPUT' | 'NUMBERING_INVALID_PREFIX' | 'NUMBERING_DUPLICATE_CODE'
  | 'NUMBERING_DUPLICATE_PREFIX' | 'NUMBERING_NOT_FOUND' | 'NUMBERING_CONFLICT' | 'NUMBERING_LOCKED' | 'NUMBERING_UNAVAILABLE';

export class NumberingFault extends Error {
  readonly reason: NumberingReason;
  readonly requestId?: string;
  constructor(reason: NumberingReason, requestId?: string) {
    super(reason);
    this.name = 'NumberingFault';
    this.reason = reason;
    this.requestId = requestId;
  }
}

// Inspect driver errors privately, only after the failing transaction has rolled back.
export function numberingDuplicateReason(error: unknown): 'NUMBERING_DUPLICATE_CODE' | 'NUMBERING_DUPLICATE_PREFIX' | null {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    const value = current as { code?: unknown; errno?: unknown; message?: unknown; sqlMessage?: unknown; cause?: unknown };
    if (value.code === 'ER_DUP_ENTRY' || value.errno === 1062) {
      const message = typeof value.sqlMessage === 'string' ? value.sqlMessage : typeof value.message === 'string' ? value.message : '';
      const key = /for key ['`](?:[^'`]+\.)?(uq_numbering_series_code|uq_numbering_series_prefix)['`]/i.exec(message)?.[1]?.toLowerCase();
      if (key === 'uq_numbering_series_code') return 'NUMBERING_DUPLICATE_CODE';
      if (key === 'uq_numbering_series_prefix') return 'NUMBERING_DUPLICATE_PREFIX';
    }
    current = value.cause;
  }
  return null;
}
