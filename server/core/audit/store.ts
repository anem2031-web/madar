import type { AuthStore, AuthTransaction } from '../../modules/auth/store.ts';
import type { AuditListInput } from '../../../shared/audit/contracts.ts';

export type StoredAuditSummary = {
  eventId: string; occurredAt: string; actorUserId: string | null; actorRoleId: string | null; actorRoleCode: string | null;
  module: string; action: string; entityId: string | null; entityVersion: number | null; requestId: string; result: string; reasonCode: string | null;
};
export type StoredAuditEvent = StoredAuditSummary & { beforeValues: unknown; afterValues: unknown; metadata: unknown };
export type StoredDeliveryStatus = { pending: number; leased: number; failed: number; oldestPendingAt: string | null;
  failures: { eventId: string; occurredAt: string; errorCode: string | null }[] };
export interface AuditTransaction extends AuthTransaction {
  listEvents(input: AuditListInput, limit: number): Promise<StoredAuditSummary[]>;
  getEvent(eventId: string): Promise<StoredAuditEvent | null>;
  deliveryStatus(): Promise<StoredDeliveryStatus>;
}
export interface AuditStore extends AuthStore { transaction<T>(work: (tx: AuditTransaction) => Promise<T>): Promise<T> }
