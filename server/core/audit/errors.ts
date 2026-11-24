export type AuditReason = 'AUDIT_INVALID_INPUT' | 'AUDIT_NOT_FOUND' | 'AUDIT_UNAVAILABLE';
export class AuditFault extends Error {
  readonly reason: AuditReason;
  readonly requestId?: string;
  constructor(reason: AuditReason, requestId?: string) { super(reason); this.reason = reason; this.requestId = requestId; }
}
