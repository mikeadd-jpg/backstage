// Entry point of the Remotion bundle that renders on Vercel Sandbox (lib/serverRender.js).
// `npm run build` bundles it into .remotion/ (scripts/bundle-remotion.mjs) before Next
// builds, and the renders route ships that folder to the sandbox. The browser builders
// never load this file: they render the same templates directly.
import { registerRoot } from 'remotion';
import { Root } from './Root.jsx';

registerRoot(Root);
