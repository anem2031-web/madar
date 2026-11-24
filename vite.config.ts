import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { assertPageRegistry } from './shared/permissions/pages.ts';

// Fail the development/build configuration if a page has no valid access policy.
assertPageRegistry();

export default defineConfig({
  root: fileURLToPath(new URL('./client/', import.meta.url)),
  envDir: false,
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/client/', import.meta.url)),
    emptyOutDir: true,
  },
});
