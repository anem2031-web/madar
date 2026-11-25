import { foreignKey, index, json, mysqlTable, primaryKey } from 'drizzle-orm/mysql-core';
import { users } from './auth.ts';
import { asciiKey, identifier, sha256, utcTimestamp } from './columns.ts';

export const writeOperationReceipts = mysqlTable('write_operation_receipts', {
  operationId: identifier('operation_id').notNull(),
  actorUserId: identifier('actor_user_id').notNull(),
  operationCode: asciiKey('operation_code', { length: 96 }).notNull(),
  inputHash: sha256('input_hash').notNull(),
  reservationToken: identifier('reservation_token').notNull(),
  response: json('response_json').$type<unknown>(),
  createdAt: utcTimestamp('created_at').notNull(),
}, table => [
  // Resolve, lock, finish and cancel one operation by its globally unique request identity.
  primaryKey({ name: 'pk_write_operation_receipts', columns: [table.operationId] }),
  // Support the user foreign key; receipts are not listed or searched by the application.
  index('ix_write_operation_receipts_actor').on(table.actorUserId),
  foreignKey({ name: 'fk_write_operation_receipts_actor', columns: [table.actorUserId], foreignColumns: [users.id] })
    .onUpdate('restrict').onDelete('restrict'),
]);
