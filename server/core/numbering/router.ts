import { TRPCError } from '@trpc/server';
import { authErrorCodes, numberingErrorCodes } from '../../../shared/errors/contracts.ts';
import { knownReason } from '../errors/public-error.ts';
import { logTechnicalFailure } from '../errors/technical-log.ts';
import { AuthFault } from '../../modules/auth/errors.ts';
import { authRequest } from '../../modules/auth/routes.ts';
import type { AuthRequest } from '../../modules/auth/service.ts';
import type { OrganizationContext } from '../../modules/organization/routes.ts';
import { NumberingFault } from './errors.ts';
import type { NumberingSettingsService } from './service.ts';

export type NumberingSettingsContext = OrganizationContext & { numberingSettings?: NumberingSettingsService };

export async function numberingSettingsRoute<T>(context: NumberingSettingsContext,
  work: (service: NumberingSettingsService, request: AuthRequest) => Promise<T>) {
  const request = authRequest(context);
  try {
    if (!context.numberingSettings) throw new NumberingFault('NUMBERING_UNAVAILABLE');
    return await work(context.numberingSettings, request);
  } catch (error) {
    const reason = (error instanceof NumberingFault ? knownReason(error, numberingErrorCodes) : error instanceof AuthFault ? knownReason(error, authErrorCodes) : undefined) ?? 'NUMBERING_UNAVAILABLE';
    if (reason === 'NUMBERING_UNAVAILABLE') logTechnicalFailure({ requestId: request.requestId, scope: 'numbering', operation: 'request', code: 'NUMBERING_STORE_FAILURE', error });
    const code = reason === 'NUMBERING_UNAVAILABLE' ? 'SERVICE_UNAVAILABLE'
      : reason === 'AUTH_REQUIRED' ? 'UNAUTHORIZED'
      : reason === 'AUTH_FORBIDDEN' || reason === 'AUTH_CSRF' ? 'FORBIDDEN'
      : reason === 'AUTH_RATE_LIMITED' ? 'TOO_MANY_REQUESTS'
      : reason === 'NUMBERING_NOT_FOUND' ? 'NOT_FOUND'
      : reason === 'NUMBERING_CONFLICT' || reason === 'NUMBERING_LOCKED' || reason === 'NUMBERING_DUPLICATE_CODE' || reason === 'NUMBERING_DUPLICATE_PREFIX' ? 'CONFLICT' : 'BAD_REQUEST';
    const cause = reason.startsWith('AUTH_')
      ? new AuthFault(reason as AuthFault['reason'], request.requestId)
      : new NumberingFault(reason as NumberingFault['reason'], request.requestId);
    throw new TRPCError({ code, message: reason, cause });
  }
}
