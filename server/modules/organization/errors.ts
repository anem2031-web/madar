export type OrganizationReason = 'ORG_INVALID_INPUT' | 'ORG_BRANCH_NOT_FOUND' | 'ORG_DEPARTMENT_NOT_FOUND' | 'ORG_CONFLICT'
  | 'ORG_CLIENT_UPDATE_REQUIRED' | 'ORG_OPERATION_CONFLICT' | 'ORG_UNAVAILABLE';

export class OrganizationFault extends Error {
  readonly reason: OrganizationReason;
  readonly requestId?: string;
  constructor(reason: OrganizationReason, requestId?: string) {
    super(reason);
    this.name = 'OrganizationFault';
    this.reason = reason;
    this.requestId = requestId;
  }
}
