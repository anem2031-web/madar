import ar from '../../../../shared/i18n/ar/users.ts';
import en from '../../../../shared/i18n/en/users.ts';
import type { Language } from '../../i18n/locale.ts';

export type UserLabels = Record<keyof typeof ar, string>;
export const userMessages: Record<Language, UserLabels> = { ar, en };
