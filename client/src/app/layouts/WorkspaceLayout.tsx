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

const touchLayoutQuery = '(any-hover: none)';

export function WorkspaceLayout({ language, onLanguageChange, pathname, username, roleName, permissions, pageLabels, blocked, onNavigate, onLogout, children }: WorkspaceLayoutProps) {
  const labels = messages[language];
  const shell = shellMessages[language];
  const nextLanguage = language === 'ar' ? 'en' : 'ar';
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [desktopSectionOpen, setDesktopSectionOpen] = useState(false);
  const [drawerSectionOpen, setDrawerSectionOpen] = useState(false);
  const [touchLayout, setTouchLayout] = useState(false);
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
  const choosePage = (path: PagePath) => {
    if (blocked) return;
    closeDrawer('content'); onNavigate(path);
    if (!window.matchMedia(touchLayoutQuery).matches) mainRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => { closeDrawer(blocked ? 'none' : 'content'); }, [pathname, blocked, closeDrawer]);
  useEffect(() => {
    const touch = window.matchMedia(touchLayoutQuery);
    setTouchLayout(touch.matches);
    const change = () => { setTouchLayout(touch.matches); setDesktopSectionOpen(false); closeDrawer('none'); };
    touch.addEventListener('change', change);
    return () => touch.removeEventListener('change', change);
  }, [closeDrawer]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!drawerOpen || !dialog) return;
    if (blocked || !window.matchMedia(touchLayoutQuery).matches) { closeDrawer('none'); return; }
    const previousOverflow = document.body.style.overflow;
    dialog.showModal(); document.body.style.overflow = 'hidden'; closeRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      const focus = blockedRef.current ? 'none' : drawerCloseFocus.current;
      const target = focus === 'content' ? mainRef.current : focus === 'trigger' ? menuRef.current : null;
      if (target?.isConnected && window.matchMedia(touchLayoutQuery).matches) target.focus({ preventScroll: true });
      drawerCloseFocus.current = 'none';
    };
  }, [drawerOpen, blocked, closeDrawer]);

  return <div className="workspace-shell" dir={language === 'ar' ? 'rtl' : 'ltr'} data-page={pathname === '/' ? 'workspace' : 'module'}>
    <a href="#workspace-main" className="shell-skip-link">{shell.skipContent}</a>
    <aside className="workspace-sidebar" aria-label={shell.navigation} data-section-open={desktopSectionOpen || undefined}>
      <Brand language={language} blocked={blocked} onHome={() => choosePage('/')} />
      <WorkspaceNavigation items={items} pathname={pathname} language={language} blocked={blocked} instanceId="workspace-desktop" active={!touchLayout} onSectionChange={setDesktopSectionOpen} onNavigate={choosePage} />
    </aside>
    <div className="workspace-body">
      <header className="workspace-header">
        <div className="shell-header-context"><button ref={menuRef} type="button" className="shell-icon-button shell-menu-trigger" aria-label={shell.openMenu} aria-controls="workspace-navigation-dialog" aria-expanded={drawerOpen} disabled={blocked} onClick={() => { drawerCloseFocus.current = 'none'; setDrawerOpen(true); }}><ShellIcon name="menu" /></button><span className="shell-context-icon" aria-hidden="true"><ShellIcon name="building" /></span><div className="shell-context-copy"><p className="shell-context-caption">{labels.appName}<span aria-hidden="true"> · </span>{labels.appDescription}</p><h1 className="shell-context-title">{currentTitle}</h1></div></div>
        <div className="shell-header-actions"><div className="shell-identity"><p className="shell-username"><bdi dir="auto">{username}</bdi></p><p className="shell-role">{roleName}</p></div><button type="button" className="control shell-language-control" lang={nextLanguage} title={shell.language} onClick={onLanguageChange}>{nextLanguage === 'en' ? 'English' : 'العربية'}</button><button type="button" className="control shell-logout-control" onClick={onLogout} disabled={blocked}><ShellIcon name="logout" /><span>{labels.logout}</span></button></div>
      </header>
      <main id="workspace-main" ref={mainRef} tabIndex={-1} className="workspace-content"><div className="workspace-page">{children}</div></main>
      <footer className="workspace-footer"><span>{labels.appName}</span><span>{labels.accessNote}</span></footer>
    </div>
    <dialog id="workspace-navigation-dialog" ref={dialogRef} className="shell-drawer" aria-labelledby="workspace-menu-title" onCancel={event => { event.preventDefault(); closeDrawer('trigger'); }} onClose={() => setDrawerOpen(false)} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDrawer('trigger');
    }}>
      <div className="shell-drawer-root" inert={drawerSectionOpen} aria-hidden={drawerSectionOpen || undefined}>
        <div className="shell-drawer-heading"><h2 id="workspace-menu-title">{shell.navigation}</h2><button ref={closeRef} type="button" className="shell-icon-button" aria-label={shell.closeMenu} onClick={() => closeDrawer('trigger')}><ShellIcon name="close" /></button></div>
        <Brand language={language} blocked={blocked} onHome={() => choosePage('/')} />
      </div>
      <WorkspaceNavigation items={items} pathname={pathname} language={language} blocked={blocked} instanceId="workspace-touch" active={drawerOpen} drawer onSectionChange={setDrawerSectionOpen} onNavigate={choosePage} />
    </dialog>
  </div>;
}
