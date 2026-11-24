import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';

const requestIds = new WeakMap<Request, string>();
const activeRequest = new AsyncLocalStorage<{ requestId: string }>();

export function requestIdFor(request: Request, response?: Response): string {
  let requestId = requestIds.get(request);
  if (!requestId) { requestId = randomUUID(); requestIds.set(request, requestId); }
  if (response && !response.headersSent) response.setHeader('X-Request-ID', requestId);
  return requestId;
}
export function currentRequestId(): string | undefined { return activeRequest.getStore()?.requestId; }
export const requestContextMiddleware: RequestHandler = (request, response, next) => {
  const requestId = requestIdFor(request, response);
  activeRequest.run({ requestId }, next);
};
