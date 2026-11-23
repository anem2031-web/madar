import { once } from 'node:events';
import { createTRPCClient, httpLink } from '@trpc/client';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createApp } from './app.ts';
import type { AppRouter } from './trpc/router.ts';

let listener: ReturnType<ReturnType<typeof createApp>['listen']>;
let origin: string;
let databaseReady = true;

beforeAll(async () => {
  listener = createApp({
    pingDatabase: async () => {
      if (!databaseReady) throw new Error('sensitive database detail');
    },
  }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener address.');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (!listener?.listening) return;
  const closed = once(listener, 'close');
  listener.close();
  await closed;
});

test('does not provide a simulated login when authentication storage is not configured', async () => {
  const client = createTRPCClient<AppRouter>({ links: [httpLink({ url: `${origin}/api/trpc` })] });
  await expect(client.auth.session.query()).rejects.toThrow('AUTH_UNAVAILABLE');
});

test('does not expose diagnostics or cache API failures', async () => {
  const response = await fetch(`${origin}/api/trpc/doesNotExist`);
  expect(response.status).toBe(404);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({
    error: { message: 'NOT_FOUND', code: -32004, data: { code: 'NOT_FOUND', httpStatus: 404 } },
  });
});

test('responds with readiness only when its database check succeeds', async () => {
  const ready = await fetch(`${origin}/health`);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ status: 'ready' });

  databaseReady = false;
  const unavailable = await fetch(`${origin}/health`);
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.get('Cache-Control')).toBe('no-store');
  expect(await unavailable.json()).toEqual({ status: 'unavailable' });
});
