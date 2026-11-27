/** Explicit, destructive-to-its-own-fixtures verification. Never run against application data. */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import express from 'express';
import { createApp } from '../server/app.ts';
import { openDatabase } from '../server/core/database/connection.ts';
import { createAuditDispatcher } from '../server/core/audit/dispatcher.ts';
import { createAuditDeliveryStore } from '../server/core/audit/delivery-repository.ts';
import { createAuthStore, sqlUtc } from '../server/modules/auth/repository.ts';
import { createAuthService } from '../server/modules/auth/service.ts';
import type { AuthRequest } from '../server/modules/auth/service.ts';
import { createOrganizationStore } from '../server/modules/organization/repository.ts';
import { createOrganizationService } from '../server/modules/organization/service.ts';
import type { OrganizationStore, OrganizationTransaction } from '../server/modules/organization/store.ts';

const tableNames = ['audit_events', 'audit_outbox', 'auth_throttles', 'branches', 'departments', 'employees',
  'numbering_counters', 'numbering_issuances', 'numbering_series', 'permissions', 'role_permissions', 'roles',
  'sessions', 'user_permission_overrides', 'users', 'write_operation_receipts'] as const;
const expectedMigrations = [
  { hash: '28613c7d87709947e45105ac0489c2ff99d1e5beae4009dca9cb7b0c3f4541c8', created_at: 1795360011508 },
  { hash: '0c6666805e703a5b659f642ae1b1fc1bc294f68b36aa77b58e20e171ce70b927', created_at: 1795605194621 },
];
const runId = randomUUID();
const prefix = `Dbfix-${runId}-`;
const outputPath = resolve(process.argv[2] ?? 'docs/DB_POOL_FIX_RESULTS.json');
const sourceUrl = process.env.MADAR_TEST_DATABASE_URL;
const report: Record<string, unknown> = { runId, startedAt: new Date().toISOString(), environment: {
  database: 'madartest', actualHttpServer: 'localhost', timingsIncludeRemoteNetwork: true, node: process.version,
  productionDatabaseTouched: false, schemaChanges: false, globalSettingsChanged: false,
}, cases: [] };
Object.assign(report.environment as object, {
  connectionSourceSha256: createHash('sha256').update(await readFile(new URL('../server/core/database/connection.ts', import.meta.url))).digest('hex'),
});
type Case = { name: string; passed: boolean; [key: string]: unknown };
const cases = report.cases as Case[];
class VerificationFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
function assert(condition: unknown, safeCode: string): asserts condition { if (!condition) throw new VerificationFailure(safeCode); }
function safeFailure(error: unknown) {
  // No exception messages/stacks, SQL, URLs, input bodies, headers or tokens in the artifact.
  if (error instanceof VerificationFailure) return error.code;
  let current: unknown = error;
  for (let i = 0; i < 6 && current && typeof current === 'object'; i++) {
    const object = current as Record<string, unknown>;
    for (const key of ['reason', 'code']) {
      const value = object[key];
      if (typeof value === 'string' && /^(?:DB_|AUTH_|ORG_)[A-Z_]+$/.test(value)) return value;
    }
    current = object.cause;
  }
  return 'VERIFICATION_FAILURE';
}
const rounded = (value: number) => Math.round(value * 1000) / 1000;
function latency(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  return { samples: values.length, p50Ms: rounded(ordered[Math.ceil(ordered.length * .5) - 1] ?? 0),
    p95Ms: rounded(ordered[Math.ceil(ordered.length * .95) - 1] ?? 0), maxMs: rounded(ordered.at(-1) ?? 0) };
}
async function check(name: string, work: () => Promise<Record<string, unknown>>) {
  console.info(`Verifying ${name}`);
  try { cases.push({ name, passed: true, ...await work() }); }
  catch (error) { cases.push({ name, passed: false, failure: safeFailure(error) }); }
}

async function main() {
  assert(sourceUrl, 'MISSING_TEST_DATABASE_URL');
  const parsedUrl = new URL(sourceUrl);
  assert(parsedUrl.protocol === 'mysql:' && decodeURIComponent(parsedUrl.pathname) === '/madartest', 'TEST_DATABASE_ONLY');
  const connection = openDatabase(sourceUrl, process.env.MADAR_TEST_DATABASE_TLS_CA_PEM);
  const rows = async (query: Parameters<typeof connection.db.execute>[0]) => (await connection.db.execute(query))[0] as unknown as Record<string, unknown>[];
  const count = async (query: Parameters<typeof connection.db.execute>[0]) => Number((await rows(query))[0]?.n ?? 0);
  const diagnostics = () => connection.diagnostics();
  async function inventory() {
    const currentDatabase = (await rows(sql`SELECT DATABASE() AS current_database`))[0]?.current_database;
    assert(currentDatabase === 'madartest', 'DATABASE_GUARD');
    const tables = await rows(sql`SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA='madartest' AND TABLE_TYPE='BASE TABLE'`);
    assert(tables.length === 17 && tables.every(row => [...tableNames, '__drizzle_migrations'].includes(row.table_name as never)), 'SCHEMA_TABLE_MISMATCH');
    const counts: Record<string, number> = {};
    for (const table of tableNames) counts[table] = await count(sql.raw(`SELECT COUNT(*) AS n FROM \`madartest\`.\`${table}\``));
    const migrations = (await rows(sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at`))
      .map(row => ({ hash: row.hash, created_at: Number(row.created_at) }));
    assert(JSON.stringify(migrations) === JSON.stringify(expectedMigrations), 'MIGRATION_MISMATCH');
    const indexes = await count(sql`SELECT COUNT(*) AS n FROM (SELECT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='madartest' AND TABLE_NAME<>'__drizzle_migrations' GROUP BY TABLE_NAME, INDEX_NAME) AS expected_indexes`);
    const foreignKeys = await count(sql`SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='madartest' AND CONSTRAINT_TYPE='FOREIGN KEY'`);
    return { database: currentDatabase, counts, migrations, indexes, foreignKeys };
  }

  const adminRole = randomUUID(), hrRole = randomUUID();
  const actors = Array.from({ length: 11 }, (_, index) => ({ id: randomUUID(), sessionId: randomUUID(),
    token: randomBytes(32).toString('base64url'), roleId: index === 10 ? hrRole : adminRole, index }));
  const actorIds = actors.map(actor => actor.id);
  const actorSql = sql.join(actorIds.map(id => sql`${id}`), sql`, `);
  const roleSql = sql.join([adminRole, hrRole].map(id => sql`${id}`), sql`, `);
  const grants = ['organization.read', 'settings.manage'];
  const configuredOrigin = 'http://127.0.0.1:3000';
  const secret = randomBytes(48).toString('base64url');
  const requests = actors.map(actor => ({ token: actor.token, csrf: createHmac('sha256', secret)
    .update(`csrf:${createHash('sha256').update(actor.token).digest('hex')}`).digest('base64url'),
    origin: configuredOrigin, peer: '127.0.0.1', requestId: randomUUID() } satisfies AuthRequest));
  let fixtureCommitConfirmed = false;
  let listener: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
  const pendingTransactions = new Set<Promise<unknown>>();
  const transactionTimings: number[] = [];
  const phaseTimings = { authorizationMs: [] as number[], businessMs: [] as number[], auditMs: [] as number[] };
  const baseStore = createOrganizationStore(connection);
  const measuredStore: OrganizationStore = {
    transaction(work) {
      const started = performance.now();
      const task = baseStore.transaction(async tx => {
        const timed = new Proxy(tx, { get(target, key, receiver) {
          const original = Reflect.get(target, key, receiver);
          if (typeof original !== 'function') return original;
          return async (...args: unknown[]) => {
            const start = performance.now();
            try { return await Reflect.apply(original, target, args); }
            finally {
              const group = key === 'appendAudit' ? phaseTimings.auditMs
                : ['getSession', 'getUser', 'touchSession'].includes(String(key)) ? phaseTimings.authorizationMs : phaseTimings.businessMs;
              group.push(performance.now() - start);
            }
          };
        } });
        return work(timed);
      });
      pendingTransactions.add(task);
      void task.finally(() => { pendingTransactions.delete(task); transactionTimings.push(performance.now() - started); }).catch(() => {});
      return task;
    },
  };
  const auth = createAuthService(createAuthStore(connection), { origin: configuredOrigin, secret });
  const service = createOrganizationService(measuredStore, auth);
  const dispatchers = [createAuditDispatcher(createAuditDeliveryStore(connection)), createAuditDispatcher(createAuditDeliveryStore(connection))];
  let httpOrigin = '';
  let droppedResponses = 0;
  const bodyFor = (method: string, actorIndex: number, body?: unknown) => ({ method, headers: {
    cookie: `madar_dev_session=${actors[actorIndex].token}`, origin: configuredOrigin,
    ...(method === 'POST' ? { 'content-type': 'application/json', 'x-madar-csrf': requests[actorIndex].csrf! } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  async function send(actorIndex: number, path: string, body?: unknown) {
    const started = performance.now();
    try {
      const response = await fetch(`${httpOrigin}/api/trpc/organization.${path}${body === undefined ? '?input=%7B%7D' : ''}`, bodyFor(body === undefined ? 'GET' : 'POST', actorIndex, body));
      const value = await response.json();
      return { status: response.status, code: value.error?.message as string | undefined, data: value.result?.data,
        elapsedMs: rounded(performance.now() - started) };
    } catch { return { status: 0, code: 'CLIENT_RESPONSE_UNAVAILABLE', data: undefined, elapsedMs: rounded(performance.now() - started) }; }
  }

  try {
    const tlsRows = await rows(sql`SHOW STATUS LIKE 'Ssl_cipher'`);
    assert(tlsRows.some(row => typeof row.Value === 'string' && row.Value.length > 0), 'TLS_REQUIRED');
    const preflight = await inventory();
    report.preflight = { ...preflight, tls: true };
    assert(Object.values(preflight.counts).every(value => value === 0), 'TEST_DATABASE_NOT_EMPTY');
    assert(preflight.indexes === 42 && preflight.foreignKeys === 13, 'SCHEMA_KEYS_MISMATCH');
    const now = new Date();
    await connection.transaction(async tx => {
      await tx.execute(sql`INSERT INTO roles(id,code,name,version,created_at,updated_at) VALUES
        (${adminRole},'system_admin',${prefix + 'admin'},1,${sqlUtc(now)},${sqlUtc(now)}),
        (${hrRole},'hr',${prefix + 'hr'},1,${sqlUtc(now)},${sqlUtc(now)})`);
      await tx.execute(sql`INSERT INTO permissions(code) VALUES ('organization.read'),('settings.manage')`);
      await tx.execute(sql`INSERT INTO role_permissions(role_id,permission_code) VALUES
        (${adminRole},'organization.read'),(${adminRole},'settings.manage'),(${hrRole},'organization.read')`);
      for (const actor of actors) {
        await tx.execute(sql`INSERT INTO users(id,username,password_hash,role_id,account_status,must_change_password,auth_version,created_at,updated_at)
          VALUES(${actor.id},${prefix + actor.index},'synthetic-no-login',${actor.roleId},'active',false,1,${sqlUtc(now)},${sqlUtc(now)})`);
        await tx.execute(sql`INSERT INTO sessions(id,token_hash,user_id,stage,auth_version,authenticated_at,absolute_expires_at,created_at,last_activity_at,expires_at,version)
          VALUES(${actor.sessionId},${createHash('sha256').update(actor.token).digest()},${actor.id},'authenticated',1,${sqlUtc(now)},
          ${sqlUtc(new Date(now.getTime() + 8 * 3600_000))},${sqlUtc(now)},${sqlUtc(now)},${sqlUtc(new Date(now.getTime() + 30 * 60_000))},1)`);
      }
    });
    fixtureCommitConfirmed = true;
    const app = express();
    app.use((request, response, next) => {
      if (request.get('x-fixture-drop-response') !== runId) { next(); return; }
      const originalWrite = response.write, originalEnd = response.end, originalFlush = response.flushHeaders;
      const chunks: unknown[][] = [];
      (response as any).write = (...args: unknown[]) => { chunks.push(args); return true; };
      response.flushHeaders = () => {};
      (response as any).end = (...args: unknown[]) => {
        response.write = originalWrite; response.end = originalEnd; response.flushHeaders = originalFlush;
        if (response.statusCode === 200) { droppedResponses++; request.socket.destroy(); return response; }
        for (const chunk of chunks) Reflect.apply(originalWrite, response, chunk);
        return Reflect.apply(originalEnd, response, args);
      };
      next();
    });
    app.use(createApp({ authStore: createAuthStore(connection), organizationStore: measuredStore,
      authConfig: { origin: configuredOrigin, secret }, pingDatabase: connection.ping }));
    listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const address = listener.address(); assert(address && typeof address !== 'string', 'LISTENER_MISSING');
    httpOrigin = `http://127.0.0.1:${address.port}`;
    report.configuration = diagnostics();

    for (const concurrency of [5, 10]) {
      for (const kind of ['read', 'write'] as const) {
        await check(`one_pool_http_${kind}_${concurrency}_with_audit`, async () => {
          const before = diagnostics();
          const workers = dispatchers.map(worker => worker.runOnce());
          const results = await Promise.all(Array.from({ length: concurrency }, (_, index) => send(index,
            kind === 'read' ? 'listBranches' : 'createBranch', kind === 'write' ? { operationId: randomUUID(), name: `${prefix}http-${concurrency}-${index}` } : undefined)));
          const workerResults = await Promise.allSettled(workers);
          await Promise.allSettled([...pendingTransactions]);
          const passed = results.every(result => result.status === 200) && workerResults.every(result => result.status === 'fulfilled');
          const entry = { concurrency, successful: results.filter(result => result.status === 200).length,
            outcomes: results.map(({ status, code, elapsedMs }) => ({ status, ...(code ? { code } : {}), elapsedMs })),
            latency: latency(results.map(result => result.elapsedMs)), before, after: diagnostics(), auditWorkers: workerResults.map(result => result.status), passed };
          return entry;
        });
      }
    }

    await check('same_operation_concurrent_exactly_once', async () => {
      const operationId = randomUUID(), name = `${prefix}same-key`;
      const results = await Promise.all(Array.from({ length: 10 }, () => send(0, 'createBranch', { operationId, name })));
      await Promise.allSettled([...pendingTransactions]);
      const receipts = await count(sql`SELECT COUNT(*) AS n FROM write_operation_receipts WHERE operation_id=${operationId} AND response_json IS NOT NULL`);
      const branches = await count(sql`SELECT COUNT(*) AS n FROM branches WHERE name=${name}`);
      const created = await count(sql`SELECT COUNT(*) AS n FROM audit_outbox WHERE actor_user_id=${actors[0].id} AND action='organization.branches.create' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.operationId'))=${operationId}`);
      return { callers: 10, successful: results.filter(result => result.status === 200).length, receipts, branches, created,
        outcomes: results.map(({ status, code, elapsedMs }) => ({ status, ...(code ? { code } : {}), elapsedMs })),
        latency: latency(results.map(result => result.elapsedMs)), passed: results.every(result => result.status === 200) && receipts === 1 && branches === 1 && created === 1 };
    });
    await check('changed_input_rejected', async () => {
      const operationId = randomUUID();
      const first = await send(0, 'createBranch', { operationId, name: `${prefix}conflict-first` });
      const conflict = await send(0, 'createBranch', { operationId, name: `${prefix}conflict-other` });
      return { firstStatus: first.status, conflictStatus: conflict.status, code: conflict.code,
        passed: first.status === 200 && conflict.status === 409 && conflict.code === 'ORG_OPERATION_CONFLICT' };
    });
    await check('optimistic_version_one_winner', async () => {
      const initial = await service.createBranch({ ...requests[0], requestId: randomUUID() }, { operationId: randomUUID(), name: `${prefix}version` });
      const results = await Promise.all([0, 1].map(index => send(index, 'renameBranch', {
        operationId: randomUUID(), branchId: initial.branch.id, expectedVersion: 1, name: `${prefix}renamed-${index}` })));
      const version = Number((await rows(sql`SELECT version FROM branches WHERE id=${initial.branch.id}`))[0]?.version);
      return { statuses: results.map(result => result.status), version,
        passed: results.filter(result => result.status === 200).length === 1 && results.filter(result => result.code === 'ORG_CONFLICT').length === 1 && version === 2 };
    });
    await check('hr_write_forbidden_without_receipt', async () => {
      const operationId = randomUUID();
      const result = await send(10, 'createBranch', { operationId, name: `${prefix}forbidden` });
      const receipts = await count(sql`SELECT COUNT(*) AS n FROM write_operation_receipts WHERE operation_id=${operationId}`);
      return { status: result.status, code: result.code, receipts, passed: result.status === 403 && result.code === 'AUTH_FORBIDDEN' && receipts === 0 };
    });
    for (const fault of ['audit', 'receipt'] as const) {
      await check(`rollback_on_${fault}_failure_then_retry`, async () => {
        const operationId = randomUUID(), name = `${prefix}rollback-${fault}`;
        const failingStore: OrganizationStore = { transaction: work => baseStore.transaction(tx => {
          const wrapped: OrganizationTransaction = { ...tx,
            ...(fault === 'audit' ? { appendAudit: async () => { throw new Error('SYNTHETIC_FAULT'); } }
              : { completeWriteOperation: async () => false }),
          };
          return work(wrapped);
        }) };
        let rejected = false;
        try { await createOrganizationService(failingStore, auth).createBranch({ ...requests[0], requestId: randomUUID() }, { operationId, name }); }
        catch { rejected = true; }
        const receiptsBefore = await count(sql`SELECT COUNT(*) AS n FROM write_operation_receipts WHERE operation_id=${operationId}`);
        const branchesBefore = await count(sql`SELECT COUNT(*) AS n FROM branches WHERE name=${name}`);
        const auditBefore = await count(sql`SELECT COUNT(*) AS n FROM audit_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.operationId'))=${operationId}`);
        const retry = await send(0, 'createBranch', { operationId, name });
        return { rejected, receiptsBefore, branchesBefore, auditBefore, retryStatus: retry.status,
          passed: rejected && receiptsBefore === 0 && branchesBefore === 0 && auditBefore === 0 && retry.status === 200 };
      });
    }
    await check('lost_committed_http_response_explicit_retry', async () => {
      const operationId = randomUUID(), name = `${prefix}lost-response`, input = { operationId, name };
      const body = JSON.stringify(input);
      const responseStatus = await new Promise<number>(resolveResponse => {
        const request = httpRequest(`${httpOrigin}/api/trpc/organization.createBranch`, { method: 'POST', agent: false,
          headers: { ...bodyFor('POST', 0, input).headers, 'x-fixture-drop-response': runId, 'content-length': Buffer.byteLength(body) } }, response => {
          response.resume(); response.on('end', () => resolveResponse(response.statusCode ?? 0)); response.on('error', () => resolveResponse(0));
        });
        request.setTimeout(15_000, () => request.destroy());
        request.on('error', () => resolveResponse(0)); request.end(body);
      });
      await Promise.allSettled([...pendingTransactions]);
      const retry = await send(0, 'createBranch', input);
      const receipts = await count(sql`SELECT COUNT(*) AS n FROM write_operation_receipts WHERE operation_id=${operationId} AND response_json IS NOT NULL`);
      const branches = await count(sql`SELECT COUNT(*) AS n FROM branches WHERE name=${name}`);
      return { responseStatus, droppedResponses, retryStatus: retry.status, receipts, branches,
        passed: responseStatus === 0 && droppedResponses === 1 && retry.status === 200 && receipts === 1 && branches === 1 };
    });
    await check('two_audit_workers_exactly_once', async () => {
      const targetIds = Array.from({ length: 40 }, () => randomUUID());
      await baseStore.transaction(async tx => {
        for (const eventId of targetIds) await tx.appendAudit({ eventId, occurredAt: new Date(), actorUserId: actors[0].id,
          actorRoleId: adminRole, actorRoleCode: 'system_admin', module: 'organization', action: 'organization.branches.list',
          entityId: null, requestId: randomUUID(), result: 'success', reasonCode: null });
      });
      const targetSql = sql.join(targetIds.map(id => sql`${id}`), sql`, `);
      let delivered = 0, cycles = 0;
      const summaries: unknown[] = [];
      while (delivered < 40 && cycles < 12) {
        summaries.push(await Promise.all(dispatchers.map(worker => worker.runOnce()))); cycles++;
        delivered = await count(sql`SELECT COUNT(*) AS n FROM audit_events WHERE event_id IN (${targetSql})`);
        console.info(`Audit delivery cycle ${cycles}: ${delivered}/40 fixture events`);
      }
      const matched = await count(sql`SELECT COUNT(*) AS n FROM audit_events AS e JOIN audit_outbox AS o ON o.event_id=e.event_id
        WHERE e.event_id IN (${targetSql}) AND o.delivery_state='delivered' AND e.occurred_at=o.occurred_at AND e.action=o.action AND e.result=o.result`);
      return { targetEvents: 40, delivered, matched, cycles, summaries, passed: delivered === 40 && matched === 40 };
    });
    await check('all_run_audit_events_delivered_and_equal', async () => {
      const outbox = await count(sql`SELECT COUNT(*) AS n FROM audit_outbox WHERE actor_user_id IN (${actorSql})`);
      const events = await count(sql`SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id IN (${actorSql})`);
      const unfinished = await count(sql`SELECT COUNT(*) AS n FROM audit_outbox WHERE actor_user_id IN (${actorSql}) AND delivery_state<>'delivered'`);
      const matched = await count(sql`SELECT COUNT(*) AS n FROM audit_outbox AS o JOIN audit_events AS e ON e.event_id=o.event_id
        WHERE o.actor_user_id IN (${actorSql}) AND o.delivery_state='delivered'
        AND e.occurred_at=o.occurred_at AND e.actor_user_id=o.actor_user_id AND (e.actor_role_id<=>o.actor_role_id)
        AND (e.actor_role_code<=>o.actor_role_code) AND e.module=o.module AND e.action=o.action
        AND (e.entity_id<=>o.entity_id) AND (e.entity_version<=>o.entity_version)
        AND e.request_id=o.request_id AND e.result=o.result AND (e.reason_code<=>o.reason_code)
        AND (e.before_values<=>o.before_values) AND (e.after_values<=>o.after_values) AND (e.metadata<=>o.metadata)`);
      return { outbox, events, unfinished, matched, passed: outbox > 0 && events === outbox && matched === outbox && unfinished === 0 };
    });
    await check('select_one_30_samples_ten_concurrent', async () => {
      const durations: number[] = [];
      for (let batch = 0; batch < 3; batch++) {
        await Promise.all(Array.from({ length: 10 }, async () => {
          const started = performance.now();
          const result = await rows(sql`SELECT 1 AS verified_value`);
          assert(Number(result[0]?.verified_value) === 1, 'READ_PROBE_INVALID');
          durations.push(performance.now() - started);
        }));
      }
      return { concurrency: 10, latency: latency(durations), passed: durations.length === 30 };
    });
    await check('real_pool_overflow_expiry_no_late_work_and_recovery', async () => {
      const before = diagnostics();
      assert(before.active === 0 && before.waiting === 0, 'POOL_NOT_IDLE');
      let releaseHolders!: () => void;
      let allEntered!: () => void;
      let entered = 0, expiredCallbacks = 0;
      const releaseBarrier = new Promise<void>(resolveBarrier => { releaseHolders = resolveBarrier; });
      const ready = new Promise<void>(resolveReady => { allEntered = resolveReady; });
      const holders = Array.from({ length: before.connectionLimit }, () => connection.transaction(async () => {
        entered++;
        if (entered === before.connectionLimit) allEntered();
        await releaseBarrier;
      }));
      const settledHolders = Promise.allSettled(holders);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([ready, new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new VerificationFailure('HOLDERS_NOT_READY')), before.acquisitionTimeoutMs * 2 + 2_000);
        })]);
        clearTimeout(timeout);
        const expired = Array.from({ length: before.queueLimit }, () => connection.transaction(async () => { expiredCallbacks++; }))
          .map(task => task.then(() => 'unexpected-success', error => safeFailure(error)));
        const whenFull = diagnostics();
        const overflow = await connection.ping().then(() => 'unexpected-success', error => safeFailure(error));
        const expiredResults = await Promise.all(expired);
        const afterExpiry = diagnostics();
        releaseHolders();
        const released = await settledHolders;
        await connection.ping();
        const afterRecovery = diagnostics();
        return { heldConnections: entered, queued: whenFull.waiting, overflow, expiredResults, expiredCallbacks,
          before, whenFull, afterExpiry, afterRecovery,
          passed: entered === before.connectionLimit && whenFull.waiting === before.queueLimit && overflow === 'DB_BUSY'
            && expiredResults.every(result => result === 'DB_WAIT_TIMEOUT') && expiredCallbacks === 0
            && afterExpiry.waiting === 0 && released.every(result => result.status === 'fulfilled')
            && afterRecovery.active === 0 && afterRecovery.waiting === 0
            && afterRecovery.timedOut - before.timedOut === before.queueLimit && afterRecovery.busy - before.busy === 1 };
      } finally {
        clearTimeout(timeout);
        releaseHolders();
        await settledHolders;
      }
    });
    await check('no_incomplete_receipts', async () => {
      const incomplete = await count(sql`SELECT COUNT(*) AS n FROM write_operation_receipts WHERE actor_user_id IN (${actorSql}) AND response_json IS NULL`);
      return { incomplete, passed: incomplete === 0 };
    });
    report.timings = { transactionsIncludingAdmission: latency(transactionTimings), authorizationStoreCalls: latency(phaseTimings.authorizationMs),
      businessStoreCalls: latency(phaseTimings.businessMs), auditStoreCalls: latency(phaseTimings.auditMs),
      note: 'Store timings include network and row locks. Grouped per-call samples do not isolate TiDB CPU or pure lock wait.' };
    report.finalDiagnosticsBeforeCleanup = diagnostics();
  } catch (error) { report.fatal = safeFailure(error); }
  finally {
    for (const worker of dispatchers) await worker.stop();
    if (listener?.listening) { const stopped = once(listener, 'close'); listener.close(); listener.closeIdleConnections(); await stopped; }
    await Promise.allSettled([...pendingTransactions]);
    if (fixtureCommitConfirmed) {
      try {
        await connection.transaction(async tx => {
          await tx.execute(sql`DELETE FROM audit_events WHERE actor_user_id IN (${actorSql})`);
          await tx.execute(sql`DELETE FROM audit_outbox WHERE actor_user_id IN (${actorSql})`);
          await tx.execute(sql`DELETE FROM write_operation_receipts WHERE actor_user_id IN (${actorSql})`);
          await tx.execute(sql`DELETE FROM sessions WHERE user_id IN (${actorSql})`);
          await tx.execute(sql`DELETE FROM user_permission_overrides WHERE user_id IN (${actorSql})`);
          await tx.execute(sql`DELETE FROM departments WHERE name LIKE ${prefix + '%'}`);
          await tx.execute(sql`DELETE FROM branches WHERE name LIKE ${prefix + '%'}`);
          await tx.execute(sql`DELETE FROM users WHERE id IN (${actorSql})`);
          await tx.execute(sql`DELETE FROM role_permissions WHERE role_id IN (${roleSql})`);
          await tx.execute(sql`DELETE FROM roles WHERE id IN (${roleSql})`);
          await tx.execute(sql`DELETE FROM permissions WHERE code IN (${sql.join(grants.map(code => sql`${code}`), sql`, `)})`);
        });
        const finalInventory = await inventory();
        report.cleanup = { ...finalInventory, passed: Object.values(finalInventory.counts).every(value => value === 0)
          && finalInventory.indexes === 42 && finalInventory.foreignKeys === 13 };
      } catch (error) { report.cleanup = { passed: false, failure: safeFailure(error) }; }
    } else report.cleanup = { fixtureCommitConfirmed: false, performed: false,
      note: 'No cleanup without confirmed fixture ownership. Inspect run IDs if the seed commit outcome was uncertain.' };
    await connection.close();
    report.connectionClosed = true;
  }
}

try { await main(); }
catch (error) { report.fatal = safeFailure(error); }
report.finishedAt = new Date().toISOString();
report.status = !report.fatal && cases.length > 0 && cases.every(item => item.passed)
  && (report.cleanup as { passed?: boolean } | undefined)?.passed === true ? 'passed' : 'failed';
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
console.info(JSON.stringify({ status: report.status, cases: cases.length, passed: cases.filter(item => item.passed).length,
  cleanupPassed: (report.cleanup as { passed?: boolean } | undefined)?.passed === true }));
if (report.status !== 'passed') process.exitCode = 1;
