// Bundles remotion/index.jsx into .remotion/ for the server renders (lib/serverRender.js).
// Runs before `next build` (see package.json), so every deploy ships the bundle that
// matches its own templates; next.config.js traces the folder into /api/renders.
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { bundle } from '@remotion/bundler';

const outDir = path.resolve('.remotion');
await rm(outDir, { recursive: true, force: true });
const started = Date.now();
await bundle({ entryPoint: path.resolve('remotion/index.jsx'), outDir, enableCaching: false,
  // No source maps: they doubled the folder the route ships to every sandbox.
  webpackOverride: (config) => ({ ...config, devtool: false }) });
console.log('Remotion bundle written to .remotion in ' + Math.round((Date.now() - started) / 1000) + 's');
