import { TRPCError } from '@trpc/server';
import { AuthFault } from '../auth/errors.ts';
import { authRequest } from '../auth/routes.ts';
import type { AuthRequest } from '../auth/service.ts';
import type { PermissionOverridesContext } from '../permission-overrides/routes.ts';
import { OrganizationFault } from './errors.ts';
import type { OrganizationService } from './service.ts';

export type OrganizationContext = PermissionOverridesContext & { organization?: OrganizationService };

export async function organizationRoute<T>(context: OrganizationContext,
  work: (service: OrganizationService, request: AuthRequest) => Promise<T>) {
  const request = authRequest(context);
  try {
    if (!context.organization) throw new OrganizationFault('ORG_UNAVAILABLE');
    return await work(context.organization, request);
  } catch (error) {
    const reason = error instanceof OrganizationFault || error instanceof AuthFault ? error.reason : 'ORG_UNAVAILABLE';
    if (reason === 'ORG_UNAVAILABLE') console.error(JSON.stringify({ event: 'organization_unavailable', requestId: request.requestId, code: 'ORG_STORE_FAILURE' }));
    const code = reason === 'ORG_UNAVAILABLE' ? 'SERVICE_UNAVAILABLE'
      : reason === 'AUTH_REQUIRED' ? 'UNAUTHORIZED'
      : reason === 'AUTH_FORBIDDEN' || reason === 'AUTH_CSRF' ? 'FORBIDDEN'
      : reason === 'AUTH_RATE_LIMITED' ? 'TOO_MANY_REQUESTS'
      : reason === 'ORG_BRANCH_NOT_FOUND' || reason === 'ORG_DEPARTMENT_NOT_FOUND' ? 'NOT_FOUND'
      : reason === 'ORG_CONFLICT' ? 'CONFLICT' : 'BAD_REQUEST';
    const cause = reason.startsWith('AUTH_')
      ? new AuthFault(reason as AuthFault['reason'], request.requestId)
      : new OrganizationFault(reason as OrganizationFault['reason'], request.requestId);
    throw new TRPCError({ code, message: reason, cause });
  }
}
