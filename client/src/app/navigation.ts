import { useEffect, useState } from 'react';
import { getPage } from '../../../shared/permissions/pages.ts';
import type { PagePath } from '../../../shared/permissions/pages.ts';

export function navigate(path: PagePath) {
  if (window.location.pathname === path) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function replaceNavigation(path: PagePath) {
  if (!getPage(path)?.enabled || window.location.pathname === path) return;
  window.history.replaceState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePathname() {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return pathname;
}
