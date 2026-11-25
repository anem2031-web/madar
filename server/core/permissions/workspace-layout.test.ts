import { createElement } from 'react';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { PublicLayout } from '../../../client/src/app/layouts/PublicLayout.tsx';
import { WorkspaceLayout } from '../../../client/src/app/layouts/WorkspaceLayout.tsx';
import { shellMessages } from '../../../client/src/app/layouts/locale.ts';
import { messages } from '../../../client/src/i18n/locale.ts';
import type { Language } from '../../../client/src/i18n/locale.ts';
import { organizationMessages } from '../../../client/src/modules/organization/locale.ts';
import { permissionMessages } from '../../../client/src/modules/permission-overrides/locale.ts';
import { userMessages } from '../../../client/src/modules/users/locale.ts';
import { numberingMessages } from '../../../client/src/modules/settings/numbering/locale.ts';
import { auditMessages } from '../../../client/src/modules/audit/locale.ts';
import { initialRolePermissions } from '../../../shared/permissions/catalog.ts';
import { getAllowedLandingPages, registeredPages } from '../../../shared/permissions/pages.ts';
import type { ProtectedPageId } from '../../../shared/permissions/pages.ts';

const noop = () => {};
function pageLabels(language: Language) {
  return {
    organization: organizationMessages[language].openOrganization,
    users: userMessages[language].openUsers,
    permissions: permissionMessages[language].openPermissions,
    numbering: numberingMessages[language].openNumbering,
    audit: auditMessages[language].openAudit,
  } satisfies Record<ProtectedPageId, string>;
}

function renderWorkspace(overrides: Partial<ComponentProps<typeof WorkspaceLayout>> = {}) {
  const language = overrides.language ?? 'ar';
  return renderToStaticMarkup(createElement(WorkspaceLayout, {
    language, onLanguageChange: noop, pathname: '/', username: 'LAYOUT-QA', roleName: messages[language].assignedRole,
    permissions: initialRolePermissions.hr, pageLabels: pageLabels(language), blocked: false,
    onNavigate: noop, onLogout: noop,
    children: createElement('p', { 'data-testid': 'single-page-child' }, 'Draft child sentinel'),
    ...overrides,
  }));
}

function menus(html: string) {
  return [...html.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/g)].map(match =>
    [...match[1].matchAll(/<a\b([^>]*)>/g)].map(link => ({
      path: /\bhref="([^"]+)"/.exec(link[1])?.[1],
      label: /\baria-label="([^"]+)"/.exec(link[1])?.[1],
      current: /\baria-current="page"/.test(link[1]),
      blocked: /\baria-disabled="true"/.test(link[1]),
      skippedByTab: /\btabindex="-1"/.test(link[1]),
      role: /\brole="([^"]+)"/.exec(link[1])?.[1],
    })),
  );
}

function expectLanguageControl(html: string, language: Language) {
  const destination = language === 'ar' ? 'en' : 'ar';
  const visibleName = destination === 'en' ? 'English' : 'العربية';
  const button = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .find(match => match[1].includes(`lang="${destination}"`));
  expect(button).toBeDefined();
  expect(button?.[2]).toBe(visibleName);
  expect(button?.[1]).toContain(`title="${shellMessages[language].language}"`);
  expect(button?.[1]).not.toContain('aria-label=');
}

test('desktop and drawer menus contain exactly the central registry destinations for every permission subset', () => {
  const pagePermissions = [...new Set(registeredPages.filter(page => page.kind === 'protected').flatMap(page => page.requiredPermissions))];
  const grantsBefore = JSON.stringify(initialRolePermissions);
  for (const language of ['ar', 'en'] as const) {
    for (let mask = 0; mask < 2 ** pagePermissions.length; mask++) {
      const permissions = Object.freeze(pagePermissions.filter((_permission, index) => !!(mask & (1 << index))));
      const allowed = getAllowedLandingPages(permissions);
      const html = renderWorkspace({ language, permissions });
      const navigation = menus(html);
      expect(navigation).toHaveLength(2);
      for (const links of navigation) {
        expect(links.map(link => link.path)).toEqual(['/', ...allowed.map(page => page.path)]);
        expect(links.map(link => link.label)).toEqual([shellMessages[language].workspace, ...allowed.map(page => pageLabels(language)[page.id])]);
      }
      expect(html).not.toMatch(/href="\/(employees|leave|leaves|approvals|payroll)(?:["/])/);
    }
  }
  expect(JSON.stringify(initialRolePermissions)).toBe(grantsBefore);
});

test('HR, a restricted administrator label and independently granted access use actual permissions only', () => {
  for (const [permissions, roleName, expected] of [
    [initialRolePermissions.hr, 'HR', ['/', '/organization']],
    [initialRolePermissions.system_admin, 'Administrator', ['/', '/organization', '/users', '/permissions', '/settings/numbering', '/audit']],
    [['audit.read'], messages.ar.adminRole, ['/', '/audit']],
    [['users.manage'], 'Unrecognized historical role', ['/', '/users']],
    [['employees.create', 'roles.manage', 'unknown.permission'], messages.ar.adminRole, ['/']],
  ] as const) {
    const html = renderWorkspace({ permissions, roleName });
    for (const links of menus(html)) expect(links.map(link => link.path)).toEqual(expected);
    expect(html).toContain(roleName);
  }
});

test('each menu identifies the exact active destination, including the workspace root', () => {
  for (const page of registeredPages) {
    for (const links of menus(renderWorkspace({ permissions: initialRolePermissions.system_admin, pathname: page.path }))) {
      expect(links.filter(link => link.current).map(link => link.path)).toEqual([page.path]);
    }
  }
});

test('background verification blocks route links and logout while preserving the mounted page slot', () => {
  const onNavigate = vi.fn(); const onLogout = vi.fn();
  const html = renderWorkspace({ blocked: true, onNavigate, onLogout });
  const navigation = menus(html);
  expect(navigation).toHaveLength(2);
  for (const links of navigation) {
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.blocked).toBe(true); expect(link.skippedByTab).toBe(true);
      expect(link.path).toBeUndefined(); expect(link.role).toBe('link');
    }
  }
  const logout = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(button => button[2].includes(messages.ar.logout));
  expect(logout?.[1]).toMatch(/\bdisabled=""/);
  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html.match(/data-testid="single-page-child"/g)).toHaveLength(1);
  expect(html).toMatch(/<main\b[^>]*id="workspace-main"[^>]*>[\s\S]*Draft child sentinel[\s\S]*<\/main>/);
  expect(onNavigate).not.toHaveBeenCalled(); expect(onLogout).not.toHaveBeenCalled();
});

test('both shell languages provide accessible controls and safe identity isolation without duplicate page content', () => {
  expect(Object.keys(shellMessages.ar).sort()).toEqual(Object.keys(shellMessages.en).sort());
  for (const language of ['ar', 'en'] as const) {
    const labels = shellMessages[language];
    for (const label of Object.values(labels)) expect(label.trim().length).toBeGreaterThan(0);
    const html = renderWorkspace({ language, username: '<script>unsafe account</script>', pathname: '/organization' });
    expect(html).toContain(`<div class="workspace-shell" dir="${language === 'ar' ? 'rtl' : 'ltr'}"`);
    for (const key of ['navigation', 'openMenu', 'closeMenu', 'collapseSidebar'] as const) {
      expect(html).toContain(`aria-label="${labels[key]}"`);
    }
    expect(html).toContain(`href="#workspace-main"`);
    expect(html).toContain(labels.skipContent);
    expect(html).toMatch(/<dialog\b[^>]*aria-labelledby="workspace-menu-title"/);
    expect(html).toContain('<bdi dir="auto">&lt;script&gt;unsafe account&lt;/script&gt;</bdi>');
    expect(html).not.toContain('<script>');
    expect(html.match(/data-testid="single-page-child"/g)).toHaveLength(1);
    expectLanguageControl(html, language);
  }
});

test('public shells frame their content once without protected navigation or account identity', () => {
  for (const language of ['ar', 'en'] as const) {
    const html = renderToStaticMarkup(createElement(PublicLayout, { language, onLanguageChange: noop,
      children: createElement('p', { 'data-testid': 'public-state' }, 'Public state sentinel') }));
    expect(html).toContain(`<div class="public-shell" dir="${language === 'ar' ? 'rtl' : 'ltr'}"`);
    expect(html).toContain(messages[language].appName);
    expectLanguageControl(html, language);
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html.match(/data-testid="public-state"/g)).toHaveLength(1);
    expect(menus(html)).toEqual([]);
    expect(html).not.toContain('workspace-sidebar'); expect(html).not.toContain('<dialog');
    expect(html).not.toContain('shell-identity'); expect(html).not.toContain('LAYOUT-QA');
  }
});
