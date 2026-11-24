import { expect, test } from 'vitest';
import { initialRolePermissions, permissionCodes } from '../../../shared/permissions/catalog.ts';
import { assertPageRegistry, getAllowedLandingPages, getPage, registeredPages, resolvePageAccess } from '../../../shared/permissions/pages.ts';

const destinations = [
  { path: '/organization', permission: 'organization.read' },
  { path: '/users', permission: 'users.manage' },
  { path: '/permissions', permission: 'permissions.manage_overrides' },
  { path: '/settings/numbering', permission: 'settings.manage' },
] as const;

test('the registry defines only implemented destinations with explicit policy and deterministic priority', () => {
  expect(() => assertPageRegistry()).not.toThrow();
  expect(registeredPages.map(page => page.path).sort()).toEqual(['/', '/organization', '/permissions', '/settings/numbering', '/users']);
  expect(getPage('/')).toMatchObject({ id: 'workspace', kind: 'workspace', requiredPermissions: [], landingPriority: null });
  expect(destinations.map(destination => getPage(destination.path)!.landingPriority)).toEqual([10, 20, 30, 40]);
  for (const destination of destinations) {
    const page = getPage(destination.path)!;
    expect(page).toMatchObject({ kind: 'protected', enabled: true, permissionMode: 'all', requiredPermissions: [destination.permission] });
    expect(page.requiredPermissions.every(permission => (permissionCodes as readonly string[]).includes(permission))).toBe(true);
  }
});

test('all permission combinations have stable one-hop redirects while allowed current pages remain in place', () => {
  const rolesBefore = JSON.stringify(initialRolePermissions);
  for (let mask = 0; mask < 2 ** destinations.length; mask++) {
    const permissions = Object.freeze(destinations.filter((_destination, index) => !!(mask & (1 << index))).map(destination => destination.permission));
    const permitted = destinations.filter(destination => permissions.includes(destination.permission));
    expect(getAllowedLandingPages(permissions).map(page => page.path)).toEqual(permitted.map(destination => destination.path));
    const session = Object.freeze({ state: 'authenticated' as const, permissions });
    const root = resolvePageAccess({ pathname: '/', session });
    expect(root.kind).toBe(permitted.length ? 'workspace' : 'no-access');
    for (const destination of destinations) {
      const input = Object.freeze({ pathname: destination.path, session });
      const decision = resolvePageAccess(input);
      expect(resolvePageAccess(input)).toEqual(decision);
      if (permissions.includes(destination.permission)) {
        expect(decision).toMatchObject({ kind: 'render', page: { path: destination.path } });
      } else if (!permitted.length) {
        expect(decision.kind).toBe('no-access');
      } else {
        expect(decision.kind).toBe('redirect');
        if (decision.kind !== 'redirect') throw new Error('Expected a redirect.');
        expect(decision.target).toBe(permitted[0].path);
        expect(decision.target).not.toBe(destination.path);
        expect(getPage(decision.target)).toMatchObject({ kind: 'protected', enabled: true });
        const targetDecision = resolvePageAccess({ pathname: decision.target, session });
        expect(targetDecision).toMatchObject({ kind: 'render', page: { path: decision.target } });
      }
    }
  }
  expect(JSON.stringify(initialRolePermissions)).toBe(rolesBefore);
});

test('untrusted, unavailable and restricted session stages never reveal a functional page', () => {
  const states = [
    ['checking', 'checking'], ['unavailable', 'unavailable'], ['anonymous', 'login'], ['password_change', 'password-change'],
  ] as const;
  for (const [state, expected] of states) {
    for (const pathname of ['/', ...destinations.map(destination => destination.path)]) {
      const result = resolvePageAccess({ pathname, session: { state, permissions: [...permissionCodes] } });
      expect(result.kind).toBe(expected);
      expect(result).not.toHaveProperty('target');
      expect(result).not.toHaveProperty('page');
    }
  }
});

test('unknown paths and untrusted return targets remain terminal rather than becoming redirects', () => {
  const unknown = ['/unknown', '/users/', '/%75sers', '//foreign.invalid/users', 'https://foreign.invalid/users', '/users?next=/organization', '/users#fragment', '/organization/../users', ''];
  for (const pathname of unknown) {
    expect(getPage(pathname)).toBeUndefined();
    for (const state of ['checking', 'unavailable', 'anonymous', 'password_change', 'authenticated'] as const) {
      expect(resolvePageAccess({ pathname, session: { state, permissions: [...permissionCodes] } })).toEqual({ kind: 'not-found' });
    }
  }
});

test('unknown, write-only and unrelated permissions do not grant pages or force movement from an allowed page', () => {
  const unrelated = ['unknown.permission', 'employees.update', 'employees.create', 'roles.manage', 'audit.read'];
  expect(getAllowedLandingPages(unrelated)).toEqual([]);
  expect(resolvePageAccess({ pathname: '/users', session: { state: 'authenticated', permissions: unrelated } }).kind).toBe('no-access');
  const current = resolvePageAccess({ pathname: '/permissions', session: { state: 'authenticated', permissions: [...permissionCodes] } });
  expect(current).toMatchObject({ kind: 'render', page: { path: '/permissions' } });
});

test('registry validation rejects ambiguous, unknown or unsafe page policies', () => {
  const baseline = JSON.parse(JSON.stringify(registeredPages)) as Record<string, unknown>[];
  const mutate = (edit: (pages: Record<string, unknown>[]) => void) => {
    const pages = structuredClone(baseline); edit(pages); return pages;
  };
  const protectedIndex = baseline.findIndex(page => page.path === '/users');
  const rootIndex = baseline.findIndex(page => page.path === '/');
  const anotherProtectedIndex = baseline.findIndex(page => page.path === '/organization');
  const invalid = [
    [],
    mutate(pages => { pages[protectedIndex].path = 'https://foreign.invalid/users'; }),
    mutate(pages => { pages[protectedIndex].id = pages[anotherProtectedIndex].id; }),
    mutate(pages => { pages[protectedIndex].path = pages[anotherProtectedIndex].path; }),
    mutate(pages => { pages[protectedIndex].landingPriority = pages[anotherProtectedIndex].landingPriority; }),
    mutate(pages => { pages[protectedIndex].requiredPermissions = []; }),
    mutate(pages => { pages[protectedIndex].requiredPermissions = ['unknown.permission']; }),
    mutate(pages => { pages[protectedIndex].permissionMode = 'any'; }),
    mutate(pages => { pages[protectedIndex].landingPriority = 0; }),
    mutate(pages => { pages[protectedIndex].requiredPermissions = ['users.manage', 'users.manage']; }),
    mutate(pages => { pages[protectedIndex].enabled = 'true'; }),
    mutate(pages => { pages[rootIndex].requiredPermissions = ['users.manage']; }),
    mutate(pages => { pages[rootIndex].landingPriority = 1; }),
  ];
  for (const registry of invalid) expect(() => assertPageRegistry(registry)).toThrow();
  expect(() => assertPageRegistry(baseline)).not.toThrow();
  expect(() => assertPageRegistry(mutate(pages => { pages[protectedIndex].landingPriority = null; }))).not.toThrow();
  expect(() => assertPageRegistry(mutate(pages => { pages[protectedIndex].enabled = false; }))).not.toThrow();
  expect(registeredPages).toEqual(baseline);
});
