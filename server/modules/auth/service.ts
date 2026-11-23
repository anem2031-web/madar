import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hashPassword, isPasswordAllowed, verifyPassword } from '../../core/auth/password.ts';
import { effectivePermissions, hasPermission } from '../../core/permissions/guard.ts';
import { AuthFault } from './errors.ts';
import type { AuthAudit, AuthSession, AuthStore, AuthTransaction, AuthUser } from './store.ts';

const idleMs = 30 * 60_000;
const absoluteMs = 8 * 60 * 60_000;
const throttleMs = 15 * 60_000;

export type AuthRequest = { token?: string; csrf?: string; origin?: string; peer: string; requestId: string };
export type SessionView = {
  state: 'anonymous' | 'password_change' | 'authenticated';
  csrfToken: string;
  user?: { username: string; roleCode: string; permissions: string[] };
  expiresAt?: string;
};
export type AuthResult = { view: SessionView; token?: string };

export function createAuthService(store: AuthStore, options: { origin: string; secret: string; now?: () => Date }) {
  const clock = options.now ?? (() => new Date());
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const mac = (value: string) => createHmac('sha256', options.secret).update(value).digest('base64url');
  const validToken = (token?: string): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
  const csrf = (token: string) => mac(`csrf:${digest(token).toString('hex')}`);
  async function checkMutation(request: AuthRequest) {
    const expected = validToken(request.token) ? Buffer.from(csrf(request.token)) : Buffer.alloc(0);
    const actual = Buffer.from(request.csrf ?? '');
    const valid = request.origin === options.origin && expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!valid) {
      await store.transaction(async tx => {
        const now = clock();
        const allowed = await tx.consumeThrottle([Buffer.from(mac(`csrf:${request.peer}`), 'base64url')], now, 30, throttleMs);
        if (allowed) await tx.appendAudit(event(request, now, 'auth.csrf', null, 'denied', 'csrf_failed'));
      });
      throw new AuthFault('AUTH_CSRF');
    }
  }
  function makeSession(now: Date, user?: AuthUser, previous?: AuthSession) {
    const token = randomBytes(32).toString('base64url');
    const absolute = user ? previous?.absoluteExpiresAt ?? new Date(now.getTime() + absoluteMs) : null;
    const session: AuthSession = {
      id: randomUUID(), tokenHash: digest(token), userId: user?.id ?? null,
      stage: user ? user.mustChangePassword ? 'password_change' : 'authenticated' : 'preauth',
      authVersion: user?.authVersion ?? null,
      authenticatedAt: user ? previous?.authenticatedAt ?? now : null,
      absoluteExpiresAt: absolute, createdAt: now, lastActivityAt: now,
      expiresAt: new Date(Math.min(now.getTime() + idleMs, absolute?.getTime() ?? Infinity)), revokedAt: null, version: 1,
    };
    return { token, session };
  }
  function view(session: AuthSession, token: string, user?: AuthUser | null): SessionView {
    return {
      state: session.stage === 'preauth' ? 'anonymous' : session.stage,
      csrfToken: csrf(token), expiresAt: session.expiresAt.toISOString(),
      ...(user && session.stage === 'authenticated' ? { user: { username: user.username, roleCode: user.roleCode, permissions: effectivePermissions(user) } } : {}),
    };
  }
  async function read(tx: AuthTransaction, request: AuthRequest, now: Date) {
    if (!validToken(request.token)) return null;
    const session = await tx.getSession(digest(request.token));
    if (!session || session.revokedAt || session.expiresAt <= now || (session.absoluteExpiresAt && session.absoluteExpiresAt <= now)) return null;
    if (!Number.isFinite(session.expiresAt.getTime()) || !Number.isFinite(session.createdAt.getTime())
      || !Number.isFinite(session.lastActivityAt.getTime()) || !Number.isSafeInteger(session.version) || session.version < 1) return null;
    if (session.stage === 'preauth') return { session, user: null };
    if (!session.userId || !session.authenticatedAt || !session.absoluteExpiresAt
      || !Number.isFinite(session.authenticatedAt.getTime()) || !Number.isFinite(session.absoluteExpiresAt.getTime())
      || session.absoluteExpiresAt.getTime() > session.authenticatedAt.getTime() + absoluteMs
      || session.expiresAt > session.absoluteExpiresAt) return null;
    const user = await tx.getUser(session.userId);
    if (!user || user.accountStatus !== 'active' || user.authVersion !== session.authVersion) return null;
    if ((session.stage === 'authenticated' && user.mustChangePassword) || (session.stage === 'password_change' && !user.mustChangePassword)) return null;
    return { session, user };
  }
  function event(request: AuthRequest, now: Date, action: string, user: AuthUser | null, result: AuthAudit['result'], reasonCode: string | null = null): AuthAudit {
    return { eventId: randomUUID(), occurredAt: now, actorUserId: user?.id ?? null, actorRoleId: user?.roleId ?? null,
      actorRoleCode: user?.roleCode ?? null, module: 'auth', action, entityId: user?.id ?? null,
      requestId: request.requestId, result, reasonCode };
  }
  async function session(request: AuthRequest): Promise<AuthResult> {
    if (request.origin && request.origin !== options.origin) throw new AuthFault('AUTH_FORBIDDEN');
    const result = await store.transaction(async tx => {
      const now = clock();
      const current = await read(tx, request, now);
      if (current && request.token) return { view: view(current.session, request.token, current.user) };
      if (!await tx.consumeThrottle([Buffer.from(mac(`preauth:${request.peer}`), 'base64url')], now, 30, throttleMs)) return null;
      const fresh = makeSession(now);
      await tx.insertSession(fresh.session);
      return { view: view(fresh.session, fresh.token), token: fresh.token };
    });
    if (!result) throw new AuthFault('AUTH_RATE_LIMITED');
    return result;
  }
  async function login(request: AuthRequest, input: { username: string; password: string }): Promise<AuthResult> {
    await checkMutation(request);
    const now = clock();
    const username = input.username.toLowerCase();
    const allowed = await store.transaction(async tx => {
      const current = await read(tx, request, now);
      if (!current || current.session.stage !== 'preauth') throw new AuthFault('AUTH_REQUIRED');
      const sourceAllowed = await tx.consumeThrottle([Buffer.from(mac(`source:${request.peer}`), 'base64url')], now, 30, throttleMs);
      const accountAllowed = await tx.consumeThrottle([Buffer.from(mac(`account:${username}`), 'base64url')], now, 5, throttleMs);
      if (!sourceAllowed || !accountAllowed) await tx.appendAudit(event(request, now, 'auth.login', null, 'denied', 'rate_limited'));
      return sourceAllowed && accountAllowed;
    });
    if (!allowed) throw new AuthFault('AUTH_RATE_LIMITED');
    const candidate = await store.transaction(tx => tx.findUserByUsername(username));
    const verified = await verifyPassword(input.password, candidate?.passwordHash ?? '');
    const result = await store.transaction(async tx => {
      const current = await read(tx, request, clock());
      const user = candidate ? await tx.getUser(candidate.id) : null;
      if (!current || current.session.stage !== 'preauth') return null;
      if (!verified || !user || user.accountStatus !== 'active' || user.passwordHash !== candidate?.passwordHash || user.authVersion !== candidate.authVersion) {
        await tx.appendAudit(event(request, now, 'auth.login', null, 'denied', 'invalid_credentials'));
        return null;
      }
      const fresh = makeSession(clock(), user);
      await tx.revokeSession(current.session.id, now);
      await tx.insertSession(fresh.session);
      await tx.appendAudit(event(request, now, 'auth.login', user, 'success'));
      return { view: view(fresh.session, fresh.token, user), token: fresh.token };
    });
    if (!result) throw new AuthFault('AUTH_INVALID_CREDENTIALS');
    return result;
  }
  async function changePassword(request: AuthRequest, input: { currentPassword: string; newPassword: string }): Promise<AuthResult> {
    await checkMutation(request);
    if (!isPasswordAllowed(input.newPassword)) throw new AuthFault('AUTH_PASSWORD_POLICY');
    if (input.currentPassword === input.newPassword) throw new AuthFault('AUTH_PASSWORD_REUSED');
    const initial = await store.transaction(tx => read(tx, request, clock()));
    if (!initial?.user) throw new AuthFault('AUTH_REQUIRED');
    const allowed = await store.transaction(tx => tx.consumeThrottle([Buffer.from(mac(`password:${initial.user!.id}`), 'base64url')], clock(), 5, throttleMs));
    if (!allowed) {
      await store.transaction(tx => tx.appendAudit(event(request, clock(), 'auth.password_change', initial.user, 'denied', 'rate_limited')));
      throw new AuthFault('AUTH_RATE_LIMITED');
    }
    if (!await verifyPassword(input.currentPassword, initial.user.passwordHash)) {
      await store.transaction(tx => tx.appendAudit(event(request, clock(), 'auth.password_change', initial.user, 'denied', 'invalid_credentials')));
      throw new AuthFault('AUTH_INVALID_CREDENTIALS');
    }
    const passwordHash = await hashPassword(input.newPassword);
    return store.transaction(async tx => {
      const now = clock();
      const current = await read(tx, request, now);
      if (!current?.user || current.user.passwordHash !== initial.user!.passwordHash || current.user.authVersion !== initial.user!.authVersion) throw new AuthFault('AUTH_REQUIRED');
      if (!await tx.updatePassword(current.user.id, current.user.authVersion, passwordHash, now)) throw new AuthFault('AUTH_REQUIRED');
      const user = { ...current.user, passwordHash, mustChangePassword: false, authVersion: current.user.authVersion + 1 };
      await tx.revokeUserSessions(user.id, now);
      const fresh = makeSession(now, user, current.session);
      await tx.insertSession(fresh.session);
      await tx.appendAudit(event(request, now, 'auth.password_change', user, 'success'));
      return { view: view(fresh.session, fresh.token, user), token: fresh.token };
    });
  }
  async function logout(request: AuthRequest): Promise<AuthResult> {
    await checkMutation(request);
    const now = clock();
    const actor = await store.transaction(async tx => {
      const current = await read(tx, request, now);
      if (current) await tx.revokeSession(current.session.id, now);
      return current?.user ?? null;
    });
    // Revocation is committed independently: audit failure must not prevent reducing access.
    try {
      if (actor) await store.transaction(async tx => { await tx.appendAudit(event(request, now, 'auth.logout', actor, 'success')); });
    } catch { /* Revocation remains effective when the audit store is unavailable. */ }
    return session({ ...request, token: undefined });
  }
  async function activity(request: AuthRequest): Promise<AuthResult> {
    await checkMutation(request);
    return store.transaction(async tx => {
      const now = clock();
      const current = await read(tx, request, now);
      if (!current?.user || current.session.stage !== 'authenticated') throw new AuthFault('AUTH_REQUIRED');
      const expiry = new Date(Math.min(now.getTime() + idleMs, current.session.absoluteExpiresAt!.getTime()));
      if (!await tx.touchSession(current.session.id, current.session.version, now, expiry)) throw new AuthFault('AUTH_REQUIRED');
      return { view: view({ ...current.session, expiresAt: expiry }, request.token!, current.user) };
    });
  }
  async function requirePermission(request: AuthRequest, permission: string) {
    return store.transaction(async tx => {
      const now = clock();
      const current = await read(tx, request, now);
      if (!current?.user || current.session.stage !== 'authenticated') throw new AuthFault('AUTH_REQUIRED');
      if (!hasPermission(current.user, permission)) {
        await tx.appendAudit(event(request, now, 'auth.permission', current.user, 'denied', 'forbidden'));
        return null;
      }
      return { userId: current.user.id, scope: 'all_branches' as const };
    }).then(value => { if (!value) throw new AuthFault('AUTH_FORBIDDEN'); return value; });
  }
  return { session, login, changePassword, logout, activity, requirePermission };
}

export type AuthService = ReturnType<typeof createAuthService>;
