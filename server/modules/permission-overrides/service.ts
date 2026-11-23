import { randomUUID } from 'node:crypto';
import { isPermissionCode } from '../../../shared/permissions/catalog.ts';
import { verifyPassword } from '../../core/auth/password.ts';
import { effectivePermissions } from '../../core/permissions/guard.ts';
import { AuthFault } from '../auth/errors.ts';
import type { AuthRequest, AuthService } from '../auth/service.ts';
import type { AuthAudit, AuthUser } from '../auth/store.ts';
import { OverridesFault } from './errors.ts';
import type { PermissionDetail, PermissionOverridesStore, PermissionOverridesTransaction, PermissionUser } from './store.ts';
import { detailInput, listInput, saveInput } from './validation.ts';

const windowMs = 15 * 60_000;
type Options = { now?: () => Date };
type SaveInput = ReturnType<typeof saveInput>;

function safeUser(user: AuthUser): PermissionUser {
  if (user.accountStatus !== 'active' && user.accountStatus !== 'disabled') throw new Error('Invalid stored user state.');
  return { id: user.id, username: user.username, roleCode: user.roleCode, accountStatus: user.accountStatus, authVersion: user.authVersion };
}
function safeDetail(user: AuthUser, actorId: string): PermissionDetail {
  // Reject unexpected stored effects rather than misrepresenting them as editable grants.
  if (user.overrides.some(entry => !isPermissionCode(entry.permissionCode) || !['grant', 'deny'].includes(entry.effect))) {
    throw new Error('Invalid stored permission override.');
  }
  return { user: safeUser(user), rolePermissions: user.rolePermissions.filter(isPermissionCode).sort(),
    overrides: user.overrides.map(entry => ({ permissionCode: entry.permissionCode as PermissionDetail['overrides'][number]['permissionCode'],
      effect: entry.effect as 'grant' | 'deny' })).sort((left, right) => left.permissionCode.localeCompare(right.permissionCode)),
    effectivePermissions: effectivePermissions(user), editable: user.id !== actorId };
}

export function createPermissionOverridesService(store: PermissionOverridesStore, auth: AuthService, options: Options = {}) {
  const clock = options.now ?? (() => new Date());
  const reauthKey = (id: string) => auth.securityKey(`permission-overrides:reauth:${id}`);
  function audit(request: AuthRequest, action: string, actor: AuthUser | null, result: 'success' | 'denied',
    entityId: string | null = null, reasonCode: string | null = null): AuthAudit {
    return { eventId: randomUUID(), occurredAt: clock(), actorUserId: actor?.id ?? null,
      actorRoleId: actor?.roleId ?? null, actorRoleCode: actor?.roleCode ?? null,
      module: 'permissions', action, entityId, requestId: request.requestId, result, reasonCode };
  }
  async function guarded<T>(request: AuthRequest, action: string,
    work: (tx: PermissionOverridesTransaction, actor: AuthUser) => Promise<T>, entityId: string | null = null): Promise<T> {
    const outcome = await store.transaction(async tx => {
      let actor: AuthUser | null = null;
      try {
        actor = (await auth.authorizeInTransaction(tx, request, 'permissions.manage_overrides', clock(), current => { actor = current; })).user;
        return { value: await work(tx, actor) };
      } catch (error) {
        if (!(error instanceof AuthFault || error instanceof OverridesFault)) throw error;
        await tx.appendAudit(audit(request, action, actor, 'denied', entityId, error.reason));
        return { error };
      }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  async function reauthenticate(request: AuthRequest, input: SaveInput) {
    await auth.checkMutation(request);
    const actor = await guarded(request, 'permissions.overrides.save', async (tx, current) => {
      if (current.id === input.userId) throw new OverridesFault('OVERRIDES_SELF_CHANGE');
      if (!await tx.consumeThrottle([reauthKey(current.id)], clock(), 5, windowMs)) throw new AuthFault('AUTH_RATE_LIMITED');
      return current;
    }, input.userId);
    if (!await verifyPassword(input.currentPassword, actor.passwordHash)) {
      await guarded(request, 'permissions.overrides.save', async () => { throw new OverridesFault('OVERRIDES_REAUTH_FAILED'); }, input.userId);
    }
    return actor;
  }
  async function list(request: AuthRequest, input: { cursor?: string } = {}) {
    const parsed = listInput(input);
    return guarded(request, 'permissions.overrides.list', async (tx, actor) => {
      const rows = await tx.listPermissionUsers(parsed.cursor, 26);
      const page = rows.slice(0, 25);
      await tx.appendAudit({ ...audit(request, 'permissions.overrides.list', actor, 'success'), metadata: { count: page.length } });
      return { users: page, ...(rows.length > 25 ? { nextCursor: page.at(-1)!.id } : {}) };
    });
  }
  async function detail(request: AuthRequest, input: { userId: string }) {
    const parsed = detailInput(input);
    return guarded(request, 'permissions.overrides.detail', async (tx, actor) => {
      const user = await tx.getUser(parsed.userId);
      if (!user) throw new OverridesFault('OVERRIDES_NOT_FOUND');
      const result = safeDetail(user, actor.id);
      await tx.appendAudit(audit(request, 'permissions.overrides.detail', actor, 'success', user.id));
      return result;
    }, parsed.userId);
  }
  async function save(request: AuthRequest, input: SaveInput) {
    const parsed = saveInput(input);
    const verifiedActor = await reauthenticate(request, parsed);
    return guarded(request, 'permissions.overrides.save', async (tx, actor) => {
      if (actor.authVersion !== verifiedActor.authVersion || actor.passwordHash !== verifiedActor.passwordHash) throw new AuthFault('AUTH_REQUIRED');
      if (actor.id === parsed.userId) throw new OverridesFault('OVERRIDES_SELF_CHANGE');
      const before = await tx.getUser(parsed.userId);
      if (!before) throw new OverridesFault('OVERRIDES_NOT_FOUND');
      if (before.authVersion !== parsed.expectedAuthVersion) throw new OverridesFault('OVERRIDES_CONFLICT');
      const beforeDetail = safeDetail(before, actor.id);
      const changed = JSON.stringify(beforeDetail.overrides) !== JSON.stringify(parsed.overrides);
      if (changed && before.authVersion >= 4_294_967_295) throw new OverridesFault('OVERRIDES_CONFLICT');
      // Resolve all expected denials before writing. Unexpected errors after this point roll back.
      if (changed && !await tx.bumpAuthVersion(before.id, before.authVersion, clock())) throw new OverridesFault('OVERRIDES_CONFLICT');
      if (changed) {
        await tx.replaceOverrides(before.id, parsed.overrides, clock());
        await tx.revokeUserSessions(before.id, clock());
      }
      await tx.clearReauthThrottle(reauthKey(actor.id));
      const after = { ...before, authVersion: before.authVersion + Number(changed), overrides: parsed.overrides };
      const result = safeDetail(after, actor.id);
      await tx.appendAudit({ ...audit(request, 'permissions.overrides.save', actor, 'success', before.id),
        beforeValues: { authVersion: before.authVersion, overrides: beforeDetail.overrides },
        afterValues: { authVersion: after.authVersion, overrides: result.overrides }, metadata: { changed } });
      return { changed, detail: result };
    }, parsed.userId);
  }
  return { list, detail, save };
}

export type PermissionOverridesService = ReturnType<typeof createPermissionOverridesService>;
