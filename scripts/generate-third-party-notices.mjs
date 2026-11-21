/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Collect the licence notices of the packages we ship.
 *
 * MIT, BSD and ISC all carry the same condition: the copyright and permission
 * notice must travel with copies of the software. Bundling a dependency into
 * the client and shipping only our own NOTICE does not satisfy that — the
 * obligation is ours the moment we distribute their code inside ours.
 *
 * Run: node scripts/generate-third-party-notices.mjs
 */
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MODULES = join(ROOT, 'node_modules');
const OUT = join(ROOT, 'THIRD-PARTY-NOTICES.md');

/** Manifests whose runtime dependencies end up in something we distribute. */
const SHIPPED = [
  'apps/web/package.json',
  'apps/cli/package.json',
  'packages/sql/package.json',
  'packages/db/package.json',
  'packages/db-db2/package.json',
];

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license', 'License'];

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Direct runtime dependencies of everything we publish. */
async function shippedPackageNames() {
  const names = new Set();
  for (const manifest of SHIPPED) {
    const pkg = await readJson(join(ROOT, manifest));
    if (!pkg) continue;
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        // Our own packages are covered by the repo's own LICENSE.
        if (!name.startsWith('@foxschema/')) names.add(name);
      }
    }
  }
  return [...names].sort();
}

async function licenseTextFor(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const candidate of LICENSE_FILES) {
    if (!entries.includes(candidate)) continue;
    const path = join(dir, candidate);
    if (!(await stat(path)).isFile()) continue;
    return (await readFile(path, 'utf8')).trim();
  }
  return null;
}

const names = await shippedPackageNames();
const sections = [];
const missing = [];

for (const name of names) {
  const dir = join(MODULES, name);
  const pkg = await readJson(join(dir, 'package.json'));
  if (!pkg) {
    missing.push(`${name} (not installed)`);
    continue;
  }
  const text = await licenseTextFor(dir);
  const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'UNKNOWN');
  if (!text) missing.push(`${name} (${license} — no licence file in the package)`);
  sections.push(
    [
      `## ${name} ${pkg.version ?? ''}`.trim(),
      '',
      `License: ${license}${pkg.homepage ? ` · ${pkg.homepage}` : ''}`,
      '',
      text ? '```\n' + text + '\n```' : '_No licence file shipped in the package; see the project page above._',
    ].join('\n')
  );
}

const header = `# Third-party notices

Fox Schema is distributed with the open-source packages listed here. Each entry
reproduces that package's own licence, as those licences require when their code
is distributed inside another product.

Fox Schema's own licence is Apache-2.0 — see \`LICENSE\` and \`NOTICE\`.

Regenerate with \`node scripts/generate-third-party-notices.mjs\`.

${names.length} package${names.length === 1 ? '' : 's'}.
`;

await writeFile(OUT, [header, ...sections].join('\n\n---\n\n') + '\n', 'utf8');
console.log(`Wrote ${OUT} — ${sections.length} packages.`);
if (missing.length > 0) {
  console.log('\nNo licence text found for:');
  for (const m of missing) console.log('  -', m);
}
