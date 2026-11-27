/** Explicit verification on the dedicated, empty madartest database only. No DDL. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createApp } from '../server/app.ts';
import { hashPassword } from '../server/core/auth/password.ts';
import { openDatabase } from '../server/core/database/connection.ts';
import { createAuditStore } from '../server/core/audit/repository.ts';
import { createNumberingSettingsStore } from '../server/core/numbering/repository.ts';
import { createAuthStore, sqlUtc } from '../server/modules/auth/repository.ts';
import type { AuthTransaction } from '../server/modules/auth/store.ts';
import { createOrganizationStore } from '../server/modules/organization/repository.ts';
import { createUsersStore } from '../server/modules/users/repository.ts';
import { createPermissionOverridesStore } from '../server/modules/permission-overrides/repository.ts';
import { initialRolePermissions, permissionCodes } from '../shared/permissions/catalog.ts';

const tableNames = ['audit_events', 'audit_outbox', 'auth_throttles', 'branches', 'departments', 'employees',
  'numbering_counters', 'numbering_issuances', 'numbering_series', 'permissions', 'role_permissions', 'roles',
  'sessions', 'user_permission_overrides', 'users', 'write_operation_receipts'] as const;
const expectedMigrations = [
  { hash: '28613c7d87709947e45105ac0489c2ff99d1e5beae4009dca9cb7b0c3f4541c8', created_at: 1795360011508 },
  { hash: '0c6666805e703a5b659f642ae1b1fc1bc294f68b36aa77b58e20e171ce70b927', created_at: 1795605194621 },
];
const runId = randomUUID();
const prefix = `QaM307-${runId}-`;
const outputPath = resolve(process.argv[2] ?? 'docs/FOUNDATION_INTEGRATION_RESULTS.json');
const secrets = new Set<string>();
const cases: { name: string; passed: boolean; [key: string]: unknown }[] = [];
const report: Record<string, unknown> = { runId, startedAt: new Date().toISOString(), environment: {
  database: 'madartest', actualHttpServer: 'localhost', node: process.version, timingsIncludeRemoteNetwork: true,
  productionDatabaseTouched: false, schemaChanges: false, globalSettingsChanged: false,
  connectionSourceSha256: createHash('sha256').update(await readFile(new URL('../server/core/database/connection.ts', import.meta.url))).digest('hex'),
}, cases, limits: [
  'Representative integration cases, not every users/permissions/numbering mutation or failure combination.',
  'Concurrent HTTP requests use separate admin sessions but share role locks; overlapping INSERT execution is not claimed.',
  'No numbering issuance engine, physical-device test, Railway benchmark or production write is performed.',
] };
class VerificationFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
function assert(condition: unknown, code: string): asserts condition { if (!condition) throw new VerificationFailure(code); }
function safeFailure(error: unknown) {
  if (error instanceof VerificationFailure) return error.code;
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const value = current as { reason?: unknown; code?: unknown; cause?: unknown };
    for (const code of [value.reason, value.code]) {
      if (typeof code === 'string' && /^(?:DB_|AUTH_|USERS_|OVERRIDES_|NUMBERING_)[A-Z_]+$/.test(code)) return code;
    }
    current = value.cause;
  }
  return 'VERIFICATION_FAILURE';
}
const rounded = (value: number) => Math.round(value * 1000) / 1000;
async function check(name: string, work: () => Promise<Record<string, unknown>>) {
  console.info(`Verifying ${name}`);
  const start = performance.now();
  try { cases.push({ name, passed: true, ...await work(), elapsedMs: rounded(performance.now() - start) }); }
  catch (error) { cases.push({ name, passed: false, failure: safeFailure(error), elapsedMs: rounded(performance.now() - start) }); }
}

async function main() {
  const connectionString = process.env.MADAR_TEST_DATABASE_URL;
  assert(connectionString, 'MISSING_TEST_DATABASE_URL');
  const url = new URL(connectionString);
  assert(url.protocol === 'mysql:' && decodeURIComponent(url.pathname) === '/madartest', 'TEST_DATABASE_ONLY');
  const connection = openDatabase(connectionString, process.env.MADAR_TEST_DATABASE_TLS_CA_PEM);
  type Query = Parameters<typeof connection.db.execute>[0];
  const rows = async (query: Query) => (await connection.db.execute(query))[0] as unknown as Record<string, unknown>[];
  const count = async (query: Query) => Number((await rows(query))[0]?.n ?? 0);
  const idsSql = (ids: Iterable<string>) => sql.join([...ids].map(id => sql`${id}`), sql`, `);
  async function inventory() {
    const database = (await rows(sql`SELECT DATABASE() AS database_name`))[0]?.database_name;
    assert(database === 'madartest', 'DATABASE_GUARD');
    const tables = await rows(sql`SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA='madartest' AND TABLE_TYPE='BASE TABLE'`);
    assert(tables.length === 17 && tables.every(row => [...tableNames, '__drizzle_migrations'].includes(row.table_name as never)), 'SCHEMA_TABLE_MISMATCH');
    const counts: Record<string, number> = {};
    for (const table of tableNames) counts[table] = await count(sql.raw(`SELECT COUNT(*) AS n FROM \`madartest\`.\`${table}\``));
    const migrations = (await rows(sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at`))
      .map(row => ({ hash: row.hash, created_at: Number(row.created_at) }));
    assert(JSON.stringify(migrations) === JSON.stringify(expectedMigrations), 'MIGRATION_MISMATCH');
    const indexes = await count(sql`SELECT COUNT(*) AS n FROM (SELECT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='madartest' AND TABLE_NAME<>'__drizzle_migrations' GROUP BY TABLE_NAME, INDEX_NAME) AS index_names`);
    const foreignKeys = await count(sql`SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='madartest' AND CONSTRAINT_TYPE='FOREIGN KEY'`);
    return { database, counts, migrations, indexes, foreignKeys };
  }

  const adminRole = randomUUID(), hrRole = randomUUID();
  const adminIds = [randomUUID(), randomUUID()];
  const adminNames = [`${prefix}A`, `${prefix}B`];
  const userIds = new Set<string>(adminIds);
  const sessionIds = new Set<string>();
  const throttleKeys = new Set<string>();
  const eventIds = new Set<string>();
  const seriesIds = new Set<string>();
  const branchIds = new Set<string>();
  const departmentIds = new Set<string>();
  const pendingTransactions = new Set<Promise<unknown>>();
  const password = randomBytes(24).toString('base64url');
  const newPassword = randomBytes(24).toString('base64url');
  const secret = randomBytes(48).toString('base64url');
  for (const value of [password, newPassword, secret]) secrets.add(value);
  const configuredOrigin = 'http://127.0.0.1:3000';
  let fixtureCommitConfirmed = false;
  let httpOutcomeUncertain = false;
  let listener: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
  let origin = '';

  /** Capture generated IDs only for exact fixture cleanup; SQL and results are unchanged. */
  function track<T extends AuthTransaction>(transaction: T): T {
    return new Proxy(transaction, { get(target, key, receiver) {
      const original = Reflect.get(target, key, receiver);
      if (typeof original !== 'function') return original;
      return (...args: unknown[]) => {
        const value = args[0] as { id?: string; eventId?: string } | undefined;
        if (key === 'insertSession' && value?.id) sessionIds.add(value.id);
        if (key === 'insertUser' && value?.id) userIds.add(value.id);
        if (key === 'appendAudit' && value?.eventId) eventIds.add(value.eventId);
        if (key === 'insertSeries' && value?.id) seriesIds.add(value.id);
        if (key === 'insertBranch' && value?.id) branchIds.add(value.id);
        if (key === 'insertDepartment' && value?.id) departmentIds.add(value.id);
        if (key === 'consumeThrottle') for (const key of args[0] as Buffer[]) throttleKeys.add(key.toString('hex'));
        return Reflect.apply(original, target, args);
      };
    } });
  }
  function pending<T>(task: Promise<T>): Promise<T> {
    pendingTransactions.add(task);
    void task.finally(() => pendingTransactions.delete(task)).catch(() => {});
    return task;
  }
  const authStore = createAuthStore(connection), usersStore = createUsersStore(connection);
  const permissionStore = createPermissionOverridesStore(connection), organizationStore = createOrganizationStore(connection);
  const numberingStore = createNumberingSettingsStore(connection), auditStore = createAuditStore(connection);

  type Snapshot = { cookie: string; csrf: string };
  type ApiResult = { status: number; code?: string; data?: any; noStore: boolean; location: boolean; elapsedMs: number };
  async function send(snapshot: Snapshot, path: string, input?: unknown, mutation = false): Promise<ApiResult & { nextCookie?: string }> {
    const start = performance.now();
    let response: Response;
    let body: any;
    try {
      response = await fetch(`${origin}/api/trpc/${path}${!mutation && input !== undefined ? '?input=' + encodeURIComponent(JSON.stringify(input)) : ''}`, {
        method: mutation ? 'POST' : 'GET', headers: { cookie: snapshot.cookie, origin: configuredOrigin,
          ...(mutation ? { 'content-type': 'application/json', 'x-madar-csrf': snapshot.csrf } : {}) },
        ...(mutation ? { body: JSON.stringify(input ?? {}) } : {}), redirect: 'manual', signal: AbortSignal.timeout(15_000),
      });
      body = await response.json();
    } catch {
      httpOutcomeUncertain = true;
      throw new VerificationFailure('HTTP_OUTCOME_UNCERTAIN');
    }
    if (body.error) {
      const serialized = JSON.stringify(body);
      assert(!/passwordHash|scrypt\$|tokenHash|insert into|ER_DUP_ENTRY/i.test(serialized), 'ERROR_DETAILS_EXPOSED');
      assert(![...secrets].some(value => value.length > 0 && serialized.includes(value)), 'ERROR_SECRET_EXPOSED');
    }
    const nextCookie = response.headers.get('set-cookie')?.split(';')[0];
    if (nextCookie) { secrets.add(nextCookie); secrets.add(nextCookie.slice(nextCookie.indexOf('=') + 1)); }
    if (typeof body.result?.data?.csrfToken === 'string') secrets.add(body.result.data.csrfToken);
    return { status: response.status, code: body.error?.message, data: body.result?.data, nextCookie,
      noStore: response.headers.get('cache-control') === 'no-store', location: response.headers.has('location'), elapsedMs: rounded(performance.now() - start) };
  }
  function client() {
    let snapshot: Snapshot = { cookie: '', csrf: '' };
    async function request(path: string, input?: unknown, mutation = false) {
      const result = await send(snapshot, path, input, mutation);
      if (result.nextCookie) snapshot = { ...snapshot, cookie: result.nextCookie };
      if (typeof result.data?.csrfToken === 'string') snapshot = { ...snapshot, csrf: result.data.csrfToken };
      return result;
    }
    return { query: (path: string, input?: unknown) => request(path, input),
      mutate: (path: string, input?: unknown) => request(path, input, true), snapshot: () => ({ ...snapshot }) };
  }
  async function login(name: string, currentPassword: string) {
    const api = client();
    assert((await api.query('auth.session')).status === 200, 'PREAUTH_FAILED');
    const result = await api.mutate('auth.login', { username: name, password: currentPassword });
    assert(result.status === 200, 'LOGIN_FAILED');
    return { api, result };
  }
  const auditWindow = () => ({ from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString() });
  const readers = () => [['users.list', {}], ['permissionOverrides.list', {}], ['organization.listBranches', {}],
    ['numberingSettings.list', {}], ['audit.list', auditWindow()]] as const;
  async function revokedResults(snapshot: Snapshot) {
    const results = [];
    for (const [path, input] of readers()) {
      const result = await send(snapshot, path, input);
      results.push({ path, status: result.status, code: result.code, noStore: result.noStore, location: result.location, hasData: result.data !== undefined });
    }
    return results;
  }

  try {
    const tls = await rows(sql`SHOW STATUS LIKE 'Ssl_cipher'`);
    assert(tls.some(row => typeof row.Value === 'string' && row.Value.length > 0), 'TLS_REQUIRED');
    const preflight = await inventory(); report.preflight = { ...preflight, tls: true };
    assert(Object.values(preflight.counts).every(value => value === 0), 'TEST_DATABASE_NOT_EMPTY');
    assert(preflight.indexes === 42 && preflight.foreignKeys === 13, 'SCHEMA_KEYS_MISMATCH');
    const passwordHash = await hashPassword(password); secrets.add(passwordHash);
    const now = sqlUtc(new Date());
    await connection.transaction(async transaction => {
      await transaction.execute(sql`INSERT INTO roles(id,code,name,version,created_at,updated_at) VALUES
        (${adminRole},'system_admin',${prefix + 'admin'},1,${now},${now}),(${hrRole},'hr',${prefix + 'hr'},1,${now},${now})`);
      for (const code of permissionCodes) await transaction.execute(sql`INSERT INTO permissions(code) VALUES(${code})`);
      for (const [roleId, codes] of [[adminRole, initialRolePermissions.system_admin], [hrRole, initialRolePermissions.hr]] as const) {
        for (const code of codes) await transaction.execute(sql`INSERT INTO role_permissions(role_id,permission_code) VALUES(${roleId},${code})`);
      }
      for (let i = 0; i < adminIds.length; i++) await transaction.execute(sql`INSERT INTO users(id,username,password_hash,role_id,account_status,must_change_password,auth_version,created_at,updated_at)
        VALUES(${adminIds[i]},${adminNames[i]},${passwordHash},${adminRole},'active',false,1,${now},${now})`);
    });
    fixtureCommitConfirmed = true;
    const app = createApp({ pingDatabase: connection.ping, authConfig: { origin: configuredOrigin, secret },
      authStore: { transaction: work => pending(authStore.transaction(transaction => work(track(transaction)))) },
      usersStore: { transaction: work => pending(usersStore.transaction(transaction => work(track(transaction)))) },
      permissionOverridesStore: { transaction: work => pending(permissionStore.transaction(transaction => work(track(transaction)))) },
      organizationStore: { transaction: work => pending(organizationStore.transaction(transaction => work(track(transaction)))) },
      numberingSettingsStore: { transaction: work => pending(numberingStore.transaction(transaction => work(track(transaction)))) },
      auditStore: { transaction: work => pending(auditStore.transaction(transaction => work(track(transaction)))) },
    });
    listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const address = listener.address(); assert(address && typeof address !== 'string', 'LISTENER_MISSING');
    origin = `http://127.0.0.1:${address.port}`;
    report.configuration = connection.diagnostics();
    const adminA = await login(adminNames[0], password), adminB = await login(adminNames[1], password);
    assert(adminA.result.data?.state === 'authenticated' && adminB.result.data?.state === 'authenticated', 'ADMIN_SESSION_FAILED');
    let hr: ReturnType<typeof client> | undefined;
    let hrId: string | undefined;
    let targetVersion = 0;
    let series: { id: string; prefix: string; version: number } | undefined;

    await check('actual_login_create_user_and_temporary_password_change', async () => {
      const created = await adminA.api.mutate('users.create', { username: `${prefix}HR`, roleId: hrRole, currentPassword: password });
      assert(created.status === 200 && created.data?.user?.mustChangePassword === true, 'USER_CREATE_FAILED');
      const temporary: unknown = created.data?.temporaryPassword;
      assert(typeof temporary === 'string' && temporary.length >= 15, 'TEMPORARY_PASSWORD_MISSING'); secrets.add(temporary);
      hrId = created.data.user.id;
      assert(typeof hrId === 'string' && userIds.has(hrId), 'CREATED_USER_OWNERSHIP');
      const target = await login(`${prefix}HR`, temporary); hr = target.api;
      assert(target.result.data?.state === 'password_change', 'TEMPORARY_CHANGE_NOT_REQUIRED');
      const protectedBefore = await hr.query('organization.listBranches', {});
      const changed = await hr.mutate('auth.changePassword', { currentPassword: temporary, newPassword });
      assert(protectedBefore.status === 401 && changed.status === 200 && changed.data?.state === 'authenticated', 'PASSWORD_CHANGE_FAILED');
      const organization = await hr.query('organization.listBranches', {}), users = await hr.query('users.list', {});
      const detail = await adminA.api.query('permissionOverrides.detail', { userId: hrId });
      targetVersion = detail.data?.user?.authVersion;
      assert(organization.status === 200 && users.status === 403 && Number.isSafeInteger(targetVersion), 'INITIAL_HR_AUTHORIZATION_FAILED');
      return { loginStatus: target.result.status, requiredState: target.result.data.state, protectedBefore: protectedBefore.status,
        changeStatus: changed.status, organizationStatus: organization.status, usersStatus: users.status, targetAuthVersion: targetVersion,
        passed: true };
    });
    await check('permission_override_revokes_session_and_next_login_enforces_grant_and_deny', async () => {
      assert(hr && hrId && targetVersion > 0, 'USER_CASE_DEPENDENCY');
      const previous = hr.snapshot();
      const saved = await adminA.api.mutate('permissionOverrides.save', { userId: hrId, expectedAuthVersion: targetVersion,
        currentPassword: password, overrides: [{ permissionCode: 'organization.read', effect: 'deny' },
          { permissionCode: 'settings.manage', effect: 'grant' }, { permissionCode: 'audit.read', effect: 'grant' }] });
      assert(saved.status === 200 && saved.data?.changed === true && saved.data?.detail?.user?.authVersion === targetVersion + 1, 'OVERRIDE_SAVE_FAILED');
      const oldSession = await revokedResults(previous);
      assert(oldSession.every(value => value.status === 401 && value.code === 'AUTH_REQUIRED' && !value.hasData && !value.location && value.noStore), 'OLD_SESSION_STILL_AUTHORIZED');
      const fresh = await login(`${prefix}HR`, newPassword); hr = fresh.api;
      const permissions = fresh.result.data?.user?.permissions as string[] | undefined;
      const organization = await hr.query('organization.listBranches', {}), numbering = await hr.query('numberingSettings.list', {}), audit = await hr.query('audit.list', auditWindow());
      assert(permissions && !permissions.includes('organization.read') && permissions.includes('settings.manage') && permissions.includes('audit.read'), 'EFFECTIVE_PERMISSIONS_FAILED');
      assert(organization.status === 403 && numbering.status === 200 && audit.status === 200, 'OVERRIDE_BOUNDARIES_FAILED');
      return { saveStatus: saved.status, targetAuthVersion: saved.data.detail.user.authVersion, oldSession,
        freshLoginStatus: fresh.result.status, organizationStatus: organization.status, numberingStatus: numbering.status, auditStatus: audit.status, passed: true };
    });
    await check('concurrent_numbering_duplicate_prefix_has_one_committed_series', async () => {
      const results = await Promise.all([adminA.api, adminB.api].map((api, index) => api.mutate('numberingSettings.create', {
        code: `QaM307_${runId}_${index}`, prefix: 'Qaz', resetPolicy: 'annual', enabled: true })));
      const winners = results.filter(value => value.status === 200), losers = results.filter(value => value.status === 409 && value.code === 'NUMBERING_DUPLICATE_PREFIX');
      assert(winners.length === 1 && losers.length === 1, 'NUMBERING_UNIQUENESS_FAILED');
      series = winners[0].data.series;
      assert(series && seriesIds.has(series.id), 'SERIES_OWNERSHIP');
      const persisted = await count(sql`SELECT COUNT(*) AS n FROM numbering_series WHERE prefix='Qaz'`);
      assert(persisted === 1, 'DUPLICATE_SERIES_COMMITTED');
      return { statuses: results.map(value => value.status), reasons: results.filter(value => value.code).map(value => value.code), persisted,
        latencyMs: results.map(value => value.elapsedMs), concurrency: 2, passed: true };
    });
    await check('concurrent_numbering_update_same_version_has_one_winner', async () => {
      assert(series, 'SERIES_CASE_DEPENDENCY');
      const initial = series;
      const results = await Promise.all([adminA.api.mutate('numberingSettings.update', { seriesId: initial.id, expectedVersion: 1,
        prefix: initial.prefix, resetPolicy: 'annual', enabled: false }), adminB.api.mutate('numberingSettings.update', {
        seriesId: initial.id, expectedVersion: 1, prefix: initial.prefix, resetPolicy: 'continuous', enabled: true })]);
      const version = Number((await rows(sql`SELECT version FROM numbering_series WHERE id=${initial.id}`))[0]?.version);
      assert(results.filter(value => value.status === 200).length === 1
        && results.filter(value => value.status === 409 && value.code === 'NUMBERING_CONFLICT').length === 1 && version === 2, 'NUMBERING_VERSION_CONFLICT_FAILED');
      return { statuses: results.map(value => value.status), reasons: results.filter(value => value.code).map(value => value.code),
        version, concurrency: 2, latencyMs: results.map(value => value.elapsedMs), passed: true };
    });
    await check('logout_old_cookie_denied_across_all_readers_and_organization_write', async () => {
      const old = adminA.api.snapshot();
      const exited = await adminA.api.mutate('auth.logout');
      assert(exited.status === 200 && exited.data?.state === 'anonymous' && adminA.api.snapshot().cookie !== old.cookie, 'LOGOUT_FAILED');
      const oldSession = await revokedResults(old);
      const operationId = randomUUID();
      const rejectedWrite = await send(old, 'organization.createBranch', { operationId, name: `${prefix}denied` }, true);
      const receipts = await count(sql`SELECT COUNT(*) AS n FROM write_operation_receipts WHERE operation_id=${operationId}`);
      const branches = await count(sql`SELECT COUNT(*) AS n FROM branches WHERE name=${prefix + 'denied'}`);
      assert(oldSession.every(value => value.status === 401 && value.code === 'AUTH_REQUIRED' && value.noStore && !value.location && !value.hasData)
        && rejectedWrite.status === 401 && rejectedWrite.code === 'AUTH_REQUIRED' && receipts === 0 && branches === 0, 'LOGGED_OUT_ACCESS_REUSED');
      assert((await adminB.api.query('users.list', {})).status === 200, 'OTHER_ADMIN_SESSION_REVOKED');
      return { logoutStatus: exited.status, cookieRotated: true, oldSession, writeStatus: rejectedWrite.status, receipts, branches, otherAdminStatus: 200, passed: true };
    });
    await check('audit_remains_secret_free_and_no_number_was_issued', async () => {
      assert(eventIds.size > 0, 'AUDIT_NOT_CAPTURED');
      const events = await rows(sql`SELECT event_id, module, action, result, before_values, after_values, metadata FROM audit_outbox WHERE event_id IN (${idsSql(eventIds)})`);
      const serialized = JSON.stringify(events);
      assert(!/passwordHash|scrypt\$|tokenHash|temporaryPassword|currentPassword|csrfToken/i.test(serialized), 'AUDIT_SECRET_FIELD');
      assert(![...secrets].some(value => value.length > 0 && serialized.includes(value)), 'AUDIT_SECRET_VALUE');
      const counters = await count(sql`SELECT COUNT(*) AS n FROM numbering_counters`), issuances = await count(sql`SELECT COUNT(*) AS n FROM numbering_issuances`);
      assert(counters === 0 && issuances === 0, 'NUMBERING_ENGINE_EXECUTED');
      return { auditEvents: events.length, counters, issuances, secretsAbsent: true, passed: true };
    });
    report.finalDiagnosticsBeforeCleanup = connection.diagnostics();
  } catch (error) { report.fatal = safeFailure(error); }
  finally {
    if (listener?.listening) { const closed = once(listener, 'close'); listener.close(); listener.closeIdleConnections(); await closed; }
    await Promise.allSettled([...pendingTransactions]);
    if (fixtureCommitConfirmed && !httpOutcomeUncertain) {
      try {
        await connection.transaction(async transaction => {
          if (eventIds.size) {
            await transaction.execute(sql`DELETE FROM audit_events WHERE event_id IN (${idsSql(eventIds)})`);
            await transaction.execute(sql`DELETE FROM audit_outbox WHERE event_id IN (${idsSql(eventIds)})`);
          }
          await transaction.execute(sql`DELETE FROM write_operation_receipts WHERE actor_user_id IN (${idsSql(userIds)})`);
          if (sessionIds.size) await transaction.execute(sql`DELETE FROM sessions WHERE id IN (${idsSql(sessionIds)})`);
          await transaction.execute(sql`DELETE FROM sessions WHERE user_id IN (${idsSql(userIds)})`);
          if (throttleKeys.size) await transaction.execute(sql`DELETE FROM auth_throttles WHERE counter_key IN (${sql.join([...throttleKeys].map(key => sql`${Buffer.from(key, 'hex')}`), sql`, `)})`);
          await transaction.execute(sql`DELETE FROM user_permission_overrides WHERE user_id IN (${idsSql(userIds)})`);
          if (seriesIds.size) await transaction.execute(sql`DELETE FROM numbering_series WHERE id IN (${idsSql(seriesIds)})`);
          if (departmentIds.size) await transaction.execute(sql`DELETE FROM departments WHERE id IN (${idsSql(departmentIds)})`);
          if (branchIds.size) await transaction.execute(sql`DELETE FROM branches WHERE id IN (${idsSql(branchIds)})`);
          await transaction.execute(sql`DELETE FROM users WHERE id IN (${idsSql(userIds)})`);
          await transaction.execute(sql`DELETE FROM role_permissions WHERE role_id IN (${idsSql([adminRole, hrRole])})`);
          await transaction.execute(sql`DELETE FROM roles WHERE id IN (${idsSql([adminRole, hrRole])})`);
          await transaction.execute(sql`DELETE FROM permissions WHERE code IN (${idsSql(permissionCodes)})`);
        });
        const finalInventory = await inventory();
        report.cleanup = { ...finalInventory, passed: Object.values(finalInventory.counts).every(value => value === 0)
          && finalInventory.indexes === 42 && finalInventory.foreignKeys === 13 };
      } catch (error) { report.cleanup = { passed: false, failure: safeFailure(error) }; }
    } else report.cleanup = { performed: false, fixtureCommitConfirmed, httpOutcomeUncertain,
      note: 'No cleanup without confirmed seed ownership or after an uncertain HTTP outcome. Inspect own run IDs before cleanup.' };
    await connection.close(); report.connectionClosed = true;
  }
}

try { await main(); } catch (error) { report.fatal = safeFailure(error); }
report.finishedAt = new Date().toISOString();
report.status = !report.fatal && cases.length === 6 && cases.every(value => value.passed)
  && (report.cleanup as { passed?: boolean } | undefined)?.passed === true ? 'passed' : 'failed';
const serialized = JSON.stringify(report, null, 2) + '\n';
assert(![...secrets].some(value => value.length > 0 && serialized.includes(value)), 'REPORT_SECRET_VALUE');
await writeFile(outputPath, serialized, { encoding: 'utf8', mode: 0o600 });
console.info(JSON.stringify({ status: report.status, cases: cases.length, passed: cases.filter(value => value.passed).length,
  cleanupPassed: (report.cleanup as { passed?: boolean } | undefined)?.passed === true }));
if (report.status !== 'passed') process.exitCode = 1;
