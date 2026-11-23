import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from '../../core/auth/password.ts';
import { AuthFault } from '../auth/errors.ts';
import type { AuthRequest, AuthService } from '../auth/service.ts';
import type { AuthAudit, AuthUser } from '../auth/store.ts';
import { UsersFault } from './errors.ts';
import type { ManagedUser, UsersStore, UsersTransaction } from './store.ts';
import { assignRoleInput, createInput, listInput, targetInput } from './validation.ts';

type Target = { userId: string; expectedAuthVersion: number; currentPassword: string };
type Options = { now?: () => Date };
const windowMs = 15 * 60_000;

function duplicate(error: unknown) {
  let current = error;
  for (let i = 0; i < 6 && current && typeof current === 'object'; i++) {
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062) return true;
    current = candidate.cause;
  }
  return false;
}
const safeValues = (user: ManagedUser) => ({ roleId: user.roleId, accountStatus: user.accountStatus,
  mustChangePassword: user.mustChangePassword, authVersion: user.authVersion });

export function createUsersService(store: UsersStore, auth: AuthService, options: Options = {}) {
  const clock = options.now ?? (() => new Date());
  function audit(request: AuthRequest, action: string, actor: AuthUser | null, result: 'success' | 'denied',
    entityId: string | null = null, reasonCode: string | null = null): AuthAudit {
    return { eventId: randomUUID(), occurredAt: clock(), actorUserId: actor?.id ?? null,
      actorRoleId: actor?.roleId ?? null, actorRoleCode: actor?.roleCode ?? null,
      module: 'users', action, entityId, requestId: request.requestId, result, reasonCode };
  }

  // Known denials commit their safe event; unexpected write/audit errors roll back everything.
  async function guarded<T>(request: AuthRequest, action: string,
    work: (tx: UsersTransaction, actor: AuthUser) => Promise<T>, entityId: string | null = null, duplicateUsername?: string): Promise<T> {
    try {
      const outcome = await store.transaction(async tx => {
        let actor: AuthUser | null = null;
        try {
          actor = (await auth.authorizeInTransaction(tx, request, 'users.manage', clock(), user => { actor = user; })).user;
          return { value: await work(tx, actor) };
        } catch (error) {
          if (!(error instanceof UsersFault || error instanceof AuthFault)) throw error;
          await tx.appendAudit(audit(request, action, actor, 'denied', entityId, error.reason));
          return { error };
        }
      });
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    } catch (error) {
      if (action !== 'users.create' || !duplicateUsername || !duplicate(error)) throw error;
      // A real UNIQUE race, unlike a precheck, is handled after its transaction rolled back.
      const isUsernameConflict = await store.transaction(async tx => {
        const actor = (await auth.authorizeInTransaction(tx, request, 'users.manage', clock())).user;
        if (!await tx.findUserByUsername(duplicateUsername.toLowerCase())) return false;
        await tx.appendAudit(audit(request, action, actor, 'denied', entityId, 'USERS_DUPLICATE_USERNAME'));
        return true;
      });
      if (!isUsernameConflict) throw error;
      throw new UsersFault('USERS_DUPLICATE_USERNAME');
    }
  }

  async function reauthenticate(request: AuthRequest, action: string, password: string, entityId: string | null = null) {
    await auth.checkMutation(request);
    const actor = await guarded(request, action, async (tx, current) => {
      if (!await tx.consumeThrottle([auth.securityKey(`users:reauth:${current.id}`)], clock(), 5, windowMs)) throw new AuthFault('AUTH_RATE_LIMITED');
      return current;
    }, entityId);
    if (!await verifyPassword(password, actor.passwordHash)) {
      await guarded(request, action, async () => { throw new UsersFault('USERS_REAUTH_FAILED'); }, entityId);
    }
    return actor;
  }
  function unchangedActor(actor: AuthUser, expected: AuthUser) {
    if (actor.authVersion !== expected.authVersion || actor.passwordHash !== expected.passwordHash) throw new AuthFault('AUTH_REQUIRED');
  }
  async function target(tx: UsersTransaction, input: Target) {
    const user = await tx.getManagedUser(input.userId);
    if (!user) throw new UsersFault('USERS_NOT_FOUND');
    if (user.authVersion !== input.expectedAuthVersion || user.authVersion >= 4_294_967_295) throw new UsersFault('USERS_CONFLICT');
    return user;
  }
  function selfChange(actor: AuthUser, user: ManagedUser) {
    if (actor.id === user.id) throw new UsersFault('USERS_SELF_CHANGE');
  }

  async function list(request: AuthRequest, input: { cursor?: string } = {}) {
    input = listInput(input);
    return guarded(request, 'users.list', async (tx, actor) => {
      const rows = await tx.listUsers(input.cursor, 26);
      const page = rows.slice(0, 25);
      await tx.appendAudit({ ...audit(request, 'users.list', actor, 'success'), metadata: { count: page.length } });
      return { users: page, ...(rows.length > 25 ? { nextCursor: page.at(-1)!.id } : {}) };
    });
  }
  async function roles(request: AuthRequest) {
    return guarded(request, 'users.roles', async (tx, actor) => {
      const roles = await tx.listRoles();
      await tx.appendAudit({ ...audit(request, 'users.roles', actor, 'success'), metadata: { count: roles.length } });
      return { roles };
    });
  }
  async function create(request: AuthRequest, input: { username: string; roleId: string; currentPassword: string }) {
    input = createInput(input);
    const actor = await reauthenticate(request, 'users.create', input.currentPassword);
    const temporaryPassword = randomBytes(18).toString('base64url');
    const passwordHash = await hashPassword(temporaryPassword);
    return guarded(request, 'users.create', async (tx, current) => {
      unchangedActor(current, actor);
      const role = await tx.getRole(input.roleId);
      if (!role) throw new UsersFault('USERS_ROLE_NOT_FOUND');
      if (await tx.findUserByUsername(input.username.toLowerCase())) throw new UsersFault('USERS_DUPLICATE_USERNAME');
      const user: ManagedUser = { id: randomUUID(), username: input.username, roleId: role.id, roleCode: role.code,
        accountStatus: 'active', mustChangePassword: true, authVersion: 1 };
      await tx.insertUser({ id: user.id, username: user.username, roleId: role.id, passwordHash, now: clock() });
      await tx.clearReauthThrottle(auth.securityKey(`users:reauth:${current.id}`));
      await tx.appendAudit({ ...audit(request, 'users.create', current, 'success', user.id), afterValues: safeValues(user) });
      return { user, temporaryPassword };
    }, null, input.username);
  }
  async function assignRole(request: AuthRequest, input: Target & { roleId: string }) {
    input = assignRoleInput(input);
    const actor = await reauthenticate(request, 'users.assign_role', input.currentPassword, input.userId);
    return guarded(request, 'users.assign_role', async (tx, current) => {
      unchangedActor(current, actor);
      const before = await target(tx, input);
      selfChange(current, before);
      const role = await tx.getRole(input.roleId);
      if (!role) throw new UsersFault('USERS_ROLE_NOT_FOUND');
      if (before.roleId === role.id) throw new UsersFault('USERS_CONFLICT');
      if (!await tx.assignRole(before.id, before.authVersion, role.id, clock())) throw new UsersFault('USERS_CONFLICT');
      await tx.revokeUserSessions(before.id, clock());
      await tx.clearReauthThrottle(auth.securityKey(`users:reauth:${current.id}`));
      const user: ManagedUser = { ...before, roleId: role.id, roleCode: role.code, authVersion: before.authVersion + 1 };
      await tx.appendAudit({ ...audit(request, 'users.assign_role', current, 'success', user.id), beforeValues: safeValues(before), afterValues: safeValues(user) });
      return { user };
    }, input.userId);
  }
  async function disable(request: AuthRequest, input: Target) {
    input = targetInput(input);
    const actor = await reauthenticate(request, 'users.disable', input.currentPassword, input.userId);
    return guarded(request, 'users.disable', async (tx, current) => {
      unchangedActor(current, actor);
      const before = await target(tx, input);
      selfChange(current, before);
      if (before.accountStatus === 'disabled') throw new UsersFault('USERS_ALREADY_DISABLED');
      if (!await tx.disableUser(before.id, before.authVersion, clock())) throw new UsersFault('USERS_CONFLICT');
      await tx.revokeUserSessions(before.id, clock());
      await tx.clearReauthThrottle(auth.securityKey(`users:reauth:${current.id}`));
      const user: ManagedUser = { ...before, accountStatus: 'disabled', authVersion: before.authVersion + 1 };
      await tx.appendAudit({ ...audit(request, 'users.disable', current, 'success', user.id), beforeValues: safeValues(before), afterValues: safeValues(user) });
      return { user };
    }, input.userId);
  }
  async function resetPassword(request: AuthRequest, input: Target) {
    input = targetInput(input);
    const actor = await reauthenticate(request, 'users.reset_password', input.currentPassword, input.userId);
    const temporaryPassword = randomBytes(18).toString('base64url');
    const passwordHash = await hashPassword(temporaryPassword);
    return guarded(request, 'users.reset_password', async (tx, current) => {
      unchangedActor(current, actor);
      const before = await target(tx, input);
      if (!await tx.resetPassword(before.id, before.authVersion, passwordHash, clock())) throw new UsersFault('USERS_CONFLICT');
      await tx.revokeUserSessions(before.id, clock());
      await tx.clearReauthThrottle(auth.securityKey(`users:reauth:${current.id}`));
      const user: ManagedUser = { ...before, mustChangePassword: true, authVersion: before.authVersion + 1 };
      await tx.appendAudit({ ...audit(request, 'users.reset_password', current, 'success', user.id), beforeValues: safeValues(before), afterValues: safeValues(user) });
      return { user, temporaryPassword, callerSessionRevoked: current.id === user.id };
    }, input.userId);
  }
  return { list, roles, create, assignRole, disable, resetPassword };
}

export type UsersService = ReturnType<typeof createUsersService>;
