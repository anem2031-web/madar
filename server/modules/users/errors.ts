export type UsersReason = 'USERS_INVALID_INPUT' | 'USERS_DUPLICATE_USERNAME' | 'USERS_NOT_FOUND'
  | 'USERS_ROLE_NOT_FOUND' | 'USERS_CONFLICT' | 'USERS_ALREADY_DISABLED' | 'USERS_SELF_CHANGE'
  | 'USERS_REAUTH_FAILED' | 'USERS_UNAVAILABLE';

export class UsersFault extends Error {
  readonly reason: UsersReason;
  readonly requestId?: string;
  constructor(reason: UsersReason, requestId?: string) {
    super(reason);
    this.reason = reason;
    this.requestId = requestId;
  }
}
