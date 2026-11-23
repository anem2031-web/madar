import type { AuthAudit, AuthSession, AuthUser } from '../../auth/store.ts';
import type { PermissionOverridesStore, PermissionOverridesTransaction, PermissionUser } from '../store.ts';

// Synthetic tests/browser fixture only. Serialization models atomic commit, not TiDB locks or plans.
export function createMemoryPermissionOverridesStore(initialUsers: AuthUser[] = []) {
  type Data = {
    users: Map<string, AuthUser>;
    sessions: Map<string, AuthSession>;
    events: AuthAudit[];
    throttles: Map<string, { count: number; expires: number }>;
  };
  let data: Data = { users: new Map(initialUsers.map(user => [user.id, structuredClone(user)])),
    sessions: new Map(), events: [], throttles: new Map() };
  let tail = Promise.resolve();
  let failAudit = false;
  let failReplace = false;
  let beforeTransaction: (() => void) | undefined;
  const store: PermissionOverridesStore = {
    async transaction(work) {
      let release!: () => void;
      const turn = new Promise<void>(resolve => { release = resolve; });
      const previous = tail;
      tail = turn;
      await previous;
      try {
        beforeTransaction?.();
        const copy: Data = { users: structuredClone(data.users), events: structuredClone(data.events),
          sessions: new Map([...data.sessions].map(([id, value]) => [id, { ...structuredClone(value), tokenHash: Buffer.from(value.tokenHash) }])),
          throttles: structuredClone(data.throttles) };
        const tx: PermissionOverridesTransaction = {
          async findUserByUsername(name) {
            const user = [...copy.users.values()].find(value => value.username.trim().toLowerCase() === name);
            return user ? structuredClone(user) : null;
          },
          async getUser(id) { const user = copy.users.get(id); return user ? structuredClone(user) : null; },
          async getSession(hash) { return [...copy.sessions.values()].find(value => value.tokenHash.equals(hash)) ?? null; },
          async insertSession(value) { copy.sessions.set(value.id, { ...structuredClone(value), tokenHash: Buffer.from(value.tokenHash) }); },
          async revokeSession(id, now) { const value = copy.sessions.get(id); if (value && !value.revokedAt) { value.revokedAt = now; value.version++; } },
          async revokeUserSessions(id, now) {
            for (const value of copy.sessions.values()) if (value.userId === id && !value.revokedAt) { value.revokedAt = now; value.version++; }
          },
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
              const id = key.toString('hex'); const existing = copy.throttles.get(id);
              const value = !existing || existing.expires <= now.getTime() ? { count: 0, expires: now.getTime() + windowMs } : existing;
              value.count++; copy.throttles.set(id, value); if (value.count > limit) allowed = false;
            }
            return allowed;
          },
          async clearReauthThrottle(key) { copy.throttles.delete(key.toString('hex')); },
          async appendAudit(event) { if (failAudit) throw new Error('Synthetic audit failure.'); copy.events.push(structuredClone(event)); },
          async listPermissionUsers(cursor, limit) {
            return [...copy.users.values()].sort((left, right) => left.id.localeCompare(right.id))
              .filter(user => !cursor || user.id > cursor).slice(0, limit)
              .map(user => ({ id: user.id, username: user.username, roleCode: user.roleCode,
                accountStatus: user.accountStatus as PermissionUser['accountStatus'], authVersion: user.authVersion }));
          },
          async bumpAuthVersion(id, version) {
            const user = copy.users.get(id);
            if (!user || user.authVersion !== version) return false;
            user.authVersion++; return true;
          },
          async replaceOverrides(id, overrides) {
            const user = copy.users.get(id);
            if (!user) throw new Error('Synthetic missing target.');
            user.overrides = structuredClone(overrides);
            if (failReplace) throw new Error('Synthetic replace failure.');
          },
        };
        const result = await work(tx);
        data = copy;
        return result;
      } finally { release(); }
    },
  };
  return { ...store, get users() { return data.users; }, get sessions() { return data.sessions; },
    get events() { return data.events; }, get throttles() { return data.throttles; },
    setAuditFailure(value: boolean) { failAudit = value; }, setReplaceFailure(value: boolean) { failReplace = value; },
    setBeforeTransaction(callback?: () => void) { beforeTransaction = callback; } };
}
