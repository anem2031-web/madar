import { DirectionProvider } from '@radix-ui/react-direction';
import { useEffect, useState } from 'react';
import { applyLanguage, messages, readLanguage } from '../i18n/locale.ts';
import { AuthScreen } from '../modules/auth/AuthScreen.tsx';

export function App() {
  const [language, setLanguage] = useState(readLanguage);
  const labels = messages[language];
  const nextLanguage = language === 'ar' ? 'en' : 'ar';

  useEffect(() => applyLanguage(language), [language]);

  return (
    <DirectionProvider dir={language === 'ar' ? 'rtl' : 'ltr'}>
      <div className="app-shell">
        <header className="app-header">
          <div className="flex items-center gap-3">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="5" fill="currentColor" /><ellipse cx="20" cy="20" rx="17" ry="10" transform="rotate(-40 20 20)" stroke="currentColor" strokeWidth="2" /><circle cx="31" cy="9" r="3" fill="currentColor" /></svg>
            </span>
            <div><h1 className="text-2xl font-bold tracking-tight text-brand">{labels.appName}</h1><p className="text-xs text-muted sm:text-sm">{labels.appDescription}</p></div>
          </div>
          <button type="button" lang={nextLanguage} className="control" onClick={() => setLanguage(nextLanguage)}>
            {nextLanguage === 'en' ? 'English' : 'العربية'}
          </button>
        </header>
        <main className="auth-layout">
          <aside className="auth-intro" aria-labelledby="intro-heading">
            <span className="intro-eyebrow">{labels.workspace}</span>
            <h2 id="intro-heading" className="intro-heading">{labels.introHeading}</h2>
            <p className="intro-description">{labels.introDescription}</p>
            <div className="orbit-art" aria-hidden="true"><span /><i /><b /></div>
            <p className="intro-note"><span aria-hidden="true">◈</span> {labels.accessNote}</p>
          </aside>
          <section className="auth-card" aria-label={labels.workspace}><AuthScreen language={language} /></section>
        </main>
        <footer className="app-footer">{labels.appName}<span aria-hidden="true"> · </span>{labels.accessNote}</footer>
      </div>
    </DirectionProvider>
  );
}
