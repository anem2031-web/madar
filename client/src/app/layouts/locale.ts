import ar from '../../../../shared/i18n/ar/shell.ts';
import en from '../../../../shared/i18n/en/shell.ts';
import type { Language } from '../../i18n/locale.ts';

export const shellMessages: Record<Language, Record<keyof typeof ar, string>> = { ar, en };
