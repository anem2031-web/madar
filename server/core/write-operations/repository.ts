import { and, eq, isNull, sql } from 'drizzle-orm';
import { writeOperationReceipts } from '../../../database/schema/write-operations.ts';
import type { DatabaseTransaction } from '../database/connection.ts';
import { sqlUtc } from '../../modules/auth/repository.ts';
import type { WriteOperationReceipt, WriteOperationsTransaction } from './store.ts';

function receipt(row: typeof writeOperationReceipts.$inferSelect): WriteOperationReceipt {
  return { ...row, inputHash: Buffer.from(row.inputHash),
    createdAt: new Date(row.createdAt.replace(' ', 'T') + 'Z') };
}

export function writeOperationsTransaction(tx: DatabaseTransaction): WriteOperationsTransaction {
  return {
    async claimWriteOperation(value) {
      // Materialize the unique key before locking it; ownership comes from the token, not affectedRows.
      await tx.insert(writeOperationReceipts).values({ ...value, createdAt: sqlUtc(value.createdAt) })
        .onDuplicateKeyUpdate({ set: { operationId: sql`${writeOperationReceipts.operationId}` } });
      const [row] = await tx.select().from(writeOperationReceipts)
        .where(eq(writeOperationReceipts.operationId, value.operationId)).limit(1).for('update');
      if (!row) throw new Error('Write operation receipt unavailable.');
      return receipt(row);
    },
    async completeWriteOperation(operationId, reservationToken, response) {
      if (response === null || response === undefined) throw new Error('Completed write operation response required.');
      const [result] = await tx.update(writeOperationReceipts).set({ response })
        .where(and(eq(writeOperationReceipts.operationId, operationId), eq(writeOperationReceipts.reservationToken, reservationToken), isNull(writeOperationReceipts.response)));
      return result.affectedRows === 1;
    },
    async cancelWriteOperation(operationId, reservationToken) {
      await tx.delete(writeOperationReceipts)
        .where(and(eq(writeOperationReceipts.operationId, operationId), eq(writeOperationReceipts.reservationToken, reservationToken), isNull(writeOperationReceipts.response)));
    },
  };
}
