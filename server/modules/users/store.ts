import type { AuthStore, AuthTransaction } from '../auth/store.ts';

export type ManagedRole = { id: string; code: string; name: string };
export type ManagedUser = {
  id: string;
  username: string;
  roleId: string;
  roleCode: string;
  accountStatus: 'active' | 'disabled';
  mustChangePassword: boolean;
  authVersion: number;
};

export interface UsersTransaction extends AuthTransaction {
  clearReauthThrottle(key: Buffer): Promise<void>;
  listUsers(cursor: string | undefined, limit: number): Promise<ManagedUser[]>;
  listRoles(): Promise<ManagedRole[]>;
  getManagedUser(userId: string): Promise<ManagedUser | null>;
  getRole(roleId: string): Promise<ManagedRole | null>;
  insertUser(input: { id: string; username: string; roleId: string; passwordHash: string; now: Date }): Promise<void>;
  assignRole(userId: string, expectedAuthVersion: number, roleId: string, now: Date): Promise<boolean>;
  disableUser(userId: string, expectedAuthVersion: number, now: Date): Promise<boolean>;
  resetPassword(userId: string, expectedAuthVersion: number, passwordHash: string, now: Date): Promise<boolean>;
}

export interface UsersStore extends AuthStore {
  transaction<T>(work: (tx: UsersTransaction) => Promise<T>): Promise<T>;
}
