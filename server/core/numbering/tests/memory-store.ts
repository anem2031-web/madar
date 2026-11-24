import type { AuthAudit, AuthSession, AuthUser } from '../../../modules/auth/store.ts';
import type { NumberingSeries } from '../../../../shared/numbering/settings.ts';
import type { NumberingSeriesRecord, NumberingSettingsStore, NumberingSettingsTransaction } from '../store.ts';

// Isolated fixture: atomic snapshots and serialization do not model TiDB locks or index plans.
export function createMemoryNumberingStore(initialUsers: AuthUser[] = [], initialSeries: NumberingSeries[] = []) {
  type Data = { users: Map<string, AuthUser>; sessions: Map<string, AuthSession>; events: AuthAudit[];
    throttles: Map<string, { count: number; expires: number }>; series: Map<string, NumberingSeriesRecord>; issued: Set<string> };
  const initialRecords = initialSeries.map(({ hasIssued: _hasIssued, ...record }) => record);
  let data: Data = { users: new Map(initialUsers.map(user => [user.id, structuredClone(user)])), sessions: new Map(),
    events: [], throttles: new Map(), series: new Map(initialRecords.map(record => [record.id, structuredClone(record)])),
    issued: new Set(initialSeries.filter(record => record.hasIssued).map(record => record.id)) };
  let tail = Promise.resolve();
  let failAudit = false;
  let failWrite = false;
  let beforeTransaction: (() => void) | undefined;
  const duplicate = (index: string) => Object.assign(new Error(`Duplicate entry for key 'numbering_series.${index}'`), { code: 'ER_DUP_ENTRY', errno: 1062 });
  const afterWrite = () => { if (failWrite) throw new Error('Synthetic numbering write failure.'); };
  const store: NumberingSettingsStore = {
    async transaction(work) {
      let release!: () => void;
      const turn = new Promise<void>(resolve => { release = resolve; });
      const previous = tail; tail = turn; await previous;
      try {
        beforeTransaction?.();
        const copy: Data = { users: structuredClone(data.users), events: structuredClone(data.events), throttles: structuredClone(data.throttles),
          series: structuredClone(data.series), issued: new Set(data.issued),
          sessions: new Map([...data.sessions].map(([id, session]) => [id, { ...structuredClone(session), tokenHash: Buffer.from(session.tokenHash) }])) };
        const assertUnique = (record: NumberingSeriesRecord, except?: string) => {
          for (const other of copy.series.values()) if (other.id !== except) {
            if (other.code === record.code) throw duplicate('uq_numbering_series_code');
            if (other.prefix === record.prefix) throw duplicate('uq_numbering_series_prefix');
          }
        };
        const tx: NumberingSettingsTransaction = {
          async findUserByUsername(name) {
            const user = [...copy.users.values()].find(value => value.username.trim().toLowerCase() === name);
            return user ? structuredClone(user) : null;
          },
          async getUser(id) { const user = copy.users.get(id); return user ? structuredClone(user) : null; },
          async getSession(hash) { return [...copy.sessions.values()].find(value => value.tokenHash.equals(hash)) ?? null; },
          async insertSession(value) { copy.sessions.set(value.id, { ...structuredClone(value), tokenHash: Buffer.from(value.tokenHash) }); },
          async revokeSession(id, now) { const session = copy.sessions.get(id); if (session && !session.revokedAt) { session.revokedAt = now; session.version++; } },
          async revokeUserSessions(id, now) { for (const session of copy.sessions.values()) if (session.userId === id && !session.revokedAt) { session.revokedAt = now; session.version++; } },
          async updatePassword(id, version, hash) {
            const user = copy.users.get(id);
            if (!user || user.authVersion !== version || user.accountStatus !== 'active') return false;
            user.passwordHash = hash; user.authVersion++; user.mustChangePassword = false; return true;
          },
          async touchSession(id, version, now, expiresAt) {
            const session = copy.sessions.get(id);
            if (!session || session.version !== version || session.revokedAt) return false;
            session.lastActivityAt = now; session.expiresAt = expiresAt; session.version++; return true;
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
          async appendAudit(event) { if (failAudit) throw new Error('Synthetic numbering audit failure.'); copy.events.push(structuredClone(event)); },
          async listSeries(cursor, limit) {
            return [...copy.series.values()].sort((a, b) => a.id.localeCompare(b.id)).filter(record => !cursor || record.id > cursor).slice(0, limit)
              .map(record => ({ ...structuredClone(record), hasIssued: copy.issued.has(record.id) }));
          },
          async getSeries(id) { const record = copy.series.get(id); return record ? structuredClone(record) : null; },
          async hasIssuances(id) { return copy.issued.has(id); },
          async insertSeries(record) {
            if (copy.series.has(record.id)) throw new Error('Synthetic duplicate identifier.');
            assertUnique(record); copy.series.set(record.id, structuredClone(record)); afterWrite();
          },
          async updateSeries(id, version, changes) {
            const record = copy.series.get(id); if (!record || record.version !== version) return false;
            const next = { ...record, ...changes, version: version + 1 };
            assertUnique(next, id); copy.series.set(id, next); afterWrite(); return true;
          },
        };
        const result = await work(tx); data = copy; return result;
      } finally { release(); }
    },
  };
  return { ...store, get users() { return data.users; }, get sessions() { return data.sessions; }, get events() { return data.events; },
    get series() { return data.series; }, get issued() { return data.issued; },
    markIssued(id: string) { data.issued.add(id); }, setAuditFailure(value: boolean) { failAudit = value; },
    setWriteFailure(value: boolean) { failWrite = value; }, setBeforeTransaction(callback?: () => void) { beforeTransaction = callback; } };
}
