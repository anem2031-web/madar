import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { numberingIssuances, numberingSeries } from '../../../database/schema/numbering.ts';
import type { NumberingResetPolicy } from '../../../shared/numbering/settings.ts';
import type { DatabaseConnection, DatabaseTransaction } from '../database/connection.ts';
import { authTransaction, sqlUtc } from '../../modules/auth/repository.ts';
import { NumberingFault } from './errors.ts';
import type { NumberingSettingsStore, NumberingSettingsTransaction } from './store.ts';

const seriesFields = { id: numberingSeries.id, code: numberingSeries.code, prefix: numberingSeries.prefix,
  format: numberingSeries.format, paddingWidth: numberingSeries.paddingWidth, resetPolicy: numberingSeries.resetPolicy,
  enabled: numberingSeries.enabled, version: numberingSeries.version };
function storedPolicy(value: string): NumberingResetPolicy {
  if (value !== 'annual' && value !== 'continuous') throw new NumberingFault('NUMBERING_UNAVAILABLE');
  return value;
}

function numberingTransaction(tx: DatabaseTransaction): NumberingSettingsTransaction {
  return {
    ...authTransaction(tx),
    async listSeries(cursor, limit) {
      const rows = await tx.select({ ...seriesFields,
        // Identifiers retain their qualification when Drizzle builds a single-table projection.
        hasIssued: sql<number>`exists (select 1 from ${numberingIssuances}
          where ${sql.identifier('numbering_issuances')}.${sql.identifier('series_id')} = ${sql.identifier('numbering_series')}.${sql.identifier('id')} limit 1)`,
      }).from(numberingSeries).where(cursor ? gt(numberingSeries.id, cursor) : undefined).orderBy(asc(numberingSeries.id)).limit(limit);
      return rows.map(row => ({ ...row, resetPolicy: storedPolicy(row.resetPolicy), hasIssued: Number(row.hasIssued) === 1 }));
    },
    async getSeries(seriesId) {
      const [row] = await tx.select(seriesFields).from(numberingSeries).where(eq(numberingSeries.id, seriesId)).limit(1).for('update');
      return row ? { ...row, resetPolicy: storedPolicy(row.resetPolicy) } : null;
    },
    async hasIssuances(seriesId) {
      // Current read after locking the parent; a pre-lock snapshot could miss a committed issuance.
      const [row] = await tx.select({ id: numberingIssuances.id }).from(numberingIssuances)
        .where(eq(numberingIssuances.seriesId, seriesId)).limit(1).for('update');
      return !!row;
    },
    async insertSeries(series, actorId, now) {
      await tx.insert(numberingSeries).values({ ...series, createdAt: sqlUtc(now), updatedAt: sqlUtc(now), createdBy: actorId, updatedBy: actorId });
    },
    async updateSeries(seriesId, expectedVersion, changes, actorId, now) {
      const [result] = await tx.update(numberingSeries).set({ ...changes, version: sql`${numberingSeries.version} + 1`, updatedAt: sqlUtc(now), updatedBy: actorId })
        .where(and(eq(numberingSeries.id, seriesId), eq(numberingSeries.version, expectedVersion)));
      return result.affectedRows === 1;
    },
  };
}

export function createNumberingSettingsStore(connection: DatabaseConnection): NumberingSettingsStore {
  return { transaction: work => connection.transaction(tx => work(numberingTransaction(tx))) };
}
