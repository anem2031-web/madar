import { TRPCError } from '@trpc/server';
import { auditErrorCodes, authErrorCodes } from '../../../shared/errors/contracts.ts';
import { knownReason } from '../errors/public-error.ts';
import { logTechnicalFailure } from '../errors/technical-log.ts';
import { databaseAcquisitionFailure } from '../errors/database-failure.ts';
import type { NumberingSettingsContext } from '../numbering/router.ts';
import { authRequest } from '../../modules/auth/routes.ts';
import { AuthFault } from '../../modules/auth/errors.ts';
import type { AuthRequest } from '../../modules/auth/service.ts';
import { AuditFault } from './errors.ts';
import type { AuditService } from './service.ts';
export type AuditContext = NumberingSettingsContext & { audit?: AuditService };
export async function auditRoute<T>(context: AuditContext, work: (service: AuditService, request: AuthRequest) => Promise<T>) {
  const request = authRequest(context);
  try {
    if (!context.audit) throw new AuditFault('AUDIT_UNAVAILABLE');
    return await work(context.audit, request);
  } catch (error) {
    const acquisitionFailure = databaseAcquisitionFailure(error, { requestId: request.requestId, scope: 'audit', code: 'AUDIT_STORE_FAILURE' });
    if (acquisitionFailure) throw acquisitionFailure;
    const reason = (error instanceof AuditFault ? knownReason(error, auditErrorCodes) : error instanceof AuthFault ? knownReason(error, authErrorCodes) : undefined) ?? 'AUDIT_UNAVAILABLE';
    if (reason === 'AUDIT_UNAVAILABLE') logTechnicalFailure({ requestId: request.requestId, scope: 'audit', operation: 'request', code: 'AUDIT_STORE_FAILURE', error });
    const code = reason === 'AUDIT_UNAVAILABLE' ? 'SERVICE_UNAVAILABLE' : reason === 'AUTH_REQUIRED' ? 'UNAUTHORIZED'
      : reason === 'AUTH_FORBIDDEN' || reason === 'AUTH_CSRF' ? 'FORBIDDEN' : reason === 'AUTH_RATE_LIMITED' ? 'TOO_MANY_REQUESTS'
      : reason === 'AUDIT_NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST';
    const cause = reason.startsWith('AUTH_') ? new AuthFault(reason as AuthFault['reason'], request.requestId) : new AuditFault(reason as AuditFault['reason'], request.requestId);
    throw new TRPCError({ code, message: reason, cause });
  }
}
