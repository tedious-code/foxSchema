import { build } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const cliRoot = dirname(fileURLToPath(import.meta.url));

const DRIVER_EXTERNAL = [
  'ibm_db',
  'pg',
  'pg-native',
  'mysql2',
  'mssql',
  'oracledb',
  'better-sqlite3',
  '@clickhouse/client',
  '@duckdb/node-api',
  '@napi-rs/keyring',
];

// Bundle the CLI to a single ESM file. @foxschema/* TS sources are inlined;
// native drivers stay external (resolved from node_modules at runtime, like the
// desktop sidecar). The banner shims `require` for any bundled CJS deps.
//
// The tui/ subtree is deliberately NOT part of this bundle — src/index.ts's
// `tui` command loads it via a *computed* dynamic import (`new URL(...,
// import.meta.url)`), which esbuild can never inline (only literal-string
// import() targets get bundled). It's built as its own separate ESM file
// below instead, with Ink/React external there too: every tui/*.tsx screen
// statically `import {Box} from 'ink'`, and if those ever ended up inside a
// CJS-capable bundle, esbuild would turn each into a synchronous
// `require('ink')` — which breaks outright once Ink's own yoga-layout
// dependency (a top-level `await` in its ESM entry) is on the other end of
// that require. Keeping ink/react external and letting Node's own loader
// resolve them, in a real standalone ESM file, sidesteps that entirely — see
// build-binary.mjs's longer comment for how this bit us for real.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
  // esbuild keeps the source's `#!/usr/bin/env node`; the banner only shims
  // `require` for any bundled CJS deps.
  banner: {
    js: ['import { createRequire as ___cr } from "node:module";', 'const require = ___cr(import.meta.url);'].join('\n'),
  },
  external: DRIVER_EXTERNAL,
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
});

chmodSync('dist/index.js', 0o755);
console.log('✔ built dist/index.js');

// Detached UI server child process — bundles startUiServer + createApp.
await build({
  entryPoints: ['src/server/ui-server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/ui-server.js',
  banner: {
    js: ['import { createRequire as ___cr } from "node:module";', 'const require = ___cr(import.meta.url);'].join('\n'),
  },
  external: DRIVER_EXTERNAL,
  logLevel: 'info',
});
chmodSync('dist/ui-server.js', 0o755);
console.log('✔ built dist/ui-server.js');

// The tui/ sub-bundle — same source, separate output, ESM (tolerates
// yoga-layout's top-level await), Ink/React resolved from node_modules at
// runtime rather than bundled in.
await build({
  entryPoints: ['src/tui/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/tui/index.js',
  // Same native-driver exclusions as the main bundle above — tui/ pulls in
  // runtime/bootstrap.ts -> keyring.ts (@napi-rs/keyring) transitively, and
  // the DB providers via runtime/engine.ts, since both bundles share the same
  // runtime/ layer.
  external: [
    ...DRIVER_EXTERNAL,
    'ink',
    'ink-select-input',
    'ink-text-input',
    'ink-spinner',
    'react',
    'react-reconciler',
    'yoga-layout',
  ],
  logLevel: 'info',
});
console.log('✔ built dist/tui/index.js');

// Copy prebuilt web UI into the CLI package when available (npm publish / brew).
const webDist = resolve(cliRoot, '..', 'web', 'dist');
const uiOut = join(cliRoot, 'ui-dist');
if (existsSync(join(webDist, 'index.html'))) {
  rmSync(uiOut, { recursive: true, force: true });
  mkdirSync(uiOut, { recursive: true });
  // Not the .br/.gz copies: the CLI serves on loopback, where compression saves
  // nothing, and they would add ~7 MB to the package. The server falls back to
  // the plain files when there is no copy.
  cpSync(webDist, uiOut, { recursive: true, filter: (src) => !/\.(br|gz)$/.test(src) });
  console.log('✔ copied apps/web/dist → ui-dist');
} else {
  console.log('⚠ apps/web/dist missing — run `npm run build -w @foxschema/web` before publishing');
}

// Ensure icons ship with the package (Desktop shortcut command).
const iconsSrc = join(cliRoot, 'resources', 'icons');
if (existsSync(join(iconsSrc, 'icon.icns')) || existsSync(join(iconsSrc, 'icon.png'))) {
  console.log('✔ resources/icons present for desktop shortcut');
} else {
  console.log('⚠ resources/icons missing — `foxschema shortcut` needs the fox icon files');
}
