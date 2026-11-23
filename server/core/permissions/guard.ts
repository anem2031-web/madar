import type { AuthUser } from '../../modules/auth/store.ts';
import { isPermissionCode } from '../../../shared/permissions/catalog.ts';

export function effectivePermissions(user: AuthUser) {
  const result = new Set(user.rolePermissions.filter(isPermissionCode));
  for (const override of user.overrides) {
    if (!isPermissionCode(override.permissionCode)) continue;
    if (override.effect === 'grant') result.add(override.permissionCode);
    else result.delete(override.permissionCode);
  }
  return [...result].sort();
}

export function hasPermission(user: AuthUser, permission: string) {
  return isPermissionCode(permission) && effectivePermissions(user).includes(permission);
}
