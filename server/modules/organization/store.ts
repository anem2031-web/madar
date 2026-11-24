import type { AuthStore, AuthTransaction } from '../auth/store.ts';

export type Branch = { id: string; name: string; version: number };
export type Department = Branch & { branchId: string };

export interface OrganizationTransaction extends AuthTransaction {
  listBranches(cursor: string | undefined, limit: number): Promise<Branch[]>;
  listDepartments(branchId: string, cursor: string | undefined, limit: number): Promise<Department[]>;
  getBranch(branchId: string): Promise<Branch | null>;
  getDepartment(branchId: string, departmentId: string): Promise<Department | null>;
  insertBranch(branch: Branch, now: Date): Promise<void>;
  renameBranch(branchId: string, expectedVersion: number, name: string, now: Date): Promise<boolean>;
  insertDepartment(department: Department, now: Date): Promise<void>;
  renameDepartment(branchId: string, departmentId: string, expectedVersion: number, name: string, now: Date): Promise<boolean>;
}

export interface OrganizationStore extends AuthStore {
  transaction<T>(work: (tx: OrganizationTransaction) => Promise<T>): Promise<T>;
}
