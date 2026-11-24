import type { ErrorRequestHandler, RequestHandler } from 'express';
import { requestIdFor } from './request-context.ts';
import { safePublicError } from './public-error.ts';
import { logTechnicalFailure } from './technical-log.ts';
import type { TechnicalFailure } from './technical-log.ts';

function own(error: unknown, key: string): unknown {
  if (!error || typeof error !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}
export const jsonRequestContent: RequestHandler = (request, response, next) => {
  if (request.method !== 'POST' || request.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'application/json') {
    next(); return;
  }
  const requestId = requestIdFor(request, response);
  logTechnicalFailure({ requestId, scope: 'http', operation: 'body', code: 'HTTP_UNSUPPORTED_MEDIA' });
  response.set('Cache-Control', 'no-store').status(415).json(safePublicError('UNSUPPORTED_MEDIA_TYPE', requestId));
};
export const notFoundHandler: RequestHandler = (request, response) => {
  const requestId = requestIdFor(request, response);
  logTechnicalFailure({ requestId, scope: 'http', operation: 'not-found', code: 'HTTP_NOT_FOUND' });
  response.set('Cache-Control', 'no-store').status(404).json(safePublicError('NOT_FOUND', requestId));
};
export const httpErrorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const requestId = requestIdFor(request, response);
  const type = own(error, 'type');
  let status = 500;
  let reason = 'INTERNAL_SERVER_ERROR';
  let code: TechnicalFailure['code'] = 'HTTP_INTERNAL_FAILURE';
  if (type === 'entity.parse.failed') { status = 400; reason = 'PARSE_ERROR'; code = 'HTTP_INVALID_REQUEST'; }
  else if (type === 'entity.too.large') { status = 413; reason = 'PAYLOAD_TOO_LARGE'; code = 'HTTP_BODY_TOO_LARGE'; }
  else if (type === 'charset.unsupported' || type === 'encoding.unsupported') { status = 415; reason = 'UNSUPPORTED_MEDIA_TYPE'; code = 'HTTP_UNSUPPORTED_MEDIA'; }
  else if (type === 'request.aborted') { status = 400; reason = 'BAD_REQUEST'; code = 'HTTP_INVALID_REQUEST'; }
  else if (own(error, 'code') === 'ENOENT' && own(error, 'status') === 404) { status = 404; reason = 'NOT_FOUND'; code = 'HTTP_NOT_FOUND'; }
  logTechnicalFailure({ requestId, scope: 'http', operation: type ? 'body' : 'response', code, error });
  if (response.headersSent) { response.destroy(); return; }
  response.set('Cache-Control', 'no-store').status(status).json(safePublicError(reason, requestId));
};
