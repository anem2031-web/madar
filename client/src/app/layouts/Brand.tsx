import { messages } from '../../i18n/locale.ts';
import type { Language } from '../../i18n/locale.ts';
import { shellMessages } from './locale.ts';

export function Brand({ language, blocked = false, onHome }: { language: Language; blocked?: boolean; onHome?: () => void }) {
  const labels = messages[language];
  const content = <>
    <span className="brand-mark" aria-hidden="true"><i /></span>
    <div className="shell-brand-copy"><p className="shell-brand-name">{labels.appName}</p><p className="shell-brand-description">{labels.appDescription}</p></div>
  </>;
  if (!onHome) return <div className="shell-brand" aria-label={labels.appName}>{content}</div>;
  return <a className="shell-brand" href={blocked ? undefined : '/'} role={blocked ? 'link' : undefined} aria-label={`${labels.appName}، ${shellMessages[language].workspace}`} aria-disabled={blocked || undefined} tabIndex={blocked ? -1 : undefined} onClick={event => {
    if (blocked) { event.preventDefault(); return; }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); onHome();
  }}>{content}</a>;
}
