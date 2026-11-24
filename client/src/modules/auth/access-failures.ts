export type AccessFailureHandlers = {
  onSessionInvalid: () => void;
  onReadForbidden: (requestId?: string) => void;
  onActionForbidden: () => void;
};

export function requestReference(error: unknown) {
  const data = error && typeof error === 'object' ? (error as { data?: unknown }).data : undefined;
  const value = data && typeof data === 'object' ? (data as { requestId?: unknown }).requestId : undefined;
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
}
