import type { AuthAudit, AuthSession, AuthStore, AuthTransaction, AuthUser } from '../store.ts';

// Transactional fixture for service/HTTP/browser tests only; never imported by the runtime entry point.
export function createMemoryAuthStore(initialUsers: AuthUser[] = []) {
  type Data = { users: Map<string, AuthUser>; sessions: Map<string, AuthSession>; events: AuthAudit[];
    throttles: Map<string, { count: number; expires: number }> };
  let data: Data = { users: new Map(initialUsers.map(user => [user.id, user])), sessions: new Map(), events: [], throttles: new Map() };
  let tail = Promise.resolve();
  let failAudit = false;
  const store: AuthStore = {
    async transaction(work) {
      let release!: () => void;
      const turn = new Promise<void>(resolve => { release = resolve; });
      const before = tail;
      tail = turn;
      await before;
      const copy: Data = {
        users: new Map([...data.users].map(([key, value]) => [key, structuredClone(value)])),
        sessions: new Map([...data.sessions].map(([key, value]) => [key, { ...structuredClone(value), tokenHash: Buffer.from(value.tokenHash) }])),
        events: structuredClone(data.events), throttles: new Map([...data.throttles].map(([key, value]) => [key, { ...value }])),
      };
      const tx: AuthTransaction = {
        async findUserByUsername(username) { return [...copy.users.values()].find(user => user.username.trim().toLowerCase() === username) ?? null; },
        async getUser(id) { return copy.users.get(id) ?? null; },
        async getSession(hash) { return [...copy.sessions.values()].find(value => value.tokenHash.equals(hash)) ?? null; },
        async insertSession(value) { copy.sessions.set(value.id, value); },
        async revokeSession(id, now) { const value = copy.sessions.get(id); if (value) { value.revokedAt = now; value.version++; } },
        async revokeUserSessions(id, now) { for (const value of copy.sessions.values()) if (value.userId === id) { value.revokedAt = now; value.version++; } },
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
            const id = key.toString('hex');
            const previous = copy.throttles.get(id);
            const value = !previous || previous.expires <= now.getTime() ? { count: 0, expires: now.getTime() + windowMs } : previous;
            value.count++; copy.throttles.set(id, value);
            if (value.count > limit) allowed = false;
          }
          return allowed;
        },
        async appendAudit(event) { if (failAudit) throw new Error('Synthetic audit failure.'); copy.events.push(event); },
      };
      try { const result = await work(tx); data = copy; return result; }
      finally { release(); }
    },
  };
  return { ...store, get users() { return data.users; }, get sessions() { return data.sessions; }, get events() { return data.events; },
    setAuditFailure(value: boolean) { failAudit = value; } };
}
