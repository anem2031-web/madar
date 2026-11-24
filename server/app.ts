import { join } from 'node:path';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { appRouter } from './trpc/router.ts';
import { createAuthService } from './modules/auth/service.ts';
import type { AuthStore } from './modules/auth/store.ts';
import { createUsersService } from './modules/users/service.ts';
import type { UsersStore } from './modules/users/store.ts';
import { createPermissionOverridesService } from './modules/permission-overrides/service.ts';
import type { PermissionOverridesStore } from './modules/permission-overrides/store.ts';
import { createOrganizationService } from './modules/organization/service.ts';
import type { OrganizationStore } from './modules/organization/store.ts';
import { registeredPagePaths } from '../shared/permissions/pages.ts';

type AppOptions = {
  clientDirectory?: string;
  pingDatabase?: () => Promise<void>;
  authStore?: AuthStore;
  authConfig?: { origin: string; secret: string };
  usersStore?: UsersStore;
  permissionOverridesStore?: PermissionOverridesStore;
  organizationStore?: OrganizationStore;
};

export function createApp({ clientDirectory, pingDatabase, authStore, authConfig, usersStore, permissionOverridesStore, organizationStore }: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  const secureCookies = authConfig?.origin.startsWith('https://') ?? false;
  const auth = authStore && authConfig ? createAuthService(authStore, authConfig) : undefined;
  const users = usersStore && auth ? createUsersService(usersStore, auth) : undefined;
  const permissionOverrides = permissionOverridesStore && auth ? createPermissionOverridesService(permissionOverridesStore, auth) : undefined;
  const organization = organizationStore && auth ? createOrganizationService(organizationStore, auth) : undefined;
  app.use((_request, response, next) => {
    response.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/health', async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      if (pingDatabase) {
        await pingDatabase();
        response.json({ status: 'ready' });
        return;
      }
    } catch {
      // Readiness reports a public status only.
    }
    response.status(503).json({ status: 'unavailable' });
  });

  app.use('/api', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/trpc', express.json({ limit: '8kb' }), createExpressMiddleware({ router: appRouter, allowBatching: false, createContext: ({ req, res }) => ({ req, res, auth, users, permissionOverrides, organization, secureCookies }) }));

  if (clientDirectory) {
    for (const path of ['/manifest.webmanifest', '/sw.js', '/offline.html']) {
      app.get(path, (_request, response) => {
        response.set('Cache-Control', 'no-cache');
        if (path === '/manifest.webmanifest') response.type('application/manifest+json');
        response.sendFile(join(clientDirectory, path.slice(1)), { cacheControl: false });
      });
    }
    app.use('/icons', express.static(join(clientDirectory, 'icons'), { maxAge: '1h', index: false }));
    app.use('/assets', express.static(join(clientDirectory, 'assets'), {
      immutable: true,
      maxAge: '1y',
      index: false,
    }));
    app.get([...registeredPagePaths], (_request, response) => {
      response.set('Cache-Control', 'no-cache');
      response.sendFile(join(clientDirectory, 'index.html'), { cacheControl: false });
    });
  }

  app.use((_request, response) => {
    response.set('Cache-Control', 'no-store').status(404).json({ code: 'NOT_FOUND' });
  });
  const handleError: ErrorRequestHandler = (_error, _request, response, next) => {
    if (response.headersSent) {
      next(new Error('Request failed.'));
      return;
    }
    response.set('Cache-Control', 'no-store').status(500).json({ code: 'INTERNAL_SERVER_ERROR' });
  };
  app.use(handleError);

  return app;
}
