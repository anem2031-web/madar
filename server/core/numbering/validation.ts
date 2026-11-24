import type { CreateNumberingSeries, NumberingResetPolicy, UpdateNumberingSeries } from '../../../shared/numbering/settings.ts';
import { NumberingFault } from './errors.ts';

function record(input: unknown, required: string[], optional: string[] = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new NumberingFault('NUMBERING_INVALID_INPUT');
  const value = input as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new NumberingFault('NUMBERING_INVALID_INPUT');
  }
  return value;
}
function identifier(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new NumberingFault('NUMBERING_INVALID_INPUT');
  return value.toLowerCase();
}
function code(value: unknown) {
  if (typeof value !== 'string' || value.length > 256) throw new NumberingFault('NUMBERING_INVALID_INPUT');
  const result = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(result)) throw new NumberingFault('NUMBERING_INVALID_INPUT');
  return result;
}
export function validateNewPrefix(value: string) {
  if (!/^[A-Z][a-z]{2}$/.test(value)) throw new NumberingFault('NUMBERING_INVALID_PREFIX');
  return value;
}
function prefix(value: unknown, creating: boolean) {
  if (typeof value !== 'string' || value.length > 64) throw new NumberingFault('NUMBERING_INVALID_PREFIX');
  const result = creating ? value.trim() : value;
  // Preserve historical bytes exactly for an unchanged settings-only toggle.
  if (!result || result.length > 16 || !/^[\x20-\x7e]+$/.test(result)) throw new NumberingFault('NUMBERING_INVALID_PREFIX');
  return creating ? validateNewPrefix(result) : result;
}
function resetPolicy(value: unknown): NumberingResetPolicy {
  if (value !== 'annual' && value !== 'continuous') throw new NumberingFault('NUMBERING_INVALID_INPUT');
  return value;
}
function enabled(value: unknown) {
  if (typeof value !== 'boolean') throw new NumberingFault('NUMBERING_INVALID_INPUT');
  return value;
}
function version(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 4_294_967_295) throw new NumberingFault('NUMBERING_INVALID_INPUT');
  return value;
}
export function listInput(input: unknown): { cursor?: string } {
  if (input === undefined) return {};
  const value = record(input, [], ['cursor']);
  return value.cursor === undefined ? {} : { cursor: identifier(value.cursor) };
}
export function createInput(input: unknown): CreateNumberingSeries {
  const value = record(input, ['code', 'prefix', 'resetPolicy', 'enabled']);
  return { code: code(value.code), prefix: prefix(value.prefix, true), resetPolicy: resetPolicy(value.resetPolicy), enabled: enabled(value.enabled) };
}
export function updateInput(input: unknown): UpdateNumberingSeries {
  const value = record(input, ['seriesId', 'expectedVersion', 'prefix', 'resetPolicy', 'enabled']);
  return { seriesId: identifier(value.seriesId), expectedVersion: version(value.expectedVersion),
    prefix: prefix(value.prefix, false), resetPolicy: resetPolicy(value.resetPolicy), enabled: enabled(value.enabled) };
}
