import type { NormalizedAuditEvent } from './event.ts';

export const auditDeliveryErrorCodes = ['AUDIT_UNSAFE_EVENT', 'AUDIT_EVENT_CONFLICT', 'AUDIT_DELIVERY_FAILED', 'AUDIT_LEASE_EXPIRED'] as const;
export type AuditDeliveryErrorCode = typeof auditDeliveryErrorCodes[number];
export type AuditDeliveryClaim = { eventId: string; leaseToken: string | null; leaseExpiresAt: string | null };
export type AuditDeliveryRecord = AuditDeliveryClaim & { event: unknown; deliveryState: string; attemptCount: number };
export interface AuditDeliveryTransaction {
  getOutbox(eventId: string): Promise<AuditDeliveryRecord | null>;
  now(): Promise<string>;
  getEvent(eventId: string): Promise<unknown | null>;
  insertEvent(event: NormalizedAuditEvent): Promise<void>;
  acknowledge(eventId: string, leaseToken: string): Promise<boolean>;
  fail(eventId: string, leaseToken: string, errorCode: AuditDeliveryErrorCode, retryDelayMs: number | null): Promise<boolean>;
}
export interface AuditDeliveryStore {
  listDue(limit: number): Promise<string[]>;
  listExpired(limit: number): Promise<AuditDeliveryClaim[]>;
  recoverExpired(claim: AuditDeliveryClaim): Promise<boolean>;
  claim(eventId: string, leaseToken: string, leaseMs: number): Promise<boolean>;
  transaction<T>(work: (tx: AuditDeliveryTransaction) => Promise<T>): Promise<T>;
}
