import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Resolve the Vite UI build directory for the browser launcher.
 * Order: FOXSCHEMA_STATIC_DIR / STATIC_DIR → packaged ui-dist → monorepo apps/web/dist.
 */
export function resolveStaticDir(): string {
  const fromEnv = process.env.FOXSCHEMA_STATIC_DIR || process.env.STATIC_DIR;
  if (fromEnv && existsSync(join(fromEnv, 'index.html'))) return resolve(fromEnv);

  // Published package: apps/cli/ui-dist next to package root / dist/
  const packaged = [
    join(here, '..', 'ui-dist'), // dist/../ui-dist when running from dist/
    join(here, '..', '..', 'ui-dist'), // src/runtime → ../../ui-dist
  ];
  for (const candidate of packaged) {
    if (existsSync(join(candidate, 'index.html'))) return resolve(candidate);
  }

  // Monorepo checkout: apps/web/dist
  try {
    const webPkg = require.resolve('@foxschema/web/package.json');
    const webDist = join(dirname(webPkg), 'dist');
    if (existsSync(join(webDist, 'index.html'))) return webDist;
  } catch {
    /* workspace package may not expose package.json export */
  }

  const monorepoDist = resolve(here, '..', '..', '..', 'web', 'dist');
  if (existsSync(join(monorepoDist, 'index.html'))) return monorepoDist;

  throw new Error(
    'Frontend build not found. Run `npm run build -w @foxschema/web` first, ' +
      'or set FOXSCHEMA_STATIC_DIR to the Vite dist directory.'
  );
}

/**
 * Path to the detached UI server entry (built `dist/ui-server.js` or TS source via tsx).
 */
export function resolveUiServerEntry(): { command: string; args: string[] } {
  const built = resolve(here, '..', 'ui-server.js'); // when running from dist/
  const builtAlt = resolve(here, 'ui-server.js');
  for (const p of [built, builtAlt]) {
    if (existsSync(p)) return { command: process.execPath, args: [p] };
  }

  // Dev: tsx runs the TypeScript entry next to this file's package src
  const tsEntry = resolve(here, '..', 'server', 'ui-server.ts');
  if (existsSync(tsEntry)) {
    const tsx = resolve(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
    if (existsSync(tsx)) return { command: process.execPath, args: [tsx, tsEntry] };
    return { command: 'npx', args: ['tsx', tsEntry] };
  }

  // Fallback: web serve.ts via tsx (monorepo)
  try {
    const webPkg = dirname(require.resolve('@foxschema/web/package.json'));
    const serveTs = join(webPkg, 'src', 'serve.ts');
    if (existsSync(serveTs)) {
      const tsx = resolve(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
      if (existsSync(tsx)) return { command: process.execPath, args: [tsx, serveTs] };
      return { command: 'npx', args: ['tsx', serveTs] };
    }
  } catch {
    /* ignore */
  }

  throw new Error('UI server entry not found. Run `npm run build -w @foxschema/cli` first.');
}
