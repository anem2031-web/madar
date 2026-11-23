import { createTRPCClient, httpLink } from '@trpc/client';
import type { AppRouter } from '../../../server/trpc/router.ts';

let csrfToken: string | undefined;

export function setCsrfToken(token?: string) {
  csrfToken = token;
}

export const trpc = createTRPCClient<AppRouter>({
  links: [httpLink({
    url: '/api/trpc',
    headers: () => csrfToken ? { 'x-madar-csrf': csrfToken } : {},
    fetch: (url, options) => fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store' }),
  })],
});
