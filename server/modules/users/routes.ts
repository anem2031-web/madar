import { TRPCError } from '@trpc/server';
import { PasswordBusyError } from '../../core/auth/password.ts';
import { AuthFault } from '../auth/errors.ts';
import { authRequest } from '../auth/routes.ts';
import type { AuthContext } from '../auth/routes.ts';
import type { AuthRequest } from '../auth/service.ts';
import { UsersFault } from './errors.ts';
import type { UsersService } from './service.ts';

export type UsersContext = AuthContext & { users?: UsersService };

export async function usersRoute<T>(context: UsersContext, work: (service: UsersService, request: AuthRequest) => Promise<T>) {
  const request = authRequest(context);
  try {
    if (!context.users) throw new UsersFault('USERS_UNAVAILABLE');
    return await work(context.users, request);
  } catch (error) {
    const reason = error instanceof UsersFault || error instanceof AuthFault ? error.reason
      : error instanceof PasswordBusyError ? 'AUTH_RATE_LIMITED' : 'USERS_UNAVAILABLE';
    if (reason === 'USERS_UNAVAILABLE') console.error(JSON.stringify({ event: 'users_unavailable', requestId: request.requestId, code: 'USERS_STORE_FAILURE' }));
    const code = reason === 'USERS_UNAVAILABLE' ? 'SERVICE_UNAVAILABLE'
      : reason === 'AUTH_REQUIRED' || reason === 'USERS_REAUTH_FAILED' ? 'UNAUTHORIZED'
      : reason === 'AUTH_FORBIDDEN' || reason === 'AUTH_CSRF' || reason === 'USERS_SELF_CHANGE' ? 'FORBIDDEN'
      : reason === 'AUTH_RATE_LIMITED' ? 'TOO_MANY_REQUESTS'
      : reason === 'USERS_NOT_FOUND' || reason === 'USERS_ROLE_NOT_FOUND' ? 'NOT_FOUND'
      : reason === 'USERS_CONFLICT' || reason === 'USERS_DUPLICATE_USERNAME' || reason === 'USERS_ALREADY_DISABLED' ? 'CONFLICT' : 'BAD_REQUEST';
    const cause = reason.startsWith('AUTH_')
      ? new AuthFault(reason as AuthFault['reason'], request.requestId)
      : new UsersFault(reason as UsersFault['reason'], request.requestId);
    throw new TRPCError({ code, message: reason, cause });
  }
}
