export type WriteOperationReceipt = {
  operationId: string;
  actorUserId: string;
  operationCode: string;
  inputHash: Buffer;
  reservationToken: string;
  response: unknown | null;
  createdAt: Date;
};

// All three methods run inside the same transaction as the business change and audit.
export interface WriteOperationsTransaction {
  claimWriteOperation(receipt: WriteOperationReceipt): Promise<WriteOperationReceipt>;
  completeWriteOperation(operationId: string, reservationToken: string, response: unknown): Promise<boolean>;
  cancelWriteOperation(operationId: string, reservationToken: string): Promise<void>;
}
