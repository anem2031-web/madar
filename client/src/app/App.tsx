import { DirectionProvider } from '@radix-ui/react-direction';
import { useEffect, useState } from 'react';
import { applyLanguage, readLanguage } from '../i18n/locale.ts';
import { AuthScreen } from '../modules/auth/AuthScreen.tsx';

export function App() {
  const [language, setLanguage] = useState(readLanguage);
  const nextLanguage = language === 'ar' ? 'en' : 'ar';

  useEffect(() => applyLanguage(language), [language]);

  return (
    <DirectionProvider dir={language === 'ar' ? 'rtl' : 'ltr'}>
      <AuthScreen language={language} onLanguageChange={() => setLanguage(nextLanguage)} />
    </DirectionProvider>
  );
}
