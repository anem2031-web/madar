export const authErrorCodes = ['AUTH_INVALID_CREDENTIALS', 'AUTH_RATE_LIMITED', 'AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'AUTH_CSRF',
  'AUTH_INVALID_INPUT', 'AUTH_PASSWORD_POLICY', 'AUTH_PASSWORD_REUSED', 'AUTH_UNAVAILABLE'] as const;
export const usersErrorCodes = ['USERS_INVALID_INPUT', 'USERS_DUPLICATE_USERNAME', 'USERS_NOT_FOUND', 'USERS_ROLE_NOT_FOUND',
  'USERS_CONFLICT', 'USERS_ALREADY_DISABLED', 'USERS_SELF_CHANGE', 'USERS_REAUTH_FAILED', 'USERS_UNAVAILABLE'] as const;
export const overridesErrorCodes = ['OVERRIDES_INVALID_INPUT', 'OVERRIDES_NOT_FOUND', 'OVERRIDES_CONFLICT', 'OVERRIDES_SELF_CHANGE',
  'OVERRIDES_REAUTH_FAILED', 'OVERRIDES_UNAVAILABLE'] as const;
export const organizationErrorCodes = ['ORG_INVALID_INPUT', 'ORG_BRANCH_NOT_FOUND', 'ORG_DEPARTMENT_NOT_FOUND', 'ORG_CONFLICT', 'ORG_UNAVAILABLE',
  'ORG_CLIENT_UPDATE_REQUIRED', 'ORG_OPERATION_CONFLICT'] as const;
export const numberingErrorCodes = ['NUMBERING_INVALID_INPUT', 'NUMBERING_INVALID_PREFIX', 'NUMBERING_DUPLICATE_CODE', 'NUMBERING_DUPLICATE_PREFIX',
  'NUMBERING_NOT_FOUND', 'NUMBERING_CONFLICT', 'NUMBERING_LOCKED', 'NUMBERING_UNAVAILABLE'] as const;
export const auditErrorCodes = ['AUDIT_INVALID_INPUT', 'AUDIT_NOT_FOUND', 'AUDIT_UNAVAILABLE'] as const;
export const genericErrorCodes = ['PARSE_ERROR', 'BAD_REQUEST', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'NOT_FOUND', 'METHOD_NOT_SUPPORTED',
  'DB_BUSY', 'DB_WAIT_TIMEOUT', 'DB_CLOSED',
  'TIMEOUT', 'CONFLICT', 'TOO_MANY_REQUESTS', 'UNAUTHORIZED', 'FORBIDDEN', 'INTERNAL_SERVER_ERROR', 'SERVICE_UNAVAILABLE',
  'NOT_IMPLEMENTED', 'BAD_GATEWAY', 'GATEWAY_TIMEOUT', 'PAYMENT_REQUIRED', 'PRECONDITION_FAILED', 'UNPROCESSABLE_CONTENT',
  'PRECONDITION_REQUIRED', 'CLIENT_CLOSED_REQUEST'] as const;
export const publicErrorCodes = [...authErrorCodes, ...usersErrorCodes, ...overridesErrorCodes, ...organizationErrorCodes,
  ...numberingErrorCodes, ...auditErrorCodes, ...genericErrorCodes] as const;
export type PublicErrorCode = typeof publicErrorCodes[number];
export type GenericErrorCode = typeof genericErrorCodes[number];
export type PublicErrorMessageKey = 'invalidRequest' | 'requestTooLarge' | 'unsupportedMediaType' | 'notFound' | 'methodNotAllowed'
  | 'rateLimited' | 'sessionExpired' | 'forbidden' | 'conflict' | 'databaseBusy' | 'databaseWaitTimeout' | 'serviceUnavailable' | 'requestFailed';
export type PublicErrorBody = { code: PublicErrorCode; messageKey: PublicErrorMessageKey; requestId: string };
const knownCodes = new Set<string>(publicErrorCodes);
export function isPublicErrorCode(value: unknown): value is PublicErrorCode { return typeof value === 'string' && knownCodes.has(value); }
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
export function messageKeyFor(code: PublicErrorCode): PublicErrorMessageKey {
  if (code === 'DB_BUSY') return 'databaseBusy';
  if (code === 'DB_WAIT_TIMEOUT') return 'databaseWaitTimeout';
  if (code === 'DB_CLOSED') return 'serviceUnavailable';
  if (code === 'PAYLOAD_TOO_LARGE') return 'requestTooLarge';
  if (code === 'UNSUPPORTED_MEDIA_TYPE') return 'unsupportedMediaType';
  if (code === 'METHOD_NOT_SUPPORTED') return 'methodNotAllowed';
  if (code === 'AUTH_RATE_LIMITED' || code === 'TOO_MANY_REQUESTS') return 'rateLimited';
  if (code === 'AUTH_REQUIRED' || code === 'UNAUTHORIZED') return 'sessionExpired';
  if (code === 'AUTH_FORBIDDEN' || code === 'AUTH_CSRF' || code === 'FORBIDDEN' || code === 'USERS_SELF_CHANGE' || code === 'OVERRIDES_SELF_CHANGE') return 'forbidden';
  if (code === 'NOT_FOUND' || code.endsWith('_NOT_FOUND')) return 'notFound';
  if (code === 'CONFLICT' || code.endsWith('_CONFLICT') || code.includes('_DUPLICATE_') || code === 'NUMBERING_LOCKED' || code === 'USERS_ALREADY_DISABLED') return 'conflict';
  if (code === 'SERVICE_UNAVAILABLE' || code.endsWith('_UNAVAILABLE') || code === 'BAD_GATEWAY' || code === 'GATEWAY_TIMEOUT') return 'serviceUnavailable';
  if (code === 'PARSE_ERROR' || code === 'BAD_REQUEST' || code.endsWith('_INVALID_INPUT') || code === 'NUMBERING_INVALID_PREFIX' || code === 'ORG_CLIENT_UPDATE_REQUIRED'
    || code === 'PRECONDITION_FAILED' || code === 'UNPROCESSABLE_CONTENT' || code === 'PRECONDITION_REQUIRED') return 'invalidRequest';
  return 'requestFailed';
}
