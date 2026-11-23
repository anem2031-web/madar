import ar from '../../../shared/i18n/ar/foundation.ts';
import en from '../../../shared/i18n/en/foundation.ts';

export type Language = 'ar' | 'en';
export const messages: Record<Language, Record<keyof typeof ar, string>> = { ar, en };

const languageKey = 'madar.language';

export function readLanguage(): Language {
  try {
    return localStorage.getItem(languageKey) === 'en' ? 'en' : 'ar';
  } catch {
    return 'ar';
  }
}

export function applyLanguage(language: Language) {
  document.documentElement.lang = language;
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  document.title = messages[language].appName;
  try {
    localStorage.setItem(languageKey, language);
  } catch {
    // The selected language still applies while the page is open.
  }
}
