import type { NumberingResetPolicy, NumberingSeries } from '../../../shared/numbering/settings.ts';
import type { AuthStore, AuthTransaction } from '../../modules/auth/store.ts';

export type NumberingSeriesRecord = Omit<NumberingSeries, 'hasIssued'>;
export type NumberingSeriesChanges = { prefix: string; resetPolicy: NumberingResetPolicy; enabled: boolean };

export interface NumberingSettingsTransaction extends AuthTransaction {
  listSeries(cursor: string | undefined, limit: number): Promise<NumberingSeries[]>;
  getSeries(seriesId: string): Promise<NumberingSeriesRecord | null>;
  hasIssuances(seriesId: string): Promise<boolean>;
  insertSeries(series: NumberingSeriesRecord, actorId: string, now: Date): Promise<void>;
  updateSeries(seriesId: string, expectedVersion: number, changes: NumberingSeriesChanges, actorId: string, now: Date): Promise<boolean>;
}

export interface NumberingSettingsStore extends AuthStore {
  transaction<T>(work: (tx: NumberingSettingsTransaction) => Promise<T>): Promise<T>;
}
