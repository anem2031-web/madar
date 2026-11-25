import { messages } from '../../i18n/locale.ts';
import type { Language } from '../../i18n/locale.ts';

export function Brand({ language, compact = false }: { language: Language; compact?: boolean }) {
  const labels = messages[language];
  return <div className={`shell-brand${compact ? ' shell-brand-compact' : ''}`} aria-label={labels.appName}>
    <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="5" fill="currentColor" /><ellipse cx="20" cy="20" rx="17" ry="10" transform="rotate(-40 20 20)" stroke="currentColor" strokeWidth="2" /><circle cx="31" cy="9" r="3" fill="currentColor" /></svg></span>
    <div className="shell-brand-copy"><p className="shell-brand-name">{labels.appName}</p><p className="shell-brand-description">{labels.appDescription}</p></div>
  </div>;
}
