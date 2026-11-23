import { date, foreignKey, index, mysqlTable, primaryKey, uniqueIndex } from 'drizzle-orm/mysql-core';
import { asciiKey, identifier, normalizedKey, unicodeText, utcTimestamp, version } from './columns.ts';
import { branches, departments } from './organization.ts';

export const employees = mysqlTable('employees', {
  id: identifier('id').notNull(),
  employeeNumber: unicodeText('employee_number', { length: 64 }).notNull(),
  fullName: unicodeText('full_name', { length: 200 }).notNull(),
  branchId: identifier('branch_id').notNull(),
  departmentId: identifier('department_id').notNull(),
  jobTitle: unicodeText('job_title', { length: 150 }).notNull(),
  joinedOn: date('joined_on', { mode: 'string' }).notNull(),
  employmentStatus: asciiKey('employment_status', { length: 8 }).notNull(),
  mobile: unicodeText('mobile', { length: 32 }),
  email: unicodeText('email', { length: 254 }),
  biometricNumber: unicodeText('biometric_number', { length: 64 }),
  residencyNumber: unicodeText('residency_number', { length: 64 }),
  passportNumber: unicodeText('passport_number', { length: 64 }),
  nationality: unicodeText('nationality', { length: 100 }),
  residencyExpiresOn: date('residency_expires_on', { mode: 'string' }),
  employeeNumberKey: normalizedKey('employee_number_key', 'employee_number').notNull(),
  biometricNumberKey: normalizedKey('biometric_number_key', 'biometric_number'),
  createdAt: utcTimestamp('created_at').notNull(),
  updatedAt: utcTimestamp('updated_at').notNull(),
  version: version('version'),
}, table => [
  primaryKey({ name: 'pk_employees', columns: [table.id] }),
  // Compare by the generated text keys while keeping the original identifiers for display.
  uniqueIndex('uq_employees_employee_number').on(table.employeeNumberKey),
  uniqueIndex('uq_employees_biometric_number').on(table.biometricNumberKey),
  // Match the directory's branch and department scopes and its order by number.
  index('ix_employees_branch_number').on(table.branchId, table.employeeNumberKey),
  index('ix_employees_branch_department_number').on(table.branchId, table.departmentId, table.employeeNumberKey),
  foreignKey({ name: 'fk_employees_branch', columns: [table.branchId], foreignColumns: [branches.id] })
    .onUpdate('restrict').onDelete('restrict'),
  foreignKey({
    name: 'fk_employees_department_branch',
    columns: [table.branchId, table.departmentId],
    foreignColumns: [departments.branchId, departments.id],
  }).onUpdate('restrict').onDelete('restrict'),
]);
