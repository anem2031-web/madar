import { isPermissionCode } from './catalog.ts';
import type { PermissionCode } from './catalog.ts';

export type PageDefinition = {
  readonly id: string;
  readonly path: string;
  readonly kind: 'workspace' | 'protected';
  readonly layout: 'auth' | 'workspace';
  readonly enabled: boolean;
  readonly permissionMode: 'all';
  readonly requiredPermissions: readonly PermissionCode[];
  readonly landingPriority: number | null;
};

// Register implemented pages only. Registration never grants a permission to a user.
export const registeredPages = [
  { id: 'workspace', path: '/', kind: 'workspace', layout: 'auth', enabled: true,
    permissionMode: 'all', requiredPermissions: [], landingPriority: null },
  { id: 'organization', path: '/organization', kind: 'protected', layout: 'workspace', enabled: true,
    permissionMode: 'all', requiredPermissions: ['organization.read'], landingPriority: 10 },
  { id: 'users', path: '/users', kind: 'protected', layout: 'workspace', enabled: true,
    permissionMode: 'all', requiredPermissions: ['users.manage'], landingPriority: 20 },
  { id: 'permissions', path: '/permissions', kind: 'protected', layout: 'workspace', enabled: true,
    permissionMode: 'all', requiredPermissions: ['permissions.manage_overrides'], landingPriority: 30 },
  { id: 'numbering', path: '/settings/numbering', kind: 'protected', layout: 'workspace', enabled: true,
    permissionMode: 'all', requiredPermissions: ['settings.manage'], landingPriority: 40 },
] as const satisfies readonly PageDefinition[];

export type RegisteredPage = typeof registeredPages[number];
export type WorkspacePage = Extract<RegisteredPage, { kind: 'workspace' }>;
export type ProtectedPage = Extract<RegisteredPage, { kind: 'protected' }>;
export type PageId = RegisteredPage['id'];
export type PagePath = RegisteredPage['path'];
export type ProtectedPageId = ProtectedPage['id'];

const definitionKeys = ['id', 'path', 'kind', 'layout', 'enabled', 'permissionMode', 'requiredPermissions', 'landingPriority'];

/** Validate authored configuration; never accept a page definition from a request. */
export function assertPageRegistry(input: unknown = registeredPages): asserts input is readonly PageDefinition[] {
  if (!Array.isArray(input) || !input.length) throw new Error('Invalid page registry.');
  const ids = new Set<string>();
  const paths = new Set<string>();
  const priorities = new Set<number>();
  let workspaces = 0;
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid page definition.');
    const page = entry as Record<string, unknown>;
    if (Object.keys(page).length !== definitionKeys.length || definitionKeys.some(key => !Object.hasOwn(page, key))) {
      throw new Error('Incomplete page definition.');
    }
    if (typeof page.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(page.id)
      || typeof page.path !== 'string' || !(page.path === '/' || /^\/[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*$/.test(page.path))
      || ids.has(page.id) || paths.has(page.path) || typeof page.enabled !== 'boolean'
      || page.permissionMode !== 'all' || !Array.isArray(page.requiredPermissions)
      || page.requiredPermissions.some(permission => typeof permission !== 'string' || !isPermissionCode(permission))
      || new Set(page.requiredPermissions).size !== page.requiredPermissions.length) {
      throw new Error('Invalid or conflicting page policy.');
    }
    ids.add(page.id); paths.add(page.path);
    if (page.kind === 'workspace') {
      if (page.id !== 'workspace' || page.path !== '/' || page.layout !== 'auth' || !page.enabled
        || page.requiredPermissions.length !== 0 || page.landingPriority !== null) throw new Error('Invalid workspace policy.');
      workspaces++;
    } else if (page.kind === 'protected') {
      if (page.path === '/' || page.layout !== 'workspace' || !page.requiredPermissions.length) throw new Error('Invalid protected page policy.');
      if (page.landingPriority !== null) {
        if (typeof page.landingPriority !== 'number' || !Number.isSafeInteger(page.landingPriority)
          || page.landingPriority < 1 || priorities.has(page.landingPriority)) throw new Error('Ambiguous page landing order.');
        priorities.add(page.landingPriority);
      }
    } else throw new Error('Unknown page policy.');
  }
  if (workspaces !== 1) throw new Error('A single workspace entry is required.');
}

assertPageRegistry();

// Shared by the public SPA shell, not an authorization grant or an API allow-list.
export const registeredPagePaths: readonly PagePath[] = registeredPages.filter(page => page.enabled).map(page => page.path);

export function getPage(pathname: string): RegisteredPage | undefined {
  return registeredPages.find(page => page.path === pathname);
}

export function getAllowedLandingPages(permissions: readonly string[]): ProtectedPage[] {
  const granted = new Set(permissions);
  return registeredPages.filter((page): page is ProtectedPage => page.kind === 'protected'
    && page.enabled && page.landingPriority !== null
    && page.requiredPermissions.every(permission => granted.has(permission)))
    .sort((left, right) => left.landingPriority - right.landingPriority);
}

export type PageGuardSession = {
  state: 'checking' | 'unavailable' | 'anonymous' | 'password_change' | 'authenticated';
  permissions?: readonly string[];
};

export type PageAccessDecision =
  | { kind: 'checking' | 'unavailable' | 'login' | 'password-change' | 'no-access' | 'not-found' }
  | { kind: 'workspace'; page: WorkspacePage }
  | { kind: 'render'; page: ProtectedPage }
  | { kind: 'redirect'; target: PagePath };

/** Decide once from one trusted snapshot. Side effects and session reads belong to the caller. */
export function resolvePageAccess({ pathname, session }: { pathname: string; session: PageGuardSession }): PageAccessDecision {
  const page = getPage(pathname);
  if (!page || !page.enabled) return { kind: 'not-found' };
  if (session.state === 'checking') return { kind: 'checking' };
  if (session.state === 'unavailable') return { kind: 'unavailable' };
  if (session.state === 'anonymous') return { kind: 'login' };
  if (session.state === 'password_change') return { kind: 'password-change' };
  if (session.state !== 'authenticated') return { kind: 'unavailable' };
  const permissions = session.permissions ?? [];
  const granted = new Set(permissions);
  if (page.kind === 'protected' && page.requiredPermissions.every(permission => granted.has(permission))) {
    return { kind: 'render', page };
  }
  const first = getAllowedLandingPages(permissions)[0];
  if (page.kind === 'workspace') return first ? { kind: 'workspace', page } : { kind: 'no-access' };
  // This branch cannot select itself: the current protected page was denied above.
  return first && first.path !== pathname ? { kind: 'redirect', target: first.path } : { kind: 'no-access' };
}
