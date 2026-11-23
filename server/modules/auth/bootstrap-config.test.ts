import { expect, test } from 'vitest';
import { readBootstrapConfig } from './bootstrap-config.ts';

const databaseUrl = 'mysql://fixture:private-fixture@example.invalid:4000/madar';

test('local setup identifies missing, short and long passwords without echoing them', () => {
  for (const [password, message] of [[undefined, 'أضف MADAR_ADMIN_PASSWORD'], ['short-private', 'أقصر من 15'], ['x'.repeat(129), 'أطول من 128']] as const) {
    let error: unknown;
    try { readBootstrapConfig({ DATABASE_URL: databaseUrl, MADAR_ADMIN_PASSWORD: password }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    if (password) expect((error as Error).message).not.toContain(password);
    expect((error as Error).message).not.toContain(databaseUrl);
  }
});

test('setup preserves Unicode and spaces while enforcing codepoint length at both boundaries', () => {
  for (const password of [' ع'.repeat(8), '🔐'.repeat(15), 'x'.repeat(128)]) {
    expect(readBootstrapConfig({ DATABASE_URL: databaseUrl, MADAR_ADMIN_PASSWORD: password }).password).toBe(password);
  }
});

test('setup refuses absent, malformed or other-database URLs without exposing credentials', () => {
  for (const url of [undefined, 'not-a-url', databaseUrl.replace('/madar', '/other'), databaseUrl.replace('mysql:', 'https:')]) {
    let error: unknown;
    try { readBootstrapConfig({ DATABASE_URL: url, MADAR_ADMIN_PASSWORD: 'private-password-fixture' }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    if (url) expect((error as Error).message).not.toContain(url);
    expect((error as Error).message).not.toContain('private-password-fixture');
  }
});
