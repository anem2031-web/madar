import { randomUUID } from 'node:crypto';
import { numberingFormat, numberingPaddingWidth } from '../../../shared/numbering/settings.ts';
import type { CreateNumberingSeries, UpdateNumberingSeries } from '../../../shared/numbering/settings.ts';
import { AuthFault } from '../../modules/auth/errors.ts';
import type { AuthRequest, AuthService } from '../../modules/auth/service.ts';
import type { AuthAudit, AuthUser } from '../../modules/auth/store.ts';
import { NumberingFault, numberingDuplicateReason } from './errors.ts';
import { calendarYearInRiyadh } from './formatter.ts';
import type { NumberingSeriesRecord, NumberingSettingsStore, NumberingSettingsTransaction } from './store.ts';
import { createInput, listInput, updateInput, validateNewPrefix } from './validation.ts';

type Options = { now?: () => Date };
const maximumVersion = 4_294_967_295;

export function createNumberingSettingsService(store: NumberingSettingsStore, auth: AuthService, options: Options = {}) {
  const clock = options.now ?? (() => new Date());
  function audit(request: AuthRequest, action: string, actor: AuthUser | null, result: 'success' | 'denied',
    entityId: string | null = null, reasonCode: string | null = null): AuthAudit {
    return { eventId: randomUUID(), occurredAt: clock(), actorUserId: actor?.id ?? null,
      actorRoleId: actor?.roleId ?? null, actorRoleCode: actor?.roleCode ?? null,
      module: 'numbering', action, entityId, requestId: request.requestId, result, reasonCode };
  }
  async function guarded<T>(request: AuthRequest, action: string,
    work: (tx: NumberingSettingsTransaction, actor: AuthUser) => Promise<T>, entityId: string | null = null): Promise<T> {
    const execute = (operation: typeof work) => store.transaction(async tx => {
      let actor: AuthUser | null = null;
      try {
        actor = (await auth.authorizeInTransaction(tx, request, 'settings.manage', clock(), current => { actor = current; })).user;
        return { value: await operation(tx, actor) };
      } catch (error) {
        if (!(error instanceof AuthFault || error instanceof NumberingFault)) throw error;
        await tx.appendAudit(audit(request, action, actor, 'denied', entityId, error.reason));
        return { error };
      }
    });
    let outcome;
    try { outcome = await execute(work); }
    catch (error) {
      const duplicate = numberingDuplicateReason(error);
      if (!duplicate) throw error;
      // The failed write is rolled back before a separate, freshly authorized denial is recorded.
      outcome = await execute(async () => { throw new NumberingFault(duplicate); });
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  const values = (row: NumberingSeriesRecord) => ({ code: row.code, prefix: row.prefix, format: row.format,
    paddingWidth: row.paddingWidth, resetPolicy: row.resetPolicy, enabled: row.enabled, version: row.version });

  async function list(request: AuthRequest, input: { cursor?: string } = {}) {
    const parsed = listInput(input);
    return guarded(request, 'numbering.series.list', async (tx, actor) => {
      const rows = await tx.listSeries(parsed.cursor, 26);
      const page = rows.slice(0, 25);
      await tx.appendAudit({ ...audit(request, 'numbering.series.list', actor, 'success'), metadata: { count: page.length } });
      return { series: page, calendarYear: calendarYearInRiyadh(clock()), ...(rows.length > 25 ? { nextCursor: page.at(-1)!.id } : {}) };
    });
  }
  async function create(request: AuthRequest, input: CreateNumberingSeries) {
    const parsed = createInput(input);
    await auth.checkMutation(request);
    return guarded(request, 'numbering.series.create', async (tx, actor) => {
      const series: NumberingSeriesRecord = { id: randomUUID(), ...parsed, format: numberingFormat, paddingWidth: numberingPaddingWidth, version: 1 };
      await tx.insertSeries(series, actor.id, clock());
      await tx.appendAudit({ ...audit(request, 'numbering.series.create', actor, 'success', series.id), entityVersion: series.version, afterValues: values(series) });
      return { series: { ...series, hasIssued: false } };
    });
  }
  async function update(request: AuthRequest, input: UpdateNumberingSeries) {
    const parsed = updateInput(input);
    await auth.checkMutation(request);
    return guarded(request, 'numbering.series.update', async (tx, actor) => {
      const before = await tx.getSeries(parsed.seriesId);
      if (!before) throw new NumberingFault('NUMBERING_NOT_FOUND');
      const hasIssued = await tx.hasIssuances(before.id);
      const configurationChanged = before.prefix !== parsed.prefix || before.resetPolicy !== parsed.resetPolicy;
      const changed = configurationChanged || before.enabled !== parsed.enabled;
      if (before.version !== parsed.expectedVersion || (changed && before.version >= maximumVersion)) throw new NumberingFault('NUMBERING_CONFLICT');
      if (hasIssued && configurationChanged) throw new NumberingFault('NUMBERING_LOCKED');
      if (before.prefix !== parsed.prefix) validateNewPrefix(parsed.prefix);
      const changes = { prefix: parsed.prefix, resetPolicy: parsed.resetPolicy, enabled: parsed.enabled };
      if (changed && !await tx.updateSeries(before.id, before.version, changes, actor.id, clock())) throw new NumberingFault('NUMBERING_CONFLICT');
      const after = { ...before, ...changes, version: before.version + Number(changed) };
      await tx.appendAudit({ ...audit(request, 'numbering.series.update', actor, 'success', before.id), entityVersion: after.version,
        beforeValues: values(before), afterValues: values(after), metadata: { changed } });
      return { series: { ...after, hasIssued }, changed };
    }, parsed.seriesId);
  }
  return { list, create, update };
}

export type NumberingSettingsService = ReturnType<typeof createNumberingSettingsService>;
