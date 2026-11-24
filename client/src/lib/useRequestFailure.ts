import { useCallback, useState } from 'react';
import { relabelRequestFailure, requestReference } from './request-failure.ts';
import type { RequestFailure } from './request-failure.ts';

export function useRequestFailure() {
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const setError = useCallback((code: string | null, source?: unknown) => {
    const requestId = requestReference(source);
    setFailure(code ? { code, ...(requestId ? { requestId } : {}) } : null);
  }, []);
  const relabelError = useCallback((code: string) => setFailure(previous => relabelRequestFailure(previous, code)), []);
  return { error: failure?.code ?? null, errorRequestId: failure?.requestId, setError, relabelError };
}
