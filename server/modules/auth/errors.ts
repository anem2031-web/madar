export type AuthReason = 'AUTH_INVALID_CREDENTIALS' | 'AUTH_RATE_LIMITED' | 'AUTH_REQUIRED'
  | 'AUTH_FORBIDDEN' | 'AUTH_CSRF' | 'AUTH_INVALID_INPUT' | 'AUTH_PASSWORD_POLICY'
  | 'AUTH_PASSWORD_REUSED' | 'AUTH_UNAVAILABLE';

export class AuthFault extends Error {
  readonly reason: AuthReason;
  readonly requestId?: string;
  constructor(reason: AuthReason, requestId?: string) {
    super(reason);
    this.reason = reason;
    this.requestId = requestId;
  }
}
