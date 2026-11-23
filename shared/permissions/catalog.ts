export const permissionCodes = [
  'employees.read', 'employees.create', 'employees.update', 'employees.change_status',
  'organization.read', 'users.manage', 'roles.manage', 'permissions.manage_overrides',
  'settings.manage', 'audit.read',
] as const;

export type PermissionCode = typeof permissionCodes[number];

export const initialRolePermissions = {
  system_admin: [
    'employees.read', 'employees.create', 'employees.update', 'employees.change_status',
    'organization.read', 'users.manage', 'roles.manage', 'permissions.manage_overrides',
    'settings.manage', 'audit.read',
  ],
  hr: ['employees.read', 'employees.create', 'employees.update', 'employees.change_status', 'organization.read'],
} as const satisfies Record<'system_admin' | 'hr', readonly PermissionCode[]>;

export function isPermissionCode(value: string): value is PermissionCode {
  return (permissionCodes as readonly string[]).includes(value);
}
