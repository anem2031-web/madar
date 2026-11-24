import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { detailInput, listInput } from '../validation.ts';

const period = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-24T00:00:00.000Z' };
test('periods are mandatory positive UTC ranges of at most31days and valid SQL calendar dates', () => {
  expect(listInput(period)).toEqual(period);
  for (const input of [{}, { ...period, to: period.from }, { ...period, to: '2026-12-03T00:00:00Z' },
    { ...period, from: '2026-02-30T00:00:00Z' }, { ...period, from: '2026-11-01T03:00:00+03:00' },
    { from: '0999-01-01T00:00:00Z', to: '0999-01-02T00:00:00Z' }]) expect(() => listInput(input)).toThrow('AUDIT_INVALID_INPUT');
});
test('cursor and filters remain typed, bounded to the selected period and cannot supply raw search SQL', () => {
  const cursor = { occurredAt: '2026-11-20T00:00:00.000Z', eventId: randomUUID() };
  expect(listInput({ ...period, cursor }).cursor).toEqual(cursor);
  for (const extra of [{ cursor: { ...cursor, occurredAt: '2026-10-01T00:00:00Z' } }, { cursor: { ...cursor, extra: true } },
    { module: "auth' OR 1=1" }, { result: 'all' }, { actorUserId: 'ADMIN' }, { search: 'secret text' }, { limit: 1000 }]) {
    expect(() => listInput({ ...period, ...extra })).toThrow('AUDIT_INVALID_INPUT');
  }
  expect(() => detailInput({ eventId: randomUUID(), deliveryState: 'pending' })).toThrow('AUDIT_INVALID_INPUT');
});
