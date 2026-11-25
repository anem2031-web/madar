import type { Branch, Department } from './store.ts';

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key))) throw new Error('Stored organization response is invalid.');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Stored organization identifier is invalid.');
  }
  return value;
}
function entity(value: unknown, department: boolean): Branch | Department {
  const row = record(value, department ? ['id', 'branchId', 'name', 'version'] : ['id', 'name', 'version']);
  if (typeof row.name !== 'string' || !row.name.trim() || row.name !== row.name.trim() || Array.from(row.name).length > 150
      || typeof row.version !== 'number' || !Number.isInteger(row.version) || row.version < 1 || row.version > 4_294_967_295) {
    throw new Error('Stored organization entity is invalid.');
  }
  const branch: Branch = { id: identifier(row.id), name: row.name, version: row.version };
  return department ? { ...branch, branchId: identifier(row.branchId) } : branch;
}
function changed(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Stored organization change result is invalid.');
  return value;
}

export function readCreatedBranch(value: unknown): { branch: Branch } {
  const row = record(value, ['branch']);
  return { branch: entity(row.branch, false) };
}
export function readRenamedBranch(value: unknown): { changed: boolean; branch: Branch } {
  const row = record(value, ['changed', 'branch']);
  return { changed: changed(row.changed), branch: entity(row.branch, false) };
}
export function readCreatedDepartment(value: unknown): { department: Department } {
  const row = record(value, ['department']);
  return { department: entity(row.department, true) as Department };
}
export function readRenamedDepartment(value: unknown): { changed: boolean; department: Department } {
  const row = record(value, ['changed', 'department']);
  return { changed: changed(row.changed), department: entity(row.department, true) as Department };
}
