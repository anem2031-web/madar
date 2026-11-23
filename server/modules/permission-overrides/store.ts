import type { PermissionCode } from '../../../shared/permissions/catalog.ts';
import type { AuthStore, AuthTransaction } from '../auth/store.ts';

export type UserOverride = { permissionCode: PermissionCode; effect: 'grant' | 'deny' };
export type PermissionUser = {
  id: string;
  username: string;
  roleCode: string;
  accountStatus: 'active' | 'disabled';
  authVersion: number;
};
export type PermissionDetail = {
  user: PermissionUser;
  rolePermissions: PermissionCode[];
  overrides: UserOverride[];
  effectivePermissions: PermissionCode[];
  editable: boolean;
};

export interface PermissionOverridesTransaction extends AuthTransaction {
  listPermissionUsers(cursor: string | undefined, limit: number): Promise<PermissionUser[]>;
  clearReauthThrottle(key: Buffer): Promise<void>;
  bumpAuthVersion(userId: string, expectedAuthVersion: number, now: Date): Promise<boolean>;
  replaceOverrides(userId: string, overrides: UserOverride[], now: Date): Promise<void>;
}
export interface PermissionOverridesStore extends AuthStore {
  transaction<T>(work: (tx: PermissionOverridesTransaction) => Promise<T>): Promise<T>;
}
