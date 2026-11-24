import type { AuditListInput, AuditModule, AuditResult } from '../../../../shared/audit/contracts.ts';
import type { Language } from '../../i18n/locale.ts';

export type AuditFilters = Omit<AuditListInput, 'cursor'>;
export type AuditFilterDraft = { from: string; to: string; actorUserId: string; module: AuditModule | ''; result: AuditResult | '' };
export const isIdentifier = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const dayMs = 86_400_000;
const riyadhOffsetMs = 3 * 60 * 60_000;
const localValue = (milliseconds: number) => new Date(milliseconds + riyadhOffsetMs).toISOString().slice(0, 19);
export function defaultAuditDraft(now = Date.now()): AuditFilterDraft {
  const end = Math.floor(now / 1000) * 1000;
  return { from: localValue(end - 7 * dayMs), to: localValue(end), actorUserId: '', module: '', result: '' };
}
function parseLocal(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const canonical = value.length === 16 ? `${value}:00` : value;
  const milliseconds = Date.parse(`${canonical}+03:00`);
  return Number.isFinite(milliseconds) && localValue(milliseconds) === canonical ? milliseconds : null;
}
export function normalizeAuditFilters(draft: AuditFilterDraft): { filters: AuditFilters } | { error: 'invalidPeriod' | 'invalidIdentifier' } {
  const from = parseLocal(draft.from), to = parseLocal(draft.to);
  if (from === null || to === null || to <= from || to - from > 31 * dayMs) return { error: 'invalidPeriod' };
  const actorUserId = draft.actorUserId.trim();
  if (actorUserId && !isIdentifier(actorUserId)) return { error: 'invalidIdentifier' };
  return { filters: { from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    ...(actorUserId ? { actorUserId: actorUserId.toLowerCase() } : {}),
    ...(draft.module ? { module: draft.module } : {}), ...(draft.result ? { result: draft.result } : {}) } };
}
export function readAuditSubmission(values: Pick<FormData, 'get'>, draft: AuditFilterDraft, current: AuditFilters, rolling: boolean, customPeriod: boolean):
  { draft: AuditFilterDraft; error: 'invalidPeriod' | 'invalidIdentifier' } | { draft: AuditFilterDraft; filters: AuditFilters; rolling: boolean } {
  const field = (name: string, fallback: string) => { const value = values.get(name); return typeof value === 'string' ? value : fallback; };
  const submitted = { ...draft, from: field('from', draft.from), to: field('to', draft.to), actorUserId: field('actor', draft.actorUserId) };
  const normalized = normalizeAuditFilters(submitted);
  if ('error' in normalized) return { draft: submitted, error: normalized.error };
  const unchangedPeriod = normalized.filters.from === current.from && normalized.filters.to === current.to;
  return { draft: submitted, filters: normalized.filters, rolling: rolling && !customPeriod && unchangedPeriod };
}
export function auditDraftFromFilters(filters: AuditFilters): AuditFilterDraft {
  return { from: localValue(Date.parse(filters.from)), to: localValue(Date.parse(filters.to)),
    actorUserId: filters.actorUserId ?? '', module: filters.module ?? '', result: filters.result ?? '' };
}
export function refreshAuditWindow(filters: AuditFilters, rolling: boolean, now = Date.now()): AuditFilters {
  if (!rolling) return filters;
  const current = normalizeAuditFilters(defaultAuditDraft(now));
  if ('error' in current) return filters;
  return { ...filters, from: current.filters.from, to: current.filters.to };
}
export function formatAuditTime(value: string | null, language: Language, unavailable: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return unavailable;
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar-SA-u-ca-gregory' : 'en-GB', {
    calendar: 'gregory', timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}
