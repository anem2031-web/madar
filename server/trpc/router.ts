import { initTRPC } from '@trpc/server';
import { AuthFault } from '../modules/auth/errors.ts';
import { authRoute } from '../modules/auth/routes.ts';
import { loginInput, passwordInput } from '../modules/auth/validation.ts';
import { UsersFault } from '../modules/users/errors.ts';
import { usersRoute } from '../modules/users/routes.ts';
import { assignRoleInput, createInput, listInput, targetInput } from '../modules/users/validation.ts';
import { OverridesFault } from '../modules/permission-overrides/errors.ts';
import { permissionOverridesRoute } from '../modules/permission-overrides/routes.ts';
import { OrganizationFault } from '../modules/organization/errors.ts';
import { organizationRoute } from '../modules/organization/routes.ts';
import { NumberingFault } from '../core/numbering/errors.ts';
import { numberingSettingsRoute } from '../core/numbering/router.ts';
import { AuditFault } from '../core/audit/errors.ts';
import { auditRoute } from '../core/audit/router.ts';
import type { AuditContext } from '../core/audit/router.ts';
import { listInput as auditListInput, detailInput as auditDetailInput } from '../core/audit/validation.ts';
import { createInput as numberingCreateInput, listInput as numberingListInput, updateInput as numberingUpdateInput } from '../core/numbering/validation.ts';
import { createBranchInput, createDepartmentInput, listBranchesInput, listDepartmentsInput, renameBranchInput, renameDepartmentInput } from '../modules/organization/validation.ts';
import { detailInput as overridesDetailInput, listInput as overridesListInput, saveInput as overridesSaveInput } from '../modules/permission-overrides/validation.ts';
import { auditErrorCodes, authErrorCodes, numberingErrorCodes, organizationErrorCodes, overridesErrorCodes, usersErrorCodes } from '../../shared/errors/contracts.ts';
import { formatPublicTRPCError, knownReason } from '../core/errors/public-error.ts';
import { currentRequestId, requestIdFor } from '../core/errors/request-context.ts';

const t = initTRPC.context<AuditContext>().create({
  errorFormatter({ shape, error, ctx }) {
    const reason = error.cause instanceof AuthFault ? knownReason(error.cause, authErrorCodes)
      : error.cause instanceof UsersFault ? knownReason(error.cause, usersErrorCodes)
      : error.cause instanceof OverridesFault ? knownReason(error.cause, overridesErrorCodes)
      : error.cause instanceof OrganizationFault ? knownReason(error.cause, organizationErrorCodes)
      : error.cause instanceof NumberingFault ? knownReason(error.cause, numberingErrorCodes)
      : error.cause instanceof AuditFault ? knownReason(error.cause, auditErrorCodes) : undefined;
    return formatPublicTRPCError({ shape, error, reason,
      requestId: ctx ? requestIdFor(ctx.req, ctx.res) : currentRequestId() });
  },
});

export const appRouter = t.router({
  audit: t.router({
    list: t.procedure.input(auditListInput).query(({ ctx, input }) => auditRoute(ctx, (service, request) => service.list(request, input))),
    detail: t.procedure.input(auditDetailInput).query(({ ctx, input }) => auditRoute(ctx, (service, request) => service.detail(request, input))),
  }),
  auth: t.router({
    session: t.procedure.query(({ ctx }) => authRoute(ctx, (auth, request) => auth.session(request))),
    login: t.procedure.input(loginInput).mutation(({ ctx, input }) => authRoute(ctx, (auth, request) => auth.login(request, input))),
    changePassword: t.procedure.input(passwordInput).mutation(({ ctx, input }) => authRoute(ctx, (auth, request) => auth.changePassword(request, input))),
    logout: t.procedure.mutation(({ ctx }) => authRoute(ctx, (auth, request) => auth.logout(request))),
    activity: t.procedure.mutation(({ ctx }) => authRoute(ctx, (auth, request) => auth.activity(request))),
  }),
  users: t.router({
    list: t.procedure.input(listInput).query(({ ctx, input }) => usersRoute(ctx, (service, request) => service.list(request, input))),
    roles: t.procedure.query(({ ctx }) => usersRoute(ctx, (service, request) => service.roles(request))),
    create: t.procedure.input(createInput).mutation(({ ctx, input }) => usersRoute(ctx, (service, request) => service.create(request, input))),
    assignRole: t.procedure.input(assignRoleInput).mutation(({ ctx, input }) => usersRoute(ctx, (service, request) => service.assignRole(request, input))),
    disable: t.procedure.input(targetInput).mutation(({ ctx, input }) => usersRoute(ctx, (service, request) => service.disable(request, input))),
    resetPassword: t.procedure.input(targetInput).mutation(({ ctx, input }) => usersRoute(ctx, (service, request) => service.resetPassword(request, input))),
  }),
  organization: t.router({
    listBranches: t.procedure.input(listBranchesInput).query(({ ctx, input }) => organizationRoute(ctx, (service, request) => service.listBranches(request, input))),
    listDepartments: t.procedure.input(listDepartmentsInput).query(({ ctx, input }) => organizationRoute(ctx, (service, request) => service.listDepartments(request, input))),
    createBranch: t.procedure.input(createBranchInput).mutation(({ ctx, input }) => organizationRoute(ctx, (service, request) => service.createBranch(request, input))),
    renameBranch: t.procedure.input(renameBranchInput).mutation(({ ctx, input }) => organizationRoute(ctx, (service, request) => service.renameBranch(request, input))),
    createDepartment: t.procedure.input(createDepartmentInput).mutation(({ ctx, input }) => organizationRoute(ctx, (service, request) => service.createDepartment(request, input))),
    renameDepartment: t.procedure.input(renameDepartmentInput).mutation(({ ctx, input }) => organizationRoute(ctx, (service, request) => service.renameDepartment(request, input))),
  }),
  numberingSettings: t.router({
    list: t.procedure.input(numberingListInput).query(({ ctx, input }) => numberingSettingsRoute(ctx, (service, request) => service.list(request, input))),
    create: t.procedure.input(numberingCreateInput).mutation(({ ctx, input }) => numberingSettingsRoute(ctx, (service, request) => service.create(request, input))),
    update: t.procedure.input(numberingUpdateInput).mutation(({ ctx, input }) => numberingSettingsRoute(ctx, (service, request) => service.update(request, input))),
  }),
  permissionOverrides: t.router({
    list: t.procedure.input(overridesListInput).query(({ ctx, input }) => permissionOverridesRoute(ctx, (service, request) => service.list(request, input))),
    detail: t.procedure.input(overridesDetailInput).query(({ ctx, input }) => permissionOverridesRoute(ctx, (service, request) => service.detail(request, input))),
    save: t.procedure.input(overridesSaveInput).mutation(({ ctx, input }) => permissionOverridesRoute(ctx, (service, request) => service.save(request, input))),
  }),
});

export type AppRouter = typeof appRouter;
