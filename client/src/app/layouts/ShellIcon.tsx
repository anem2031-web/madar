import type { PageId } from '../../../../shared/permissions/pages.ts';

type IconName = PageId | 'administration' | 'building' | 'menu' | 'close' | 'next' | 'logout';

// Geometry used by the source page, rendered as SVG rather than canvas masks.
const sourcePaths = {
  home: 'M4 4h7v10H4zm9 0h7v6h-7zm0 8h7v8h-7zM4 16h7v4H4z',
  building: 'M4 21h16M6 21V4h12v17M9 8h1m4 0h1m-6 4h1m4 0h1m-3 9v-5',
  people: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20v-1a4.5 4.5 0 0 1 4.5-4.5h3A4.5 4.5 0 0 1 15 19v1m1-14a2.8 2.8 0 0 1 0 5.6m1.5 3.2A4 4 0 0 1 21 19v1',
  settings: 'M4 6h4m4 0h8M4 12h9m4 0h3M4 18h2m4 0h10M8 4h4v4H8zm5 6h4v4h-4zm-7 6h4v4H6z',
  file: 'M8 3h8l4 4v14H8zM16 3v5h4M4 17V6m7 6h6m-6 4h6',
  requests: 'M7 3h8l4 4v14H7zM15 3v5h4M4 17V6m6 8 2 2 4-4',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M18 6 6 18',
  next: 'm15 6-6 6 6 6',
} as const;

const paths = {
  workspace: sourcePaths.home,
  organization: sourcePaths.building,
  users: sourcePaths.people,
  permissions: sourcePaths.settings,
  numbering: sourcePaths.file,
  audit: sourcePaths.requests,
  administration: sourcePaths.settings,
  building: sourcePaths.building,
  menu: sourcePaths.menu,
  close: sourcePaths.close,
  next: sourcePaths.next,
  logout: 'M14 4h5v16h-5m-4-12-4 4 4 4m5-4H3',
} satisfies Record<IconName, string>;

export function ShellIcon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shell-icon${name === 'next' || name === 'logout' ? ' shell-directional-icon' : ''}`}><path d={paths[name]} /></svg>;
}
