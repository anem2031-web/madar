import type { ReactNode } from 'react';
import { messages } from '../../i18n/locale.ts';
import type { Language } from '../../i18n/locale.ts';
import { Brand } from './Brand.tsx';
import { shellMessages } from './locale.ts';

export function PublicLayout({ language, onLanguageChange, children }: { language: Language; onLanguageChange: () => void; children: ReactNode }) {
  const labels = messages[language];
  const nextLanguage = language === 'ar' ? 'en' : 'ar';
  return <div className="public-shell" dir={language === 'ar' ? 'rtl' : 'ltr'}>
    <header className="public-header"><Brand language={language} /><button type="button" lang={nextLanguage} className="control" title={shellMessages[language].language} onClick={onLanguageChange}>{nextLanguage === 'en' ? 'English' : 'العربية'}</button></header>
    <main className="auth-layout">
      <aside className="auth-intro" aria-labelledby="intro-heading"><span className="intro-eyebrow">{labels.workspace}</span><h1 id="intro-heading" className="intro-heading">{labels.introHeading}</h1><p className="intro-description">{labels.introDescription}</p><div className="orbit-art" aria-hidden="true"><span /><i /><b /></div><p className="intro-note"><span aria-hidden="true">◈</span> {labels.accessNote}</p></aside>
      <section className="auth-card" aria-label={labels.workspace}>{children}</section>
    </main>
    <footer className="public-footer">{labels.appName}<span aria-hidden="true"> · </span>{labels.accessNote}</footer>
  </div>;
}
