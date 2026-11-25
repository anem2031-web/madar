import type { ReactNode } from 'react';
import type { PageId } from '../../../../shared/permissions/pages.ts';

type IconName = PageId | 'menu' | 'close' | 'collapse' | 'expand' | 'logout';
const paths = {
  workspace: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /></>,
  organization: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h1m4 0h1M9 11h1m4 0h1M9 15h1m4 0h1m-5 6v-3h4v3" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-2a6 6 0 0 1 12 0v2m1-16a3 3 0 0 1 0 6m3 10v-2a6 6 0 0 0-2-4.5" /></>,
  permissions: <><path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
  numbering: <><path d="M9 3 7 21M17 3l-2 18M4 9h17M3 15h17" /></>,
  audit: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6m-6 4h6m-6 4h3" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  collapse: <path d="m15 6-6 6 6 6" />,
  expand: <path d="m9 6 6 6-6 6" />,
  logout: <><path d="M10 4H5v16h5m4-12 4 4-4 4m-5-4h12" /></>,
} satisfies Record<IconName, ReactNode>;

export function ShellIcon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shell-icon${name === 'collapse' || name === 'expand' ? ' shell-directional-icon' : ''}`}>{paths[name]}</svg>;
}
