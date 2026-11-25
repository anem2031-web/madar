import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getAllowedLandingPages } from '../../../../shared/permissions/pages.ts';
import type { PagePath, ProtectedPageId } from '../../../../shared/permissions/pages.ts';
import { messages } from '../../i18n/locale.ts';
import type { Language } from '../../i18n/locale.ts';
import { Brand } from './Brand.tsx';
import { shellMessages } from './locale.ts';
import { ShellIcon } from './ShellIcon.tsx';
import { WorkspaceNavigation } from './WorkspaceNavigation.tsx';
import type { NavigationItem } from './WorkspaceNavigation.tsx';

export type WorkspaceLayoutProps = {
  language: Language; onLanguageChange: () => void; pathname: string; username: string; roleName: string;
  permissions: readonly string[]; pageLabels: Record<ProtectedPageId, string>; blocked: boolean;
  onNavigate: (path: PagePath) => void; onLogout: () => void; children: ReactNode;
};

export function WorkspaceLayout({ language, onLanguageChange, pathname, username, roleName, permissions, pageLabels, blocked, onNavigate, onLogout, children }: WorkspaceLayoutProps) {
  const labels = messages[language];
  const shell = shellMessages[language];
  const nextLanguage = language === 'ar' ? 'en' : 'ar';
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const drawerCloseFocus = useRef<'trigger' | 'content' | 'none'>('none');
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const items: NavigationItem[] = [{ id: 'workspace', path: '/', label: shell.workspace },
    ...getAllowedLandingPages(permissions).map(page => ({ id: page.id, path: page.path, label: pageLabels[page.id] }))];
  const currentTitle = items.find(item => item.path === pathname)?.label ?? shell.workspace;
  const closeDrawer = useCallback((focus: 'trigger' | 'content' | 'none') => { drawerCloseFocus.current = focus; setDrawerOpen(false); }, []);
  const choosePage = (path: PagePath) => { if (!blocked) { closeDrawer('content'); onNavigate(path); } };

  useEffect(() => { closeDrawer(blocked ? 'none' : 'content'); }, [pathname, blocked, closeDrawer]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const resize = () => { if (desktop.matches) closeDrawer('none'); };
    desktop.addEventListener('change', resize);
    return () => desktop.removeEventListener('change', resize);
  }, [closeDrawer]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!drawerOpen || !dialog) return;
    if (blocked || window.matchMedia('(min-width: 1024px)').matches) { closeDrawer('none'); return; }
    const previousOverflow = document.body.style.overflow;
    dialog.showModal(); document.body.style.overflow = 'hidden'; closeRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      const focus = blockedRef.current ? 'none' : drawerCloseFocus.current;
      const target = focus === 'content' ? mainRef.current : focus === 'trigger' ? menuRef.current : null;
      if (target?.isConnected && !window.matchMedia('(min-width: 1024px)').matches) target.focus();
      drawerCloseFocus.current = 'none';
    };
  }, [drawerOpen, blocked, closeDrawer]);

  return <div className="workspace-shell" dir={language === 'ar' ? 'rtl' : 'ltr'} data-collapsed={collapsed || undefined}>
    <a href="#workspace-main" className="shell-skip-link">{shell.skipContent}</a>
    <aside className="workspace-sidebar" aria-label={shell.navigation}>
      <Brand language={language} compact={collapsed} />
      <WorkspaceNavigation items={items} pathname={pathname} language={language} blocked={blocked} compact={collapsed} onNavigate={choosePage} />
      <button type="button" className="shell-icon-button shell-sidebar-toggle" aria-label={collapsed ? shell.expandSidebar : shell.collapseSidebar} title={collapsed ? shell.expandSidebar : shell.collapseSidebar} aria-expanded={!collapsed} disabled={blocked} onClick={() => setCollapsed(value => !value)}><ShellIcon name={collapsed ? 'expand' : 'collapse'} /><span className="shell-sidebar-toggle-label">{collapsed ? shell.expandSidebar : shell.collapseSidebar}</span></button>
    </aside>
    <div className="workspace-body">
      <header className="workspace-header">
        <div className="shell-header-context"><button ref={menuRef} type="button" className="shell-icon-button shell-menu-trigger" aria-label={shell.openMenu} aria-controls="workspace-navigation-dialog" aria-expanded={drawerOpen} disabled={blocked} onClick={() => { drawerCloseFocus.current = 'none'; setDrawerOpen(true); }}><ShellIcon name="menu" /></button><div className="shell-context-copy"><p className="shell-context-caption">{labels.appName}<span aria-hidden="true"> · </span>{labels.appDescription}</p><h1 className="shell-context-title">{currentTitle}</h1></div></div>
        <div className="shell-header-actions"><div className="shell-identity"><p className="shell-username"><bdi dir="auto">{username}</bdi></p><p className="shell-role">{roleName}</p></div><button type="button" className="control shell-language-control" lang={nextLanguage} title={shell.language} onClick={onLanguageChange}>{nextLanguage === 'en' ? 'English' : 'العربية'}</button><button type="button" className="control shell-logout-control" onClick={onLogout} disabled={blocked}><ShellIcon name="logout" /><span>{labels.logout}</span></button></div>
      </header>
      <main id="workspace-main" ref={mainRef} tabIndex={-1} className="workspace-content"><div className="workspace-page">{children}</div></main>
      <footer className="workspace-footer">{labels.appName}<span aria-hidden="true"> · </span>{labels.accessNote}</footer>
    </div>
    <dialog id="workspace-navigation-dialog" ref={dialogRef} className="shell-drawer" aria-labelledby="workspace-menu-title" onCancel={event => { event.preventDefault(); closeDrawer('trigger'); }} onClose={() => setDrawerOpen(false)} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDrawer('trigger');
    }}>
      <div className="shell-drawer-heading"><h2 id="workspace-menu-title">{shell.navigation}</h2><button ref={closeRef} type="button" className="shell-icon-button" aria-label={shell.closeMenu} onClick={() => closeDrawer('trigger')}><ShellIcon name="close" /></button></div>
      <Brand language={language} />
      <WorkspaceNavigation items={items} pathname={pathname} language={language} blocked={blocked} onNavigate={choosePage} />
    </dialog>
  </div>;
}
