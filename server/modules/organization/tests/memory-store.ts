import type { AuthAudit, AuthSession, AuthUser } from '../../auth/store.ts';
import type { Branch, Department, OrganizationStore, OrganizationTransaction } from '../store.ts';
import type { WriteOperationReceipt } from '../../../core/write-operations/store.ts';

// Synthetic test/browser fixture only. Serialization is not a TiDB lock or optimizer model.
export function createMemoryOrganizationStore(initialUsers: AuthUser[] = [], initialBranches: Branch[] = [], initialDepartments: Department[] = []) {
  type Data = {
    users: Map<string, AuthUser>; sessions: Map<string, AuthSession>; events: AuthAudit[];
    branches: Map<string, Branch>; departments: Map<string, Department>;
    receipts: Map<string, WriteOperationReceipt>;
    throttles: Map<string, { count: number; expires: number }>;
  };
  let data: Data = { users: new Map(initialUsers.map(value => [value.id, structuredClone(value)])),
    branches: new Map(initialBranches.map(value => [value.id, structuredClone(value)])),
    departments: new Map(initialDepartments.map(value => [value.id, structuredClone(value)])),
    sessions: new Map(), events: [], throttles: new Map(), receipts: new Map() };
  let tail = Promise.resolve();
  let failAudit = false;
  let failWrite = false;
  let failReceipt = false;
  let beforeTransaction: (() => void) | undefined;
  const afterWrite = () => { if (failWrite) throw new Error('Synthetic organization write failure.'); };
  const store: OrganizationStore = {
    async transaction(work) {
      let release!: () => void;
      const turn = new Promise<void>(resolve => { release = resolve; });
      const previous = tail; tail = turn; await previous;
      try {
        beforeTransaction?.();
        const copy: Data = { users: structuredClone(data.users), branches: structuredClone(data.branches), departments: structuredClone(data.departments),
          receipts: new Map([...data.receipts].map(([id, value]) => [id, { ...structuredClone(value), inputHash: Buffer.from(value.inputHash) }])),
          events: structuredClone(data.events), throttles: structuredClone(data.throttles),
          sessions: new Map([...data.sessions].map(([id, value]) => [id, { ...structuredClone(value), tokenHash: Buffer.from(value.tokenHash) }])) };
        const tx: OrganizationTransaction = {
          async findUserByUsername(name) {
            const user = [...copy.users.values()].find(value => value.username.trim().toLowerCase() === name);
            return user ? structuredClone(user) : null;
          },
          async getUser(id) { const user = copy.users.get(id); return user ? structuredClone(user) : null; },
          async getSession(hash) { return [...copy.sessions.values()].find(value => value.tokenHash.equals(hash)) ?? null; },
          async insertSession(value) { copy.sessions.set(value.id, { ...structuredClone(value), tokenHash: Buffer.from(value.tokenHash) }); },
          async revokeSession(id, now) { const value = copy.sessions.get(id); if (value && !value.revokedAt) { value.revokedAt = now; value.version++; } },
          async revokeUserSessions(id, now) { for (const value of copy.sessions.values()) if (value.userId === id && !value.revokedAt) { value.revokedAt = now; value.version++; } },
          async updatePassword(id, version, hash) {
            const user = copy.users.get(id);
            if (!user || user.authVersion !== version || user.accountStatus !== 'active') return false;
            user.passwordHash = hash; user.authVersion++; user.mustChangePassword = false; return true;
          },
          async touchSession(id, version, now, expiresAt) {
            const value = copy.sessions.get(id);
            if (!value || value.version !== version || value.revokedAt) return false;
            value.lastActivityAt = now; value.expiresAt = expiresAt; value.version++; return true;
          },
          async consumeThrottle(keys, now, limit, windowMs) {
            let allowed = true;
            for (const key of keys) {
              const id = key.toString('hex'); const prior = copy.throttles.get(id);
              const value = !prior || prior.expires <= now.getTime() ? { count: 0, expires: now.getTime() + windowMs } : prior;
              value.count++; copy.throttles.set(id, value); if (value.count > limit) allowed = false;
            }
            return allowed;
          },
          async appendAudit(event) { if (failAudit) throw new Error('Synthetic organization audit failure.'); copy.events.push(structuredClone(event)); },
          async claimWriteOperation(value) {
            if (!copy.receipts.has(value.operationId)) copy.receipts.set(value.operationId, { ...structuredClone(value), inputHash: Buffer.from(value.inputHash) });
            const row = copy.receipts.get(value.operationId)!;
            return { ...structuredClone(row), inputHash: Buffer.from(row.inputHash) };
          },
          async completeWriteOperation(operationId, reservationToken, response) {
            if (response === null || response === undefined) throw new Error('Completed write operation response required.');
            if (failReceipt) throw new Error('Synthetic write operation receipt completion failure.');
            const row = copy.receipts.get(operationId);
            if (!row || row.reservationToken !== reservationToken || row.response !== null) return false;
            row.response = structuredClone(response); return true;
          },
          async cancelWriteOperation(operationId, reservationToken) {
            const row = copy.receipts.get(operationId);
            if (row?.reservationToken === reservationToken && row.response === null) copy.receipts.delete(operationId);
          },
          async listBranches(cursor, limit) {
            return [...copy.branches.values()].sort((a, b) => a.id.localeCompare(b.id)).filter(value => !cursor || value.id > cursor).slice(0, limit).map(value => structuredClone(value));
          },
          async listDepartments(branchId, cursor, limit) {
            return [...copy.departments.values()].filter(value => value.branchId === branchId && (!cursor || value.id > cursor))
              .sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit).map(value => structuredClone(value));
          },
          async getBranch(id) { const row = copy.branches.get(id); return row ? structuredClone(row) : null; },
          async getDepartment(branchId, id) { const row = copy.departments.get(id); return row?.branchId === branchId ? structuredClone(row) : null; },
          async insertBranch(row) {
            if (copy.branches.has(row.id)) throw new Error('Synthetic duplicate organization identifier.');
            copy.branches.set(row.id, structuredClone(row)); afterWrite();
          },
          async renameBranch(id, version, name) {
            const row = copy.branches.get(id); if (!row || row.version !== version) return false;
            row.name = name; row.version++; afterWrite(); return true;
          },
          async insertDepartment(row) {
            if (!copy.branches.has(row.branchId) || copy.departments.has(row.id)) throw new Error('Synthetic invalid organization relation.');
            copy.departments.set(row.id, structuredClone(row)); afterWrite();
          },
          async renameDepartment(branchId, id, version, name) {
            const row = copy.departments.get(id); if (!row || row.branchId !== branchId || row.version !== version) return false;
            row.name = name; row.version++; afterWrite(); return true;
          },
        };
        const result = await work(tx); data = copy; return result;
      } finally { release(); }
    },
  };
  return { ...store, get users() { return data.users; }, get sessions() { return data.sessions; }, get events() { return data.events; },
    get branches() { return data.branches; }, get departments() { return data.departments; },
    get receipts() { return data.receipts; },
    setAuditFailure(value: boolean) { failAudit = value; }, setWriteFailure(value: boolean) { failWrite = value; },
    setReceiptFailure(value: boolean) { failReceipt = value; },
    setBeforeTransaction(callback?: () => void) { beforeTransaction = callback; } };
}
