import type { PageId, PagePath } from '../../../../shared/permissions/pages.ts';
import type { Language } from '../../i18n/locale.ts';
import { shellMessages } from './locale.ts';
import { ShellIcon } from './ShellIcon.tsx';

export type NavigationItem = { id: PageId; path: PagePath; label: string };
export function WorkspaceNavigation({ items, pathname, language, blocked, compact = false, onNavigate }: {
  items: readonly NavigationItem[]; pathname: string; language: Language; blocked: boolean; compact?: boolean; onNavigate: (path: PagePath) => void;
}) {
  return <nav aria-label={shellMessages[language].navigation} className={`shell-navigation${compact ? ' shell-navigation-compact' : ''}`}>
    {items.map(item => <a key={item.id} href={blocked ? undefined : item.path} role={blocked ? 'link' : undefined} className="shell-nav-link" aria-label={item.label} title={compact ? item.label : undefined} aria-current={pathname === item.path ? 'page' : undefined} aria-disabled={blocked || undefined} tabIndex={blocked ? -1 : undefined} onClick={event => {
      if (blocked) { event.preventDefault(); return; }
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); onNavigate(item.path);
    }}><span className="shell-nav-emblem"><ShellIcon name={item.id} /></span><span className="shell-nav-label">{item.label}</span></a>)}
  </nav>;
}
