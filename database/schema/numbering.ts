import { sql } from 'drizzle-orm';
import { bigint, boolean, foreignKey, index, json, mysqlTable, primaryKey, tinyint, uniqueIndex } from 'drizzle-orm/mysql-core';
import { users } from './auth.ts';
import { asciiKey, identifier, sha256, unicodeText, utcTimestamp, version } from './columns.ts';

export const numberingSeries = mysqlTable('numbering_series', {
  id: identifier('id').notNull(),
  code: asciiKey('code', { length: 64 }).notNull(),
  prefix: asciiKey('prefix', { length: 16 }).notNull(),
  format: unicodeText('format', { length: 100 }).notNull(),
  paddingWidth: tinyint('padding_width', { unsigned: true }).notNull(),
  resetPolicy: asciiKey('reset_policy', { length: 10 }).notNull(),
  enabled: boolean('enabled').notNull(),
  version: version('version'),
  createdAt: utcTimestamp('created_at').notNull(),
  updatedAt: utcTimestamp('updated_at').notNull(),
  createdBy: identifier('created_by').notNull(),
  updatedBy: identifier('updated_by').notNull(),
}, table => [
  primaryKey({ name: 'pk_numbering_series', columns: [table.id] }),
  // Resolve a series by its code and reserve each visible prefix globally.
  uniqueIndex('uq_numbering_series_code').on(table.code),
  uniqueIndex('uq_numbering_series_prefix').on(table.prefix),
]);

export const numberingCounters = mysqlTable('numbering_counters', {
  seriesId: identifier('series_id').notNull(),
  periodKey: asciiKey('period_key', { length: 4 }).notNull(),
  lastValue: bigint('last_value', { mode: 'bigint', unsigned: true }).notNull().default(sql`0`),
}, table => [
  primaryKey({ name: 'pk_numbering_counters', columns: [table.seriesId, table.periodKey] }),
  foreignKey({ name: 'fk_numbering_counter_series', columns: [table.seriesId], foreignColumns: [numberingSeries.id] })
    .onUpdate('restrict').onDelete('restrict'),
]);

export const numberingIssuances = mysqlTable('numbering_issuances', {
  id: identifier('id').notNull(),
  seriesId: identifier('series_id').notNull(),
  periodKey: asciiKey('period_key', { length: 4 }).notNull(),
  sequenceValue: bigint('sequence_value', { mode: 'bigint', unsigned: true }).notNull(),
  formattedNumber: asciiKey('formatted_number', { length: 64 }).notNull(),
  configSnapshot: json('config_snapshot').notNull(),
  issuedAt: utcTimestamp('issued_at').notNull(),
  actorUserId: identifier('actor_user_id').notNull(),
  actionKey: asciiKey('action_key', { length: 96 }).notNull(),
  requestKey: identifier('request_key').notNull(),
  payloadHash: sha256('payload_hash').notNull(),
  targetModule: asciiKey('target_module', { length: 64 }).notNull(),
  targetId: identifier('target_id').notNull(),
}, table => [
  primaryKey({ name: 'pk_numbering_issuances', columns: [table.id] }),
  // Uniqueness covers the displayed number, the allocated sequence, and replay of one request.
  uniqueIndex('uq_numbering_issuances_number').on(table.formattedNumber),
  uniqueIndex('uq_numbering_issuances_sequence').on(table.seriesId, table.periodKey, table.sequenceValue),
  uniqueIndex('uq_numbering_issuances_request').on(table.actorUserId, table.actionKey, table.requestKey),
  // Resolve the issued number from its business record.
  index('ix_numbering_issuances_target').on(table.targetModule, table.targetId),
  foreignKey({
    name: 'fk_numbering_issuance_counter',
    columns: [table.seriesId, table.periodKey],
    foreignColumns: [numberingCounters.seriesId, numberingCounters.periodKey],
  }).onUpdate('restrict').onDelete('restrict'),
  foreignKey({ name: 'fk_numbering_issuance_actor', columns: [table.actorUserId], foreignColumns: [users.id] })
    .onUpdate('restrict').onDelete('restrict'),
]);
