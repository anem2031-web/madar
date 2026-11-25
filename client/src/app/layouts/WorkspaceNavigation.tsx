import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { PageId, PagePath } from '../../../../shared/permissions/pages.ts';
import type { Language } from '../../i18n/locale.ts';
import { shellMessages } from './locale.ts';
import { ShellIcon } from './ShellIcon.tsx';

export type NavigationItem = { id: PageId; path: PagePath; label: string };

export function WorkspaceNavigation({ items, pathname, language, blocked, instanceId, drawer = false, active = true, onSectionChange, onNavigate }: {
  items: readonly NavigationItem[]; pathname: string; language: Language; blocked: boolean;
  instanceId: string; drawer?: boolean; active?: boolean; onSectionChange?: (open: boolean) => void; onNavigate: (path: PagePath) => void;
}) {
  const shell = shellMessages[language];
  const [sectionOpen, setSectionOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const returnFocus = useRef(false);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const workspace = items.find(item => item.id === 'workspace');
  const organization = items.find(item => item.id === 'organization');
  const administrative = items.filter(item => item.id !== 'workspace' && item.id !== 'organization');
  const sectionVisible = sectionOpen && active && !blocked && administrative.length > 0;
  const menuId = `${instanceId}-administration`;
  const titleId = `${menuId}-title`;
  const closeSection = (restoreFocus: boolean) => {
    setSectionOpen(false);
    returnFocus.current = restoreFocus;
  };

  useEffect(() => { setSectionOpen(false); }, [pathname, blocked, active]);
  useEffect(() => { onSectionChange?.(sectionVisible); }, [sectionVisible, onSectionChange]);
  useEffect(() => {
    if (!sectionVisible) {
      if (returnFocus.current && active && !blockedRef.current && triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
      returnFocus.current = false;
      return;
    }
    const activeLink = sectionRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    (activeLink ?? sectionRef.current?.querySelector<HTMLElement>('a[href]'))?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setSectionOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [sectionVisible, active]);

  const follow = (event: MouseEvent<HTMLAnchorElement>, item: NavigationItem) => {
    if (blocked) { event.preventDefault(); return; }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); setSectionOpen(false); onNavigate(item.path);
  };
  const link = (item: NavigationItem, section = false) => <a key={item.id} href={blocked ? undefined : item.path} role={blocked ? 'link' : undefined} className={section ? 'shell-section-link' : 'shell-nav-link'} aria-label={item.label} aria-current={pathname === item.path ? 'page' : undefined} aria-disabled={blocked || undefined} tabIndex={blocked ? -1 : undefined} onClick={event => follow(event, item)}>
    {section ? <><span>{item.label}</span><ShellIcon name="next" /></> : <><span className="shell-nav-emblem"><ShellIcon name={item.id} /></span><span className="shell-nav-label">{item.label}</span></>}
  </a>;

  return <div ref={rootRef} className="shell-navigation" data-section-open={sectionVisible || undefined} onKeyDown={event => {
    if (event.key === 'Escape' && sectionVisible) { event.preventDefault(); event.stopPropagation(); closeSection(true); }
  }}>
    <nav aria-label={shell.navigation} className="shell-nav-main" hidden={drawer && sectionVisible} inert={drawer && sectionVisible}>
      {workspace && <section className="shell-nav-group"><h2 className="shell-nav-heading">{shell.overview}</h2>{link(workspace)}</section>}
      {organization && <section className="shell-nav-group"><h2 className="shell-nav-heading">{shell.organizationGroup}</h2>{link(organization)}</section>}
      {administrative.length > 0 && <section className="shell-nav-group"><h2 className="shell-nav-heading">{shell.administrationGroup}</h2><button ref={triggerRef} type="button" className="shell-nav-link" aria-label={shell.systemAdministration} aria-controls={menuId} aria-expanded={sectionVisible} aria-current={administrative.some(item => item.path === pathname) ? 'true' : undefined} disabled={blocked} onClick={() => { if (!blocked) setSectionOpen(open => !open); }}><span className="shell-nav-emblem"><ShellIcon name="administration" /></span><span className="shell-nav-label">{shell.systemAdministration}</span><span className="shell-nav-chevron"><ShellIcon name="next" /></span></button></section>}
    </nav>
    {administrative.length > 0 && <section ref={sectionRef} id={menuId} className="shell-section-menu" aria-labelledby={titleId} hidden={!sectionVisible}>
      <header className="shell-section-head"><h2 id={titleId}>{shell.systemAdministration}</h2><button type="button" className="shell-icon-button" aria-label={shell.closeSection} onClick={() => closeSection(true)}><ShellIcon name="close" /></button></header>
      <nav className="shell-section-links" aria-label={shell.systemAdministration}>{administrative.map(item => link(item, true))}</nav>
    </section>}
  </div>;
}
