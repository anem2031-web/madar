import { TRPCError } from '@trpc/server';
import { PasswordBusyError } from '../../core/auth/password.ts';
import { AuthFault } from '../auth/errors.ts';
import { authRequest } from '../auth/routes.ts';
import type { UsersContext } from '../users/routes.ts';
import type { AuthRequest } from '../auth/service.ts';
import { OverridesFault } from './errors.ts';
import type { PermissionOverridesService } from './service.ts';

export type PermissionOverridesContext = UsersContext & { permissionOverrides?: PermissionOverridesService };

export async function permissionOverridesRoute<T>(context: PermissionOverridesContext,
  work: (service: PermissionOverridesService, request: AuthRequest) => Promise<T>) {
  const request = authRequest(context);
  try {
    if (!context.permissionOverrides) throw new OverridesFault('OVERRIDES_UNAVAILABLE');
    return await work(context.permissionOverrides, request);
  } catch (error) {
    const reason = error instanceof OverridesFault || error instanceof AuthFault ? error.reason
      : error instanceof PasswordBusyError ? 'AUTH_RATE_LIMITED' : 'OVERRIDES_UNAVAILABLE';
    if (reason === 'OVERRIDES_UNAVAILABLE') console.error(JSON.stringify({ event: 'permission_overrides_unavailable', requestId: request.requestId, code: 'OVERRIDES_STORE_FAILURE' }));
    const code = reason === 'OVERRIDES_UNAVAILABLE' ? 'SERVICE_UNAVAILABLE'
      : reason === 'AUTH_REQUIRED' || reason === 'OVERRIDES_REAUTH_FAILED' ? 'UNAUTHORIZED'
      : reason === 'AUTH_FORBIDDEN' || reason === 'AUTH_CSRF' || reason === 'OVERRIDES_SELF_CHANGE' ? 'FORBIDDEN'
      : reason === 'AUTH_RATE_LIMITED' ? 'TOO_MANY_REQUESTS'
      : reason === 'OVERRIDES_NOT_FOUND' ? 'NOT_FOUND'
      : reason === 'OVERRIDES_CONFLICT' ? 'CONFLICT' : 'BAD_REQUEST';
    const cause = reason.startsWith('AUTH_')
      ? new AuthFault(reason as AuthFault['reason'], request.requestId)
      : new OverridesFault(reason as OverridesFault['reason'], request.requestId);
    throw new TRPCError({ code, message: reason, cause });
  }
}
