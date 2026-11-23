import { index, int, json, mysqlTable, primaryKey } from 'drizzle-orm/mysql-core';
import { asciiKey, identifier, utcTimestamp } from './columns.ts';

const eventColumns = () => ({
  eventId: identifier('event_id').notNull(),
  occurredAt: utcTimestamp('occurred_at').notNull(),
  actorUserId: identifier('actor_user_id'),
  actorRoleId: identifier('actor_role_id'),
  actorRoleCode: asciiKey('actor_role_code', { length: 64 }),
  module: asciiKey('module', { length: 64 }).notNull(),
  action: asciiKey('action', { length: 96 }).notNull(),
  entityId: identifier('entity_id'),
  entityVersion: int('entity_version', { unsigned: true }),
  requestId: identifier('request_id').notNull(),
  result: asciiKey('result', { length: 16 }).notNull(),
  reasonCode: asciiKey('reason_code', { length: 96 }),
  beforeValues: json('before_values'),
  afterValues: json('after_values'),
  metadata: json('metadata'),
});

export const auditOutbox = mysqlTable('audit_outbox', {
  ...eventColumns(),
  deliveryState: asciiKey('delivery_state', { length: 12 }).notNull().default('pending'),
  nextAttemptAt: utcTimestamp('next_attempt_at').notNull(),
  attemptCount: int('attempt_count', { unsigned: true }).notNull().default(0),
  leaseToken: identifier('lease_token'),
  leaseExpiresAt: utcTimestamp('lease_expires_at'),
  deliveredAt: utcTimestamp('delivered_at'),
  lastErrorCode: asciiKey('last_error_code', { length: 96 }),
}, table => [
  primaryKey({ name: 'pk_audit_outbox', columns: [table.eventId] }),
  // Read due deliveries and expired leases through distinct date ranges.
  index('ix_audit_outbox_delivery').on(table.deliveryState, table.nextAttemptAt, table.eventId),
  index('ix_audit_outbox_lease').on(table.deliveryState, table.leaseExpiresAt, table.eventId),
]);

export const auditEvents = mysqlTable('audit_events', eventColumns(), table => [
  primaryKey({ name: 'pk_audit_events', columns: [table.eventId] }),
  // Support audit browsing by time, actor, and resource history.
  index('ix_audit_events_time').on(table.occurredAt, table.eventId),
  index('ix_audit_events_actor').on(table.actorUserId, table.occurredAt, table.eventId),
  index('ix_audit_events_resource').on(table.module, table.entityId, table.entityVersion, table.occurredAt, table.eventId),
]);
