import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { expect, test } from 'vitest';
import { currentRequestId, requestContextMiddleware, requestIdFor } from '../request-context.ts';
import { formatPublicTRPCError } from '../public-error.ts';

function pair() {
  const forged = randomUUID(); const headers = new Map<string, unknown>();
  const request = { headers: { 'x-request-id': forged } } as unknown as Request;
  const response = { headersSent: false, locals: { requestId: forged }, setHeader(name: string, value: unknown) { headers.set(name, value); } } as unknown as Response;
  return { request, response, forged, headers };
}
test('server request UUID ignores header/locals and is stable across service calls with the same response header', () => {
  const value = pair(); const first = requestIdFor(value.request, value.response);
  expect(first).toMatch(/^[a-f0-9-]{36}$/); expect(first).not.toBe(value.forged);
  expect(requestIdFor(value.request, value.response)).toBe(first); expect(value.headers.get('X-Request-ID')).toBe(first);
  expect(requestIdFor(pair().request)).not.toBe(first); expect(currentRequestId()).toBeUndefined();
});
test('async request contexts do not cross simultaneous requests and correlate formatter failures before tRPC context creation', async () => {
  const one = pair(); const two = pair();
  const capture = (value: ReturnType<typeof pair>, wait: number) => new Promise<{ before: string | undefined; after: string | undefined; body: unknown }>(resolve => {
    requestContextMiddleware(value.request, value.response, () => {
      const before = currentRequestId();
      setTimeout(() => {
        const body = formatPublicTRPCError({ shape: { code: -32600, data: { code: 'BAD_REQUEST', httpStatus: 400 } }, error: new Error('Synthetic private body') });
        resolve({ before, after: currentRequestId(), body });
      }, wait);
    });
  });
  const [left, right] = await Promise.all([capture(one, 5), capture(two, 1)]);
  expect(left.before).toBe(left.after); expect(right.before).toBe(right.after); expect(left.before).not.toBe(right.before);
  expect((left.body as { data: { requestId: string } }).data.requestId).toBe(one.headers.get('X-Request-ID'));
  expect((right.body as { data: { requestId: string } }).data.requestId).toBe(two.headers.get('X-Request-ID'));
  expect(currentRequestId()).toBeUndefined();
});
