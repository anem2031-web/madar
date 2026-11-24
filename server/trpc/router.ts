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
import type { OrganizationContext } from '../modules/organization/routes.ts';
import { createBranchInput, createDepartmentInput, listBranchesInput, listDepartmentsInput, renameBranchInput, renameDepartmentInput } from '../modules/organization/validation.ts';
import { detailInput as overridesDetailInput, listInput as overridesListInput, saveInput as overridesSaveInput } from '../modules/permission-overrides/validation.ts';

const t = initTRPC.context<OrganizationContext>().create({
  errorFormatter({ shape, error }) {
    return {
      code: shape.code,
      message: error.cause instanceof AuthFault || error.cause instanceof UsersFault || error.cause instanceof OverridesFault || error.cause instanceof OrganizationFault ? error.cause.reason : shape.data.code,
      data: { code: shape.data.code, httpStatus: shape.data.httpStatus,
        ...((error.cause instanceof AuthFault || error.cause instanceof UsersFault || error.cause instanceof OverridesFault || error.cause instanceof OrganizationFault) && error.cause.requestId ? { requestId: error.cause.requestId } : {}),
      },
    };
  },
});

export const appRouter = t.router({
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
  permissionOverrides: t.router({
    list: t.procedure.input(overridesListInput).query(({ ctx, input }) => permissionOverridesRoute(ctx, (service, request) => service.list(request, input))),
    detail: t.procedure.input(overridesDetailInput).query(({ ctx, input }) => permissionOverridesRoute(ctx, (service, request) => service.detail(request, input))),
    save: t.procedure.input(overridesSaveInput).mutation(({ ctx, input }) => permissionOverridesRoute(ctx, (service, request) => service.save(request, input))),
  }),
});

export type AppRouter = typeof appRouter;
