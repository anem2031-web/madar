import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';

function worker() {
  const handlers = new Map<string, (event: any) => void>();
  const cache = { add: vi.fn().mockResolvedValue(undefined), match: vi.fn().mockResolvedValue('offline') };
  const fetch = vi.fn().mockRejectedValue(new Error('offline'));
  const caches = { open: vi.fn().mockResolvedValue(cache), keys: vi.fn().mockResolvedValue([]), delete: vi.fn() };
  runInNewContext(readFileSync('client/public/sw.js', 'utf8'), {
    self: { location: { origin: 'https://madar.example' }, addEventListener: (key: string, handler: any) => handlers.set(key, handler) },
    caches, fetch, URL, Response,
  });
  return { handlers, caches, cache, fetch };
}

test('offline worker only stores its public offline page', async () => {
  const w = worker();
  let pending!: Promise<unknown>;
  w.handlers.get('install')!({ waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
  await pending;
  expect(w.cache.add).toHaveBeenCalledExactlyOnceWith('/offline.html');
});

test('authentication, mutation, cross-origin and unknown routes bypass the offline worker', () => {
  const w = worker();
  for (const [method, mode, url] of [
    ['GET', 'cors', 'https://madar.example/api/trpc/auth.session'],
    ['POST', 'navigate', 'https://madar.example/'],
    ['GET', 'navigate', 'https://madar.example/api/trpc/auth.session'],
    ['GET', 'navigate', 'https://other.example/'],
    ['GET', 'navigate', 'https://madar.example/unknown'],
  ]) {
    const respondWith = vi.fn();
    w.handlers.get('fetch')!({ request: { method, mode, url }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  }
  expect(w.fetch).not.toHaveBeenCalled();
});

test('offline navigation falls back but preserves real HTTP denial or unavailability', async () => {
  const w = worker();
  let pending!: Promise<unknown>;
  const event = { request: { method: 'GET', mode: 'navigate', url: 'https://madar.example/' }, respondWith: (promise: Promise<unknown>) => { pending = promise; } };
  w.handlers.get('fetch')!(event);
  expect(await pending).toBe('offline');
  const unavailable = new Response('Unavailable', { status: 503 });
  w.fetch.mockResolvedValueOnce(unavailable as never);
  w.handlers.get('fetch')!(event);
  expect(await pending).toBe(unavailable);
});

test('user-management navigation uses the public offline page without caching user data', async () => {
  const w = worker();
  let pending!: Promise<unknown>;
  w.handlers.get('fetch')!({
    request: { method: 'GET', mode: 'navigate', url: 'https://madar.example/users' },
    respondWith: (promise: Promise<unknown>) => { pending = promise; },
  });
  expect(await pending).toBe('offline');
  expect(w.cache.add).not.toHaveBeenCalled();
  expect(w.cache.match).toHaveBeenCalledExactlyOnceWith('/offline.html');
});

test('install manifest uses valid generated PNGs in required sizes', () => {
  const manifest = JSON.parse(readFileSync('client/public/manifest.webmanifest', 'utf8'));
  expect(manifest.start_url).toBe('/');
  for (const size of [192, 512]) {
    const bytes = readFileSync(`client/public/icons/madar-${size}.png`);
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
    expect(manifest.icons.some((icon: { sizes: string }) => icon.sizes === `${size}x${size}`)).toBe(true);
  }
});
