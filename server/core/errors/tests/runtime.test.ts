import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { expect, test } from 'vitest';

test('a failed listen emits one safe failure and never announces readiness', async () => {
  const blocker = createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  const address = blocker.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated test port.');
  const child = spawn(process.execPath, ['server/index.ts', '--api-only'], {
    env: { ...process.env, MADAR_RUNTIME_MODE: 'local', PORT: String(address.port), NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 8_000);
  try {
    const [code] = await once(child, 'close');
    expect(code).toBe(1);
    expect(stdout).not.toContain('Madar listening');
    const records = stderr.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: 'technical_failure', scope: 'runtime', operation: 'listen', code: 'RUNTIME_LISTEN_FAILURE' });
    expect(records[0].requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(stderr).not.toMatch(/Error:|stack|DATABASE_URL|AUTH_SECRET|sql/i);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await new Promise<void>(resolve => blocker.close(() => resolve()));
  }
}, 12_000);
