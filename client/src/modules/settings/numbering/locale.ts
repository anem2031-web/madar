import ar from '../../../../../shared/i18n/ar/numbering.ts';
import en from '../../../../../shared/i18n/en/numbering.ts';
import type { Language } from '../../../i18n/locale.ts';

export type NumberingLabels = Record<keyof typeof ar, string>;
export const numberingMessages: Record<Language, NumberingLabels> = { ar, en };
