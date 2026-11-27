import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createApp } from '../../app.ts';
import { hashPassword } from '../auth/password.ts';
import { permissionCodes } from '../../../shared/permissions/catalog.ts';
import type { AuthUser } from '../../modules/auth/store.ts';
import type { UsersTransaction } from '../../modules/users/store.ts';
import { createMemoryUsersStore } from '../../modules/users/tests/memory-store.ts';

const password = 'Synthetic foundation session password';
const configuredOrigin = 'http://localhost:3000';
const period = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-24T00:00:00.000Z' };
const readers = ['users.list', 'permissionOverrides.list', 'organization.listBranches', 'numberingSettings.list', 'audit.list'] as const;
const listeners: ReturnType<ReturnType<typeof createApp>['listen']>[] = [];
let passwordHash = '';
beforeAll(async () => { passwordHash = await hashPassword(password); });
afterEach(async () => {
  for (const listener of listeners.splice(0)) if (listener.listening) {
    const closed = once(listener, 'close'); listener.close(); await closed;
  }
});

async function fixture() {
  const user: AuthUser = { id: randomUUID(), username: 'FOUNDATION', passwordHash, roleId: randomUUID(), roleCode: 'system_admin',
    accountStatus: 'active', mustChangePassword: false, authVersion: 1, rolePermissions: [...permissionCodes], overrides: [] };
  // All module adapters use one auth/session transaction state. These spies stand
  // in for domain reads; they do not model Drizzle, TiDB locks or durable outbox.
  const store = createMemoryUsersStore([user]);
  const businessRead = vi.fn();
  const businessWrite = vi.fn(async (): Promise<never> => { throw new Error('Unexpected protected business write.'); });
  const receipt = vi.fn(async (): Promise<never> => { throw new Error('Unexpected write receipt access.'); });
  const adapt = <T extends object>(methods: T) => ({
    transaction<R>(work: (tx: UsersTransaction & T) => Promise<R>) {
      return store.transaction(tx => work({ ...tx, ...methods }));
    },
  });
  const read = async <T>(value: T) => { businessRead(); return value; };
  const branch = { id: randomUUID(), name: 'Synthetic foundation branch', version: 1 };
  const organizationStore = adapt({
    listBranches: async () => read([branch]), listDepartments: async () => read([]),
    getBranch: async () => read(branch), getDepartment: async () => read(null),
    insertBranch: businessWrite, renameBranch: businessWrite, insertDepartment: businessWrite, renameDepartment: businessWrite,
    claimWriteOperation: receipt, completeWriteOperation: receipt, cancelWriteOperation: receipt,
  });
  const permissionOverridesStore = adapt({
    listPermissionUsers: async () => read([{ id: user.id, username: user.username, roleCode: user.roleCode,
      accountStatus: 'active' as const, authVersion: 1 }]),
    clearReauthThrottle: businessWrite, bumpAuthVersion: businessWrite, replaceOverrides: businessWrite,
  });
  const numberingSettingsStore = adapt({ listSeries: async () => read([]), getSeries: async () => read(null),
    hasIssuances: async () => read(false), insertSeries: businessWrite, updateSeries: businessWrite });
  const auditStore = adapt({ listEvents: async () => read([]), getEvent: async () => read(null),
    deliveryStatus: async () => read({ pending: 0, leased: 0, failed: 0, oldestPendingAt: null, failures: [] }) });
  const usersStore = {
    transaction<R>(work: (tx: UsersTransaction) => Promise<R>) {
      return store.transaction(tx => work({ ...tx,
        listUsers: async (cursor, limit) => { businessRead(); return tx.listUsers(cursor, limit); },
      }));
    },
  };
  const listener = createApp({ authStore: store, usersStore, permissionOverridesStore, organizationStore, numberingSettingsStore,
    auditStore, authConfig: { origin: configuredOrigin, secret: 'synthetic-foundation-session-secret-'.repeat(2) } }).listen(0, '127.0.0.1');
  listeners.push(listener); await once(listener, 'listening');
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture listener.');
  const origin = `http://127.0.0.1:${address.port}`;
  async function send(path: string, cookie = '', csrf = '', input?: unknown, mutation = false) {
    const query = input === undefined || mutation ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const response = await fetch(`${origin}/api/trpc/${path}${query}`, { method: mutation ? 'POST' : 'GET',
      headers: { cookie, origin: configuredOrigin, ...(mutation ? { 'content-type': 'application/json', 'x-madar-csrf': csrf } : {}) },
      ...(mutation ? { body: JSON.stringify(input ?? {}) } : {}), redirect: 'manual' });
    const body = await response.json();
    return { response, body, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? cookie };
  }
  return { store, user, send, businessRead, businessWrite, receipt };
}

test.each([false, true])('HTTP logout invalidates the old credentials across every protected module (audit unavailable: %s)', async auditUnavailable => {
  const f = await fixture();
  const preauth = await f.send('auth.session');
  expect(preauth.body.result.data.state).toBe('anonymous');
  const login = await f.send('auth.login', preauth.cookie, preauth.body.result.data.csrfToken,
    { username: f.user.username, password }, true);
  expect(login.response.status).toBe(200);
  expect(login.body.result.data.state).toBe('authenticated');
  const oldCookie = login.cookie, oldCsrf = login.body.result.data.csrfToken;
  for (const path of readers) {
    const result = await f.send(path, oldCookie, oldCsrf, path === 'audit.list' ? period : undefined);
    expect(result.response.status).toBe(200);
    expect(result.body).toHaveProperty('result');
  }
  const readsBeforeLogout = f.businessRead.mock.calls.length;
  expect(readsBeforeLogout).toBeGreaterThanOrEqual(readers.length);

  f.store.setAuditFailure(auditUnavailable);
  const logout = await f.send('auth.logout', oldCookie, oldCsrf, {}, true);
  f.store.setAuditFailure(false);
  expect(logout.response.status).toBe(200);
  expect(logout.response.headers.get('cache-control')).toBe('no-store');
  expect(logout.body.result.data.state).toBe('anonymous');
  expect(logout.body.result.data).not.toHaveProperty('user');
  expect(logout.cookie).not.toBe(oldCookie);
  expect(logout.response.headers.get('set-cookie')).toContain('HttpOnly');
  expect(logout.response.headers.get('set-cookie')).toContain('SameSite=Lax');
  expect(logout.body.result.data.csrfToken).not.toBe(oldCsrf);
  const authenticated = [...f.store.sessions.values()].filter(session => session.userId === f.user.id);
  expect(authenticated).toHaveLength(1);
  expect(authenticated[0].revokedAt).toBeInstanceOf(Date);
  expect(f.store.events.filter(event => event.action === 'auth.logout' && event.result === 'success')).toHaveLength(auditUnavailable ? 0 : 1);

  const assertRejected = (result: Awaited<ReturnType<typeof f.send>>) => {
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get('content-type')).toContain('application/json');
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.response.headers.get('location')).toBeNull();
    expect(result.body.error.message).toBe('AUTH_REQUIRED');
    expect(result.body).not.toHaveProperty('result');
    expect(result.body.error.data.requestId).toBe(result.response.headers.get('x-request-id'));
    expect(JSON.stringify(result.body)).not.toMatch(/passwordHash|scrypt\$|<html/i);
    expect(JSON.stringify(result.body)).not.toContain(password);
  };
  for (const path of readers) assertRejected(await f.send(path, oldCookie, oldCsrf, path === 'audit.list' ? period : undefined));
  assertRejected(await f.send('organization.createBranch', oldCookie, oldCsrf,
    { operationId: randomUUID(), name: 'Must never be created' }, true));
  expect(f.businessRead).toHaveBeenCalledTimes(readsBeforeLogout);
  expect(f.businessWrite).not.toHaveBeenCalled();
  expect(f.receipt).not.toHaveBeenCalled();
  expect((await f.send('auth.session', oldCookie, oldCsrf)).body.result.data.state).toBe('anonymous');
  expect((await f.send('auth.session', logout.cookie, logout.body.result.data.csrfToken)).body.result.data.state).toBe('anonymous');
});
