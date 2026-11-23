export type OverridesReason = 'OVERRIDES_INVALID_INPUT' | 'OVERRIDES_NOT_FOUND' | 'OVERRIDES_CONFLICT'
  | 'OVERRIDES_SELF_CHANGE' | 'OVERRIDES_REAUTH_FAILED' | 'OVERRIDES_UNAVAILABLE';

export class OverridesFault extends Error {
  readonly reason: OverridesReason;
  readonly requestId?: string;
  constructor(reason: OverridesReason, requestId?: string) {
    super(reason);
    this.reason = reason;
    this.requestId = requestId;
  }
}
