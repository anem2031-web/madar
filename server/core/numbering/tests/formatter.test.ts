import { expect, test } from 'vitest';
import { calendarYearInRiyadh } from '../formatter.ts';

test('the annual boundary follows Riyadh midnight rather than UTC midnight', () => {
  expect(calendarYearInRiyadh(new Date('2026-12-31T20:59:59.999Z'))).toBe(2026);
  expect(calendarYearInRiyadh(new Date('2026-12-31T21:00:00.000Z'))).toBe(2027);
  expect(calendarYearInRiyadh(new Date('2027-01-01T00:00:00.000Z'))).toBe(2027);
});

test('calendar year derives from the supplied server instant and rejects an invalid date', () => {
  expect(calendarYearInRiyadh(new Date('2030-06-01T11:45:00Z'))).toBe(2030);
  expect(() => calendarYearInRiyadh(new Date(Number.NaN))).toThrow();
});
