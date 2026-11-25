export const auditModules = ['auth', 'users', 'permissions', 'organization', 'numbering', 'audit'] as const;
export type AuditModule = typeof auditModules[number];
export const auditResults = ['success', 'denied', 'failed'] as const;
export type AuditResult = typeof auditResults[number];
export type AuditCursor = { occurredAt: string; eventId: string };
export type AuditListInput = { from: string; to: string; actorUserId?: string; module?: AuditModule; result?: AuditResult; cursor?: AuditCursor };
export type AuditDetailInput = { eventId: string };
type AuditValueFields = {
  roleId: string; accountStatus: 'active' | 'disabled'; mustChangePassword: boolean; authVersion: number;
  name: string; branchId: string; version: number; code: string; prefix: string; format: string; paddingWidth: number;
  resetPolicy: 'annual' | 'continuous'; enabled: boolean;
  overrides: { permissionCode: string; effect: 'grant' | 'deny' }[];
};
export type AuditValues = { [Key in keyof AuditValueFields]?: AuditValueFields[Key] | null };
export type AuditMetadata = { count?: number; changed?: boolean; operationId?: string; replayed?: boolean; entityType?: 'branch' | 'department';
  filterTypes?: ('period' | 'actorUserId' | 'module' | 'result')[] };
export type AuditEventSummary = {
  eventId: string; occurredAt: string; actorUserId: string | null; actorRoleId: string | null; actorRoleCode: string | null;
  module: string; action: string; entityId: string | null; entityVersion: number | null;
  requestId: string; result: AuditResult; reasonCode: string | null;
};
export type AuditEventDetail = AuditEventSummary & { beforeValues: AuditValues | null; afterValues: AuditValues | null; metadata: AuditMetadata | null };
export type AuditDeliveryStatus = { pending: number; leased: number; failed: number; oldestPendingAt: string | null;
  failures: { eventId: string; occurredAt: string | null; errorCode: string }[] };
export type AuditListResult = { events: AuditEventSummary[]; delivery: AuditDeliveryStatus; nextCursor?: AuditCursor };
export type AuditDetailResult = { event: AuditEventDetail };
