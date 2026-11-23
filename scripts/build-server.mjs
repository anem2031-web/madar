import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: 'dist/server/index.mjs',
});
