#!/usr/bin/env node
/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builds docs/feature-map.html, the interactive feature map, from:
 *
 *   docs/feature-map/template.html   page layout and styles; __M<n>__ marks where diagram n goes
 *   docs/feature-map/data.js         the inventory: features, routes, tables, engines, tests
 *   docs/feature-map/app.js          the page's script
 *   docs/FEATURE_MAP.md              the Mermaid diagrams, in the order they appear there
 *
 * Usage:
 *   node scripts/feature-map/build.mjs                  write docs/feature-map.html
 *   node scripts/feature-map/build.mjs --board <file>   also write the planning-board page
 *
 * The repo copy is a whole document with no shared board, and it loads Mermaid
 * from a pinned CDN. The board page is the same page with the board turned on.
 * It is published as an Artifact, which adds the document skeleton itself.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'docs/feature-map');
const read = (p) => readFileSync(p, 'utf8');

/** HTML text escaping for a <pre>, leaving quotes alone. */
const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The page with the board: every placeholder filled. */
export function buildBoardPage({ template, data, app, featureMap }) {
  const blocks = [...featureMap.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  // The page shows most of the doc's diagrams, not all: a placeholder past the
  // doc's last diagram means one was removed or the template drifted.
  for (const [, n] of template.matchAll(/__M(\d+)__/g)) {
    if (Number(n) >= blocks.length) {
      throw new Error(`template.html places diagram ${n}; FEATURE_MAP.md has only ${blocks.length}`);
    }
  }
  // Functions as replacements, so a `$` in the source is never read as a pattern.
  let page = template.replace(/__M(\d+)__/g, (_, n) => escapeText(blocks[Number(n)]));
  page = page.replace('/*__DATA__*/', () => data);
  page = page.replace('/*__APP__*/', () => app);
  return page;
}

/** The copy kept in the repo: a whole document, no shared board, Mermaid from a pinned CDN. */
export function buildStaticPage(boardPage) {
  const cut = boardPage.indexOf('<header class="top">');
  if (cut < 0) throw new Error('template.html has no <header class="top">');
  const head = boardPage.slice(0, cut);
  const body = boardPage.slice(cut);
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    '<!-- Generated from docs/FEATURE_MAP.md and the feature inventory. The live planning board is a shared page;\n' +
    '     this copy shows the map, workflows, schema, engines and coverage. Open it in a browser. -->\n' +
    '<style>body{margin:0}[hidden]{display:none!important}</style>\n' +
    head +
    '</head>\n<body>\n<script>window.FOX_MAP_STATIC = true;</script>\n' +
    body +
    '\n<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>\n' +
    '<script>\n  if (window.mermaid) {\n' +
    "    mermaid.initialize({ startOnLoad: false, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });\n" +
    "    mermaid.run({ querySelector: 'pre.mermaid' });\n  }\n</script>\n</body>\n</html>\n"
  );
}

export function readSources(root = ROOT) {
  const src = path.join(root, 'docs/feature-map');
  return {
    template: read(path.join(src, 'template.html')),
    data: read(path.join(src, 'data.js')),
    app: read(path.join(src, 'app.js')),
    featureMap: read(path.join(root, 'docs/FEATURE_MAP.md')),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const board = buildBoardPage(readSources());
  writeFileSync(path.join(ROOT, 'docs/feature-map.html'), buildStaticPage(board));
  console.log(`wrote docs/feature-map.html (from ${path.relative(ROOT, SRC)}/)`);
  const at = process.argv.indexOf('--board');
  if (at > 0) {
    const out = process.argv[at + 1];
    if (!out) throw new Error('--board needs a file path');
    writeFileSync(out, board);
    console.log(`wrote ${out}`);
  }
}
