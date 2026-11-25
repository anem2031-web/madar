import ar from '../../../../shared/i18n/ar/audit.ts';
import en from '../../../../shared/i18n/en/audit.ts';
import type { Language } from '../../i18n/locale.ts';

export type AuditLabels = Record<keyof typeof ar, string>;
export const auditMessages: Record<Language, AuditLabels> = { ar, en };
const moduleKeys: Record<string, keyof AuditLabels> = {
  auth: 'moduleAuth', users: 'moduleUsers', permissions: 'modulePermissions', organization: 'moduleOrganization', numbering: 'moduleNumbering', audit: 'moduleAudit',
};
const actionKeys: Record<string, keyof AuditLabels> = {
  'auth.login': 'login', 'auth.password_change': 'passwordChange', 'auth.logout': 'logout', 'auth.csrf': 'csrfCheck', 'auth.permission': 'permissionCheck', 'auth.bootstrap_admin': 'bootstrapAdmin', 'auth.admin_recovery': 'adminRecovery',
  'users.list': 'usersList', 'users.roles': 'usersRoles', 'users.create': 'usersCreate', 'users.assign_role': 'usersAssignRole', 'users.disable': 'usersDisable', 'users.reset_password': 'usersResetPassword',
  'permissions.overrides.list': 'overridesList', 'permissions.overrides.detail': 'overridesDetail', 'permissions.overrides.save': 'overridesSave',
  'organization.branches.list': 'branchesList', 'organization.branches.create': 'branchesCreate', 'organization.branches.rename': 'branchesRename',
  'organization.departments.list': 'departmentsList', 'organization.departments.create': 'departmentsCreate', 'organization.departments.rename': 'departmentsRename',
  'organization.branches.create.replay': 'branchesCreateReplay', 'organization.branches.rename.replay': 'branchesRenameReplay',
  'organization.departments.create.replay': 'departmentsCreateReplay', 'organization.departments.rename.replay': 'departmentsRenameReplay',
  'numbering.series.list': 'numberingList', 'numbering.series.create': 'numberingCreate', 'numbering.series.update': 'numberingUpdate',
  'audit.list': 'auditList', 'audit.detail': 'auditDetail', 'audit.delivery': 'auditDelivery',
};
const reasonKeys: Record<string, keyof AuditLabels> = {
  invalid_credentials: 'reasonCredentials', csrf_failed: 'reasonCsrf', rate_limited: 'reasonRate', authorized_local_recovery: 'reasonRecovery',
  AUTH_INVALID_CREDENTIALS: 'reasonCredentials', AUTH_REQUIRED: 'reasonSession', AUTH_FORBIDDEN: 'reasonPermission', AUTH_CSRF: 'reasonCsrf', AUTH_RATE_LIMITED: 'reasonRate',
  AUTH_INVALID_INPUT: 'reasonValidation', AUTH_PASSWORD_POLICY: 'reasonValidation', AUTH_PASSWORD_REUSED: 'reasonValidation', AUTH_UNAVAILABLE: 'reasonUnavailable',
  USERS_REAUTH_FAILED: 'reasonCredentials', USERS_DUPLICATE_USERNAME: 'reasonDuplicate', USERS_SELF_CHANGE: 'reasonSelf', USERS_NOT_FOUND: 'reasonNotFound', USERS_ROLE_NOT_FOUND: 'reasonNotFound', USERS_CONFLICT: 'reasonConflict', USERS_ALREADY_DISABLED: 'reasonConflict', USERS_INVALID_INPUT: 'reasonValidation', USERS_UNAVAILABLE: 'reasonUnavailable',
  OVERRIDES_REAUTH_FAILED: 'reasonCredentials', OVERRIDES_SELF_CHANGE: 'reasonSelf', OVERRIDES_CONFLICT: 'reasonConflict', OVERRIDES_NOT_FOUND: 'reasonNotFound', OVERRIDES_INVALID_INPUT: 'reasonValidation', OVERRIDES_UNAVAILABLE: 'reasonUnavailable',
  ORG_INVALID_INPUT: 'reasonValidation', ORG_BRANCH_NOT_FOUND: 'reasonNotFound', ORG_DEPARTMENT_NOT_FOUND: 'reasonNotFound', ORG_CONFLICT: 'reasonConflict', ORG_UNAVAILABLE: 'reasonUnavailable',
  ORG_OPERATION_CONFLICT: 'reasonOperationConflict', ORG_CLIENT_UPDATE_REQUIRED: 'reasonClientUpdate',
  NUMBERING_INVALID_INPUT: 'reasonValidation', NUMBERING_INVALID_PREFIX: 'reasonValidation', NUMBERING_DUPLICATE_CODE: 'reasonDuplicate', NUMBERING_DUPLICATE_PREFIX: 'reasonDuplicate', NUMBERING_NOT_FOUND: 'reasonNotFound', NUMBERING_CONFLICT: 'reasonConflict', NUMBERING_LOCKED: 'reasonLocked', NUMBERING_UNAVAILABLE: 'reasonUnavailable',
  AUDIT_INVALID_INPUT: 'reasonValidation', AUDIT_NOT_FOUND: 'reasonNotFound', AUDIT_UNAVAILABLE: 'reasonUnavailable',
};
export const moduleLabel = (value: string, labels: AuditLabels) => labels[moduleKeys[value] ?? 'unknownModule'];
export const actionLabel = (value: string, labels: AuditLabels) => labels[actionKeys[value] ?? 'unknownAction'];
export const reasonLabel = (value: string | null, labels: AuditLabels) => value ? labels[reasonKeys[value] ?? 'unknownReason'] : labels.notRecorded;
export const roleLabel = (value: string | null, labels: AuditLabels) => value === 'system_admin' ? labels.adminRole : value === 'hr' ? labels.hrRole : value ? labels.unknownRole : labels.notRecorded;
