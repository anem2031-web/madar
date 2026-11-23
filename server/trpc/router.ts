import { initTRPC } from '@trpc/server';
import { AuthFault } from '../modules/auth/errors.ts';
import { authRoute } from '../modules/auth/routes.ts';
import type { AuthContext } from '../modules/auth/routes.ts';
import { loginInput, passwordInput } from '../modules/auth/validation.ts';

const t = initTRPC.context<AuthContext>().create({
  errorFormatter({ shape, error }) {
    return {
      code: shape.code,
      message: error.cause instanceof AuthFault ? error.cause.reason : shape.data.code,
      data: { code: shape.data.code, httpStatus: shape.data.httpStatus,
        ...(error.cause instanceof AuthFault && error.cause.requestId ? { requestId: error.cause.requestId } : {}),
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
});

export type AppRouter = typeof appRouter;
