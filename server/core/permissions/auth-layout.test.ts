import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';
import type { SessionView } from '../../../client/src/modules/auth/useAuth.ts';
import type { ClientPageDecision } from '../../../client/src/modules/auth/usePageGuard.ts';
import { messages } from '../../../client/src/i18n/locale.ts';
import { getPage } from '../../../shared/permissions/pages.ts';

const fixture = vi.hoisted(() => ({
  session: null as SessionView | null,
  decision: { kind: 'checking' } as ClientPageDecision,
  pathname: '/users', pending: false, verifying: false,
  error: null as string | null, notice: null as 'signedOut' | null,
}));

vi.mock('../../../client/src/modules/auth/useAuth.ts', () => ({ useAuth: () => ({
  ...fixture, errorRequestId: '12345678-1234-1234-1234-123456789abc',
  refresh: vi.fn(), invalidateSession: vi.fn(), logout: vi.fn(), login: vi.fn(), changePassword: vi.fn(),
  beginForeground: vi.fn(() => true), endForeground: vi.fn(),
}) }));
vi.mock('../../../client/src/modules/auth/usePageGuard.ts', () => ({ usePageGuard: () => ({
  decision: fixture.decision, retry: vi.fn(), accessHandlers: {},
}) }));
vi.mock('../../../client/src/app/navigation.ts', () => ({ usePathname: () => fixture.pathname, navigate: vi.fn() }));
vi.mock('../../../client/src/modules/auth/ProtectedPageContent.tsx', () => ({ protectedPageComponents: {
  organization: () => 'Protected organization sentinel', users: () => 'Protected users sentinel',
  permissions: () => 'Protected permissions sentinel', numbering: () => 'Protected numbering sentinel', audit: () => 'Protected audit sentinel',
} }));

import { AuthScreen } from '../../../client/src/modules/auth/AuthScreen.tsx';

beforeEach(() => {
  fixture.session = {
    state: 'authenticated', csrfToken: 'synthetic-csrf-context', expiresAt: '2099-01-01T00:00:00.000Z',
    user: { username: 'PRIVATE-LAYOUT-ACCOUNT', roleCode: 'system_admin', permissions: ['users.manage'] },
  };
  fixture.decision = { kind: 'checking' }; fixture.pathname = '/users';
  fixture.pending = false; fixture.verifying = false; fixture.error = null; fixture.notice = null;
});

function render(language: 'ar' | 'en' = 'ar') {
  return renderToStaticMarkup(createElement(AuthScreen, { language, onLanguageChange: () => {} }));
}

test('checking, redirection and terminal guard states never retain a previous authenticated account frame', () => {
  const decisions: ClientPageDecision[] = [
    { kind: 'checking' }, { kind: 'redirect', target: '/organization' }, { kind: 'unavailable' },
    { kind: 'no-access' }, { kind: 'not-found' },
    { kind: 'access-conflict', requestId: '12345678-1234-1234-1234-123456789abc' },
  ];
  for (const decision of decisions) {
    fixture.decision = decision;
    for (const language of ['ar', 'en'] as const) {
      const html = render(language);
      expect(html).toContain('public-shell');
      expect(html).not.toContain('workspace-shell'); expect(html).not.toContain('workspace-sidebar');
      expect(html).not.toContain('PRIVATE-LAYOUT-ACCOUNT'); expect(html).not.toContain('Protected users sentinel');
      expect(html).not.toContain('synthetic-csrf-context');
      expect(html.match(/<main\b/g)).toHaveLength(1);
    }
  }
});

test('anonymous login and mandatory password change use the public frame without functional navigation', () => {
  for (const state of ['anonymous', 'password_change'] as const) {
    fixture.session = { state, csrfToken: 'synthetic-csrf-context',
      user: state === 'password_change' ? { username: 'PRIVATE-LAYOUT-ACCOUNT', roleCode: 'system_admin', permissions: ['users.manage'] } : undefined };
    fixture.decision = { kind: state === 'anonymous' ? 'login' : 'password-change' };
    for (const language of ['ar', 'en'] as const) {
      const html = render(language);
      expect(html).toContain('public-shell');
      expect(html).toContain(messages[language][state === 'anonymous' ? 'loginHeading' : 'changePasswordHeading']);
      expect(html).toContain(`name="${state === 'anonymous' ? 'password' : 'current-password'}"`);
      expect(html).not.toContain('workspace-sidebar'); expect(html).not.toContain('shell-identity');
      expect(html).not.toContain('href="/users"'); expect(html).not.toContain('PRIVATE-LAYOUT-ACCOUNT');
    }
  }
});

test('trusted workspace and registered pages use the protected frame with one child instance', () => {
  for (const [pathname, kind] of [['/', 'workspace'], ['/users', 'render']] as const) {
    fixture.pathname = pathname;
    const page = getPage(pathname)!;
    if (kind === 'workspace' && page.kind === 'workspace') fixture.decision = { kind, page };
    else if (kind === 'render' && page.kind === 'protected') fixture.decision = { kind, page };
    else throw new Error('The registered fixture page has an unexpected kind.');
    for (const language of ['ar', 'en'] as const) {
      const html = render(language);
      expect(html).toContain('workspace-shell'); expect(html).not.toContain('public-shell');
      expect(html).toContain('PRIVATE-LAYOUT-ACCOUNT');
      expect(html).toContain('href="/users"'); expect(html).not.toContain('href="/audit"');
      expect(html.match(/<main\b/g)).toHaveLength(1);
      if (kind === 'render') expect(html.match(/Protected users sentinel/g)).toHaveLength(1);
      else expect(html).toContain(messages[language].welcome);
    }
  }
});

test('a background check retains the allowed page and disables shell actions instead of remounting a public frame', () => {
  const page = getPage('/users')!;
  if (page.kind !== 'protected') throw new Error('Expected a protected users fixture.');
  fixture.decision = { kind: 'render', page }; fixture.verifying = true;
  const html = render();
  expect(html).toContain('workspace-shell'); expect(html).not.toContain('public-shell');
  expect(html).toContain(messages.ar.checking);
  expect(html.match(/Protected users sentinel/g)).toHaveLength(1);
  expect(html).not.toContain('href="/users"');
  const disabledLinks = [...html.matchAll(/<a\b([^>]*)>/g)].filter(link => link[1].includes('aria-disabled="true"'));
  expect(disabledLinks.length).toBeGreaterThan(0);
  for (const link of disabledLinks) {
    expect(link[1]).toContain('role="link"'); expect(link[1]).not.toContain('href=');
  }
});

test('connection and login errors keep translated feedback and references in the public frame', () => {
  for (const [decision, error, expected] of [
    [{ kind: 'unavailable' }, 'AUTH_UNAVAILABLE', 'requestFailed'],
    [{ kind: 'login' }, 'AUTH_INVALID_CREDENTIALS', 'invalidCredentials'],
  ] as const) {
    fixture.decision = decision; fixture.error = error;
    fixture.session = decision.kind === 'login' ? { state: 'anonymous', csrfToken: 'synthetic-csrf-context' } : null;
    for (const language of ['ar', 'en'] as const) {
      const html = render(language);
      expect(html).toContain('public-shell'); expect(html).not.toContain('workspace-sidebar');
      expect(html).toContain(messages[language][expected]);
      expect(html).toContain('12345678-1234-1234-1234-123456789abc');
      expect(html).not.toContain(error); expect(html).not.toContain('PRIVATE-LAYOUT-ACCOUNT');
    }
  }
});
