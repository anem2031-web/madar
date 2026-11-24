import ar from '../../../../shared/i18n/ar/organization.ts';
import en from '../../../../shared/i18n/en/organization.ts';
import type { Language } from '../../i18n/locale.ts';

export type OrganizationLabels = Record<keyof typeof ar, string>;
export const organizationMessages: Record<Language, OrganizationLabels> = { ar, en };
