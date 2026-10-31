#!/usr/bin/env node
/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Prepare a publishable folder for the public `foxschema` npm package.
 * The CLI build already inlines @foxschema/core + @foxschema/web; published
 * deps are only native drivers + CLI runtime libs (no private workspace pkgs).
 *
 * Usage (from repo root, after builds):
 *   node apps/cli/scripts/prepare-publish.mjs
 *   npm publish apps/cli/npm-pack
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(cliRoot, '..', '..');
const outDir = join(cliRoot, 'npm-pack');
const srcPkg = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8'));
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const webPkg = JSON.parse(
  readFileSync(resolve(cliRoot, '..', 'web', 'package.json'), 'utf8')
);

if (!existsSync(join(cliRoot, 'dist', 'index.js'))) {
  throw new Error('Missing apps/cli/dist — run `npm run build -w @foxschema/cli` first');
}
if (!existsSync(join(cliRoot, 'ui-dist', 'index.html'))) {
  throw new Error('Missing apps/cli/ui-dist — build @foxschema/web then rebuild the CLI');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(cliRoot, 'dist'), join(outDir, 'dist'), { recursive: true });
cpSync(join(cliRoot, 'ui-dist'), join(outDir, 'ui-dist'), { recursive: true });
const resourcesSrc = join(cliRoot, 'resources');
if (existsSync(resourcesSrc)) {
  cpSync(resourcesSrc, join(outDir, 'resources'), { recursive: true });
}

const readmeSrc = join(cliRoot, 'README.md');
if (existsSync(readmeSrc)) {
  cpSync(readmeSrc, join(outDir, 'README.md'));
} else {
  writeFileSync(
    join(outDir, 'README.md'),
    `# foxschema\n\nSee https://github.com/tedious-code/foxschema\n`
  );
}

for (const name of ['LICENSE', 'NOTICE']) {
  const src = join(repoRoot, name);
  if (existsSync(src)) cpSync(src, join(outDir, name));
}

// Tip for npm / editors: TypeScript origin + ESM entry (CLI is not a require()-able lib).
const typesStub = `/**
 * Fox Schema CLI — TypeScript declarations for the published \`foxschema\` package.
 * Runtime entry is ESM (\`dist/index.js\`, \`"type": "module"\`).
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
export {};
`;
writeFileSync(join(outDir, 'dist', 'index.d.ts'), typesStub);

const publishPkg = {
  name: 'foxschema',
  version: srcPkg.version,
  description:
    srcPkg.description ||
    'Fox Schema — schema diff, migration SQL, and a rich SQL Editor (TypeScript / Node ESM)',
  license: srcPkg.license || 'Apache-2.0',
  author: rootPkg.author || 'Huy Phan <huyplb@gmail.com>',
  homepage: 'https://foxschema.com',
  bugs: rootPkg.bugs || 'https://github.com/tedious-code/foxschema/issues',
  repository: {
    type: 'git',
    url: 'git+https://github.com/tedious-code/foxschema.git',
  },
  keywords: [
    'foxschema',
    'sql',
    'sql-editor',
    'schema',
    'migration',
    'diff',
    'typescript',
    'esm',
    'postgres',
    'mysql',
    'sqlserver',
    'oracle',
    'db2',
    'sqlite',
    'database',
  ],
  type: 'module',
  // Helps npm / IDEs show TypeScript + ESM (CLI bin is the primary entry).
  main: './dist/index.js',
  module: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
      default: './dist/index.js',
    },
  },
  engines: rootPkg.engines || { node: '>=22.5' },
  bin: srcPkg.bin,
  files: ['dist', 'ui-dist', 'resources', 'README.md', 'LICENSE', 'NOTICE'],
  dependencies: {
    '@napi-rs/keyring': srcPkg.dependencies['@napi-rs/keyring'],
    chalk: srcPkg.dependencies.chalk,
    commander: srcPkg.dependencies.commander,
    'env-paths': srcPkg.dependencies['env-paths'],
    '@inquirer/prompts': srcPkg.dependencies['@inquirer/prompts'],
    ink: srcPkg.dependencies.ink,
    'ink-select-input': srcPkg.dependencies['ink-select-input'],
    'ink-spinner': srcPkg.dependencies['ink-spinner'],
    'ink-text-input': srcPkg.dependencies['ink-text-input'],
    react: srcPkg.dependencies.react,
    pg: webPkg.dependencies.pg,
    mysql2: webPkg.dependencies.mysql2,
    mssql: webPkg.dependencies.mssql,
    oracledb: webPkg.dependencies.oracledb,
    'better-sqlite3': webPkg.dependencies['better-sqlite3'],
    '@clickhouse/client': webPkg.dependencies['@clickhouse/client'],
    '@duckdb/node-api': webPkg.dependencies['@duckdb/node-api'],
  },
  optionalDependencies: {
    ibm_db: webPkg.optionalDependencies?.ibm_db || '^4.1.0',
  },
  publishConfig: { access: 'public' },
};

writeFileSync(join(outDir, 'package.json'), JSON.stringify(publishPkg, null, 2) + '\n');
console.log(`✔ prepared ${outDir} (foxschema@${publishPkg.version})`);
console.log(`  type=module · types=dist/index.d.ts · keywords include typescript`);
