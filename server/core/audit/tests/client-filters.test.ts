import { expect, test } from 'vitest';
import { auditDraftFromFilters, defaultAuditDraft, formatAuditTime, normalizeAuditFilters, readAuditSubmission, refreshAuditWindow } from '../../../../client/src/modules/audit/filters.ts';

test('default seven-day dates use Riyadh time and normalize back to the same UTC instants', () => {
  const now = Date.parse('2026-12-31T21:30:00Z');
  const draft = defaultAuditDraft(now);
  expect(draft.to).toBe('2027-01-01T00:30:00');
  expect(draft.from).toBe('2026-12-25T00:30:00');
  const parsed = normalizeAuditFilters(draft);
  expect(parsed).toEqual({ filters: { from: '2026-12-24T21:30:00.000Z', to: '2026-12-31T21:30:00.000Z' } });
  if ('error' in parsed) throw new Error('Expected valid filters.');
  expect(auditDraftFromFilters(parsed.filters)).toEqual(draft);
});

test('rolling refresh advances both bounds while preserving every active non-time filter', () => {
  const previous = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-08T00:00:00.000Z',
    actorUserId: '11111111-1111-1111-1111-111111111111', module: 'users' as const, result: 'denied' as const };
  const refreshed = refreshAuditWindow(previous, true, Date.parse('2026-11-24T12:34:56Z'));
  expect(refreshed).toEqual({ ...previous, from: '2026-11-17T12:34:56.000Z', to: '2026-11-24T12:34:56.000Z' });
  expect(previous.to).toBe('2026-11-08T00:00:00.000Z');
});

test('refresh leaves a custom period fixed even when the current time changes', () => {
  const custom = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', module: 'numbering' as const };
  expect(refreshAuditWindow(custom, false, Date.parse('2027-01-01T00:00:00Z'))).toBe(custom);
});

test('native datetime fields select the submitted fixed range even when React draft and change flag are stale', () => {
  const draft = defaultAuditDraft(Date.parse('2026-11-24T12:00:00Z'));
  const parsed = normalizeAuditFilters(draft);
  if ('error' in parsed) throw new Error('Expected valid filters.');
  const form = new FormData();
  form.set('from', '2026-11-23T00:00'); form.set('to', '2026-11-24T23:59'); form.set('actor', '');
  const submitted = readAuditSubmission(form, draft, parsed.filters, true, false);
  expect(submitted).toEqual({ draft: { ...draft, from: '2026-11-23T00:00', to: '2026-11-24T23:59' },
    filters: { from: '2026-11-22T21:00:00.000Z', to: '2026-11-24T20:59:00.000Z' }, rolling: false });
});

test('equivalent native dates retain rolling mode only for an unchanged rolling period', () => {
  const draft = { ...defaultAuditDraft(Date.parse('2026-11-24T12:00:00Z')), module: 'users' as const };
  const parsed = normalizeAuditFilters(draft);
  if ('error' in parsed) throw new Error('Expected valid filters.');
  const form = new FormData();
  form.set('from', draft.from.slice(0, 16)); form.set('to', draft.to.slice(0, 16)); form.set('actor', '');
  expect(readAuditSubmission(form, draft, parsed.filters, true, false)).toMatchObject({ filters: parsed.filters, rolling: true });
  expect(readAuditSubmission(form, draft, parsed.filters, false, false)).toMatchObject({ filters: parsed.filters, rolling: false });
  expect(readAuditSubmission(form, draft, parsed.filters, true, true)).toMatchObject({ filters: parsed.filters, rolling: false });
  form.set('from', '');
  expect(readAuditSubmission(form, draft, parsed.filters, true, false)).toMatchObject({ error: 'invalidPeriod' });
});

test('validation accepts exactly 31 days but rejects longer, inverted and nonexistent local dates', () => {
  const valid = { ...defaultAuditDraft(), from: '2026-12-01T00:00:00', to: '2027-01-01T00:00:00' };
  expect(normalizeAuditFilters(valid)).toHaveProperty('filters');
  for (const draft of [
    { ...valid, to: '2027-01-01T00:00:01' }, { ...valid, from: valid.to },
    { ...valid, from: '2026-02-30T00:00:00', to: '2026-03-01T00:00:00' },
    { ...valid, from: 'not-a-date' },
  ]) expect(normalizeAuditFilters(draft)).toEqual({ error: 'invalidPeriod' });
});

test('user identifiers are validated independently of the time range and dates display Gregorian Riyadh time', () => {
  const draft = { ...defaultAuditDraft(Date.parse('2026-11-24T12:00:00Z')), actorUserId: 'not-an-id' };
  expect(normalizeAuditFilters(draft)).toEqual({ error: 'invalidIdentifier' });
  const english = formatAuditTime('2026-12-31T21:30:00Z', 'en', 'unavailable');
  expect(english).toContain('01/01/2027'); expect(english).toContain('00:30:00');
  expect(formatAuditTime('invalid-date', 'ar', 'غير متاح')).toBe('غير متاح');
});
