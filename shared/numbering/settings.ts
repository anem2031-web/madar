export const numberingFormat = '{PREFIX}-{YYYY}-{SEQ}';
export const numberingPaddingWidth = 4;
export const numberingTimeZone = 'Asia/Riyadh';

export type NumberingResetPolicy = 'annual' | 'continuous';
export type NumberingSeries = {
  id: string;
  code: string;
  prefix: string;
  format: string;
  paddingWidth: number;
  resetPolicy: NumberingResetPolicy;
  enabled: boolean;
  version: number;
  hasIssued: boolean;
};
export type CreateNumberingSeries = {
  code: string;
  prefix: string;
  resetPolicy: NumberingResetPolicy;
  enabled: boolean;
};
export type UpdateNumberingSeries = Omit<CreateNumberingSeries, 'code'> & {
  seriesId: string;
  expectedVersion: number;
};
