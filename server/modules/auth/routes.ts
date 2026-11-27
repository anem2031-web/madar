import { TRPCError } from '@trpc/server';
import type { Request, Response } from 'express';
import { PasswordBusyError } from '../../core/auth/password.ts';
import { authErrorCodes } from '../../../shared/errors/contracts.ts';
import { requestIdFor } from '../../core/errors/request-context.ts';
import { knownReason } from '../../core/errors/public-error.ts';
import { logTechnicalFailure } from '../../core/errors/technical-log.ts';
import { databaseAcquisitionFailure } from '../../core/errors/database-failure.ts';
import { AuthFault } from './errors.ts';
import type { AuthReason } from './errors.ts';
import type { AuthRequest, AuthResult, AuthService } from './service.ts';

export type AuthContext = { req: Request; res: Response; auth?: AuthService; secureCookies: boolean };

export function sessionCookieName(secure: boolean) { return secure ? '__Host-madar_session' : 'madar_dev_session'; }

export function authRequest(context: AuthContext): AuthRequest {
  const name = sessionCookieName(context.secureCookies);
  const values = (context.req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  return {
    token: values.length === 1 ? values[0].slice(name.length + 1) : undefined,
    csrf: context.req.get('x-madar-csrf'), origin: context.req.get('origin'),
    peer: context.req.socket.remoteAddress ?? 'unknown', requestId: requestIdFor(context.req, context.res),
  };
}

export async function authRoute(context: AuthContext, work: (auth: AuthService, request: AuthRequest) => Promise<AuthResult>) {
  const request = authRequest(context);
  try {
    if (!context.auth) throw new AuthFault('AUTH_UNAVAILABLE');
    const result = await work(context.auth, request);
    const token = result.token ?? request.token;
    if (token) {
      const maxAge = Math.max(0, Math.floor((Date.parse(result.view.expiresAt ?? '') - Date.now()) / 1000));
      context.res.setHeader('Set-Cookie', `${sessionCookieName(context.secureCookies)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${context.secureCookies ? '; Secure' : ''}`);
    }
    return result.view;
  } catch (error) {
    const acquisitionFailure = databaseAcquisitionFailure(error, { requestId: request.requestId, scope: 'auth', code: 'AUTH_STORE_FAILURE' });
    if (acquisitionFailure) throw acquisitionFailure;
    const reason: AuthReason = (error instanceof AuthFault ? knownReason(error, authErrorCodes) : error instanceof PasswordBusyError ? 'AUTH_RATE_LIMITED' : undefined) ?? 'AUTH_UNAVAILABLE';
    if (reason === 'AUTH_UNAVAILABLE') logTechnicalFailure({ requestId: request.requestId, scope: 'auth', operation: 'request', code: 'AUTH_STORE_FAILURE', error });
    const code = reason === 'AUTH_UNAVAILABLE' ? 'SERVICE_UNAVAILABLE'
      : reason === 'AUTH_RATE_LIMITED' ? 'TOO_MANY_REQUESTS'
      : reason === 'AUTH_REQUIRED' || reason === 'AUTH_INVALID_CREDENTIALS' ? 'UNAUTHORIZED'
      : reason === 'AUTH_CSRF' || reason === 'AUTH_FORBIDDEN' ? 'FORBIDDEN' : 'BAD_REQUEST';
    throw new TRPCError({ code, message: reason, cause: new AuthFault(reason, request.requestId) });
  }
}
