import { expect, test } from 'vitest';
import { readRuntimeConfig } from './env.ts';

const base = { MADAR_RUNTIME_MODE: 'connected', DATABASE_URL: 'mysql://user:secret@db.invalid:4000/madar', AUTH_SECRET: 's'.repeat(48) };

test('connected authentication requires explicit origin and durable secret', () => {
  expect(() => readRuntimeConfig(base)).toThrow();
  expect(() => readRuntimeConfig({ ...base, APP_ORIGIN: 'https://madar.invalid', AUTH_SECRET: '' })).toThrow();
  expect(readRuntimeConfig({ ...base, APP_ORIGIN: 'https://madar.invalid' })).toMatchObject({ mode: 'connected' });
});

test('production authentication cannot fall back to insecure development cookies', () => {
  expect(() => readRuntimeConfig({ ...base, APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'production' })).toThrow();
  expect(() => readRuntimeConfig({ ...base, APP_ORIGIN: 'http://madar.invalid' })).toThrow();
  expect(() => readRuntimeConfig({ ...base, APP_ORIGIN: 'https://madar.invalid/path' })).toThrow();
  expect(readRuntimeConfig({ ...base, APP_ORIGIN: 'http://localhost:3000' })).toMatchObject({ mode: 'connected' });
});
