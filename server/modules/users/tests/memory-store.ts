import type { AuthAudit, AuthSession, AuthUser } from '../../auth/store.ts';
import { UsersFault } from '../errors.ts';
import type { ManagedRole, ManagedUser, UsersStore, UsersTransaction } from '../store.ts';

export type MemoryRole = ManagedRole & { permissions: string[] };

// Test/browser fixture only: this intentionally does not model TiDB's row locks or optimizer.
export function createMemoryUsersStore(initialUsers: AuthUser[] = [], initialRoles?: MemoryRole[]) {
  type Data = {
    users: Map<string, AuthUser>;
    roles: Map<string, MemoryRole>;
    sessions: Map<string, AuthSession>;
    events: AuthAudit[];
    throttles: Map<string, { count: number; expires: number }>;
  };
  const roles = initialRoles ?? initialUsers.map(user => ({ id: user.roleId, code: user.roleCode,
    name: user.roleCode, permissions: [...user.rolePermissions] }));
  let data: Data = { users: new Map(initialUsers.map(user => [user.id, structuredClone(user)])),
    roles: new Map(roles.map(role => [role.id, structuredClone(role)])), sessions: new Map(), events: [], throttles: new Map() };
  let tail = Promise.resolve();
  let failAudit = false;
  let beforeTransaction: (() => void) | undefined;
  const store: UsersStore = {
    async transaction(work) {
      let release!: () => void;
      const turn = new Promise<void>(resolve => { release = resolve; });
      const before = tail;
      tail = turn;
      await before;
      try {
        beforeTransaction?.();
        const copy: Data = { users: structuredClone(data.users), roles: structuredClone(data.roles),
          sessions: new Map([...data.sessions].map(([key, session]) => [key, { ...structuredClone(session), tokenHash: Buffer.from(session.tokenHash) }])),
          events: structuredClone(data.events), throttles: structuredClone(data.throttles) };
        const readUser = (id: string) => {
          const user = copy.users.get(id);
          const role = user ? copy.roles.get(user.roleId) : undefined;
          return user && role ? { ...user, roleCode: role.code, rolePermissions: [...role.permissions] } : null;
        };
        const managed = (id: string): ManagedUser | null => {
          const user = readUser(id);
          if (!user) return null;
          return { id: user.id, username: user.username, roleId: user.roleId, roleCode: user.roleCode,
            accountStatus: user.accountStatus as ManagedUser['accountStatus'], mustChangePassword: user.mustChangePassword, authVersion: user.authVersion };
        };
        const tx: UsersTransaction = {
          async findUserByUsername(username) {
            const user = [...copy.users.values()].find(value => value.username.trim().toLowerCase() === username);
            return user ? readUser(user.id) : null;
          },
          async getUser(id) { return readUser(id); },
          async getSession(hash) { return [...copy.sessions.values()].find(value => value.tokenHash.equals(hash)) ?? null; },
          async insertSession(value) { copy.sessions.set(value.id, structuredClone(value) as AuthSession); copy.sessions.get(value.id)!.tokenHash = Buffer.from(value.tokenHash); },
          async revokeSession(id, now) { const value = copy.sessions.get(id); if (value) { value.revokedAt = now; value.version++; } },
          async revokeUserSessions(id, now) { for (const value of copy.sessions.values()) if (value.userId === id && !value.revokedAt) { value.revokedAt = now; value.version++; } },
          async updatePassword(id, version, hash) {
            const user = copy.users.get(id);
            if (!user || user.authVersion !== version || user.accountStatus !== 'active') return false;
            user.passwordHash = hash; user.authVersion++; user.mustChangePassword = false; return true;
          },
          async touchSession(id, version, now, expiry) {
            const value = copy.sessions.get(id);
            if (!value || value.version !== version || value.revokedAt) return false;
            value.lastActivityAt = now; value.expiresAt = expiry; value.version++; return true;
          },
          async consumeThrottle(keys, now, limit, windowMs) {
            let allowed = true;
            for (const key of keys) {
              const id = key.toString('hex'); const previous = copy.throttles.get(id);
              const value = !previous || previous.expires <= now.getTime() ? { count: 0, expires: now.getTime() + windowMs } : previous;
              value.count++; copy.throttles.set(id, value); if (value.count > limit) allowed = false;
            }
            return allowed;
          },
          async clearReauthThrottle(key) { copy.throttles.delete(key.toString('hex')); },
          async appendAudit(event) { if (failAudit) throw new Error('Synthetic audit failure.'); copy.events.push(structuredClone(event)); },
          async listUsers(cursor, limit) {
            return [...copy.users.keys()].sort().filter(id => !cursor || id > cursor).slice(0, limit)
              .map(id => managed(id)).filter((user): user is ManagedUser => user !== null);
          },
          async listRoles() { return [...copy.roles.values()].map(({ id, code, name }) => ({ id, code, name })); },
          async getManagedUser(id) { return managed(id); },
          async getRole(id) { const role = copy.roles.get(id); return role ? { id: role.id, code: role.code, name: role.name } : null; },
          async insertUser(input) {
            if ([...copy.users.values()].some(user => user.username.trim().toLowerCase() === input.username.trim().toLowerCase())) {
              throw new UsersFault('USERS_DUPLICATE_USERNAME');
            }
            const role = copy.roles.get(input.roleId);
            if (!role) throw new UsersFault('USERS_ROLE_NOT_FOUND');
            copy.users.set(input.id, { id: input.id, username: input.username, passwordHash: input.passwordHash,
              roleId: role.id, roleCode: role.code, accountStatus: 'active', mustChangePassword: true, authVersion: 1,
              rolePermissions: [...role.permissions], overrides: [] });
          },
          async assignRole(id, version, roleId) {
            const user = copy.users.get(id);
            if (!user || user.authVersion !== version) return false;
            user.roleId = roleId; user.authVersion++; return true;
          },
          async disableUser(id, version) {
            const user = copy.users.get(id);
            if (!user || user.authVersion !== version || user.accountStatus === 'disabled') return false;
            user.accountStatus = 'disabled'; user.authVersion++; return true;
          },
          async resetPassword(id, version, hash) {
            const user = copy.users.get(id);
            if (!user || user.authVersion !== version) return false;
            user.passwordHash = hash; user.mustChangePassword = true; user.authVersion++; return true;
          },
        };
        const result = await work(tx);
        data = copy;
        return result;
      } finally { release(); }
    },
  };
  return { ...store, get users() { return data.users; }, get roles() { return data.roles; }, get sessions() { return data.sessions; },
    get events() { return data.events; }, setAuditFailure(value: boolean) { failAudit = value; },
    setBeforeTransaction(callback?: () => void) { beforeTransaction = callback; } };
}
