import ar from '../../../../shared/i18n/ar/permission-overrides.ts';
import en from '../../../../shared/i18n/en/permission-overrides.ts';
import type { PermissionCode } from '../../../../shared/permissions/catalog.ts';
import type { Language } from '../../i18n/locale.ts';

export type PermissionLabels = Record<keyof typeof ar, string>;
export const permissionMessages: Record<Language, PermissionLabels> = { ar, en };

export const permissionLabelKeys = {
  'employees.read': 'employeeRead',
  'employees.create': 'employeeCreate',
  'employees.update': 'employeeUpdate',
  'employees.change_status': 'employeeStatus',
  'organization.read': 'organizationRead',
  'users.manage': 'usersManage',
  'roles.manage': 'rolesManage',
  'permissions.manage_overrides': 'overridesManage',
  'settings.manage': 'settingsManage',
  'audit.read': 'auditRead',
} satisfies Record<PermissionCode, keyof PermissionLabels>;
