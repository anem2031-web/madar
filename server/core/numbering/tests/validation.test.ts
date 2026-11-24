import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createInput, listInput, updateInput } from '../validation.ts';
import { numberingDuplicateReason } from '../errors.ts';

const creation = { code: '  Doc_Type-1  ', prefix: 'Fsw', resetPolicy: 'annual', enabled: true };
test('type codes retain ASCII case and accept the documented 1..64 range', () => {
  expect(createInput(creation).code).toBe('Doc_Type-1');
  expect(createInput({ ...creation, code: 'a' }).code).toBe('a');
  expect(createInput({ ...creation, code: 'A'.repeat(64) }).code).toHaveLength(64);
  for (const code of ['', '  ', 'A'.repeat(65), '9Type', '_Type', 'نوع', 'A B', 'A/Type']) {
    expect(() => createInput({ ...creation, code })).toThrow('NUMBERING_INVALID_INPUT');
  }
});

test('new prefixes use exactly an uppercase Latin letter followed by two lowercase Latin letters', () => {
  expect(createInput(creation).prefix).toBe('Fsw');
  for (const prefix of ['FSW', 'fsw', 'FsW', 'Fs', 'Fsww', 'Fśw', 'F sw', '123', '']) {
    expect(() => createInput({ ...creation, prefix })).toThrow('NUMBERING_INVALID_PREFIX');
  }
});

test('requests cannot supply immutable identifiers, issued flags, formats, padding or counters', () => {
  for (const extra of [{ id: randomUUID() }, { format: 'arbitrary' }, { paddingWidth: 9 }, { hasIssued: true }, { lastValue: 99 }, { createdBy: randomUUID() }]) {
    expect(() => createInput({ ...creation, ...extra })).toThrow('NUMBERING_INVALID_INPUT');
  }
  const update = { seriesId: randomUUID(), expectedVersion: 1, prefix: 'Fsw', resetPolicy: 'continuous', enabled: false };
  expect(() => updateInput({ ...update, code: 'ChangedType' })).toThrow('NUMBERING_INVALID_INPUT');
  for (const expectedVersion of [0, -1, 1.5, Number.NaN, Infinity, 4_294_967_296]) {
    expect(() => updateInput({ ...update, expectedVersion })).toThrow('NUMBERING_INVALID_INPUT');
  }
  expect(() => createInput({ ...creation, enabled: 1 })).toThrow('NUMBERING_INVALID_INPUT');
  expect(() => createInput({ ...creation, resetPolicy: 'monthly' })).toThrow('NUMBERING_INVALID_INPUT');
  expect(() => listInput({ cursor: 'not-a-uuid' })).toThrow('NUMBERING_INVALID_INPUT');
  expect(() => listInput({ limit: 1000 })).toThrow('NUMBERING_INVALID_INPUT');
});

test('only known unique-index driver errors map to friendly duplicate reasons, including nested Drizzle causes', () => {
  const error = (index: string) => Object.assign(new Error(`Duplicate entry for key 'numbering_series.${index}'`), { code: 'ER_DUP_ENTRY', errno: 1062 });
  expect(numberingDuplicateReason({ cause: error('uq_numbering_series_code') })).toBe('NUMBERING_DUPLICATE_CODE');
  expect(numberingDuplicateReason({ cause: { cause: error('uq_numbering_series_prefix') } })).toBe('NUMBERING_DUPLICATE_PREFIX');
  expect(numberingDuplicateReason(error('unrelated_index'))).toBeNull();
  expect(numberingDuplicateReason(new Error("for key 'uq_numbering_series_prefix'"))).toBeNull();
});
