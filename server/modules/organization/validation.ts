import { OrganizationFault } from './errors.ts';

function record(input: unknown, required: string[], optional: string[] = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OrganizationFault('ORG_INVALID_INPUT');
  const value = input as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new OrganizationFault('ORG_INVALID_INPUT');
  }
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new OrganizationFault('ORG_INVALID_INPUT');
  return value.toLowerCase();
}
function name(value: unknown): string {
  if (typeof value !== 'string' || value.length > 600) throw new OrganizationFault('ORG_INVALID_INPUT');
  const result = value.trim();
  if (!result || Array.from(result).length > 150) throw new OrganizationFault('ORG_INVALID_INPUT');
  return result;
}
function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 4_294_967_295) throw new OrganizationFault('ORG_INVALID_INPUT');
  return value;
}
function writeRecord(input: unknown, required: string[]) {
  const value = record(input, required, ['operationId']);
  if (!Object.hasOwn(value, 'operationId')) throw new OrganizationFault('ORG_CLIENT_UPDATE_REQUIRED');
  return { value, operationId: identifier(value.operationId) };
}
export function listBranchesInput(input: unknown) {
  if (input === undefined) return {};
  const value = record(input, [], ['cursor']);
  return value.cursor === undefined ? {} : { cursor: identifier(value.cursor) };
}
export function listDepartmentsInput(input: unknown) {
  const value = record(input, ['branchId'], ['cursor']);
  return { branchId: identifier(value.branchId), ...(value.cursor === undefined ? {} : { cursor: identifier(value.cursor) }) };
}
export function createBranchInput(input: unknown) {
  const { value, operationId } = writeRecord(input, ['name']);
  return { operationId, name: name(value.name) };
}
export function renameBranchInput(input: unknown) {
  const { value, operationId } = writeRecord(input, ['branchId', 'expectedVersion', 'name']);
  return { operationId, branchId: identifier(value.branchId), expectedVersion: version(value.expectedVersion), name: name(value.name) };
}
export function createDepartmentInput(input: unknown) {
  const { value, operationId } = writeRecord(input, ['branchId', 'name']);
  return { operationId, branchId: identifier(value.branchId), name: name(value.name) };
}
export function renameDepartmentInput(input: unknown) {
  const { value, operationId } = writeRecord(input, ['branchId', 'departmentId', 'expectedVersion', 'name']);
  return { operationId, branchId: identifier(value.branchId), departmentId: identifier(value.departmentId), expectedVersion: version(value.expectedVersion), name: name(value.name) };
}
