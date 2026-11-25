import { createHash, randomUUID } from 'node:crypto';
import type { WriteOperationsTransaction } from './store.ts';

export class WriteOperationConflict extends Error {
  constructor() {
    super('The write operation does not match its receipt.');
    this.name = 'WriteOperationConflict';
  }
}

type Input = Readonly<Record<string, string | number | boolean | null>>;

export function writeInputHash(operationCode: string, input: Input): Buffer {
  const entries = Object.keys(input).sort().map(key => [key, input[key]]);
  return createHash('sha256').update(JSON.stringify([operationCode, entries])).digest();
}

export async function executeWriteOperation<T>(tx: WriteOperationsTransaction, options: {
  operationId: string;
  actorUserId: string;
  operationCode: string;
  input: Input;
  now: Date;
  readResponse: (value: unknown) => T;
  execute: () => Promise<T>;
}): Promise<{ value: T; replayed: boolean }> {
  const reservationToken = randomUUID();
  const inputHash = writeInputHash(options.operationCode, options.input);
  const receipt = await tx.claimWriteOperation({ operationId: options.operationId, actorUserId: options.actorUserId,
    operationCode: options.operationCode, inputHash, reservationToken, response: null, createdAt: options.now });

  if (receipt.operationId !== options.operationId || receipt.actorUserId !== options.actorUserId || receipt.operationCode !== options.operationCode
      || !Buffer.from(receipt.inputHash).equals(inputHash)) throw new WriteOperationConflict();
  if (receipt.response !== null) return { value: options.readResponse(receipt.response), replayed: true };
  if (receipt.reservationToken !== reservationToken) throw new Error('Incomplete write receipt is unavailable.');

  try {
    const value = options.readResponse(await options.execute());
    if (value === null || value === undefined) throw new Error('Write result is unavailable.');
    if (!await tx.completeWriteOperation(options.operationId, reservationToken, value)) {
      // This must remain unexpected so callers roll back business writes, not commit a rejection.
      throw new Error('Write receipt could not complete.');
    }
    return { value, replayed: false };
  } catch (error) {
    // A caller may commit an expected business rejection; do not leave our empty reservation behind.
    await tx.cancelWriteOperation(options.operationId, reservationToken);
    throw error;
  }
}
