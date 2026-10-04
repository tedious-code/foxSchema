#!/usr/bin/env node
/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * An MCP server (stdio) over the test-ID catalog, so an agent writing a
 * Playwright test can find the right IDs instead of guessing selectors.
 *
 *   tools      find_test_id(query)            "push button in the commit dialog" → git-commit-push
 *              describe_screen(component)     every ID one component draws
 *              scaffold_test(component, flow) a test file built on byTestId()
 *   resource   test-ids://catalog             docs/testing/TEST_IDS.md, current
 *
 * Registered for Claude Code in .mcp.json. It reads the web app's source on
 * each call (cached for a few seconds), so it is never staler than the code.
 * No SDK: MCP over stdio is newline-delimited JSON-RPC, a few methods.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, collectTestIds, renderMarkdown, usableIds } from './extract-test-ids.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CATALOG_URI = 'test-ids://catalog';

let cached;
/** The catalog, read again when the last read is more than a few seconds old. */
function catalog() {
  if (!cached || Date.now() - cached.at > 5_000) cached = { at: Date.now(), value: collectTestIds() };
  return cached.value;
}

// ── Search ─────────────────────────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'in', 'on', 'of', 'to', 'for', 'with', 'and', 'that', 'this', 'which', 'id', 'test']);
const SYNONYMS = {
  textbox: 'input', field: 'input', box: 'input', text: 'input',
  dropdown: 'select', picker: 'select', combo: 'select',
  checkbox: 'input', toggle: 'button', link: 'button',
  dialog: 'modal', modal: 'dialog', panel: 'pane', pane: 'panel',
  remove: 'delete', delete: 'remove', close: 'cancel',
};
const wordsOf = (s) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** How well an entry answers the query's words: its ID counts most, then its words on screen and component. */
function score(entry, words) {
  const id = new Set(wordsOf(entry.pattern.replace(/\{[^}]*\}/g, ' ')));
  const said = new Set(wordsOf(entry.description ?? ''));
  const where = new Set([...wordsOf(entry.component), ...wordsOf(entry.area)]);
  const element = entry.element.toLowerCase();
  let total = 0;
  for (const w of words) {
    const alt = SYNONYMS[w];
    const hit = (set) => set.has(w) || (alt && set.has(alt)) || [...set].some((x) => x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x)));
    total += (hit(id) ? 3 : 0) + (hit(said) ? 2 : 0) + (hit(where) ? 2 : 0) + (w === element || alt === element ? 1 : 0);
  }
  return total;
}

/** IDs a test can use, best match first, one per ID and component. */
export function findTestIds(cat, query, limit = 10) {
  const words = wordsOf(query).filter((w) => !STOP.has(w));
  if (!words.length) return [];
  const seen = new Set();
  return usableIds(cat)
    .map((e) => ({ e, s: score(e, words) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s || a.e.pattern.localeCompare(b.e.pattern))
    .map(({ e }) => e)
    .filter((e) => {
      const key = `${e.component}\u0000${e.pattern}`;
      return !seen.has(key) && seen.add(key);
    })
    .slice(0, limit);
}

const line = (e) =>
  `- \`${e.pattern}\` · ${e.via ? `${e.element} in ${e.via}` : e.element}${e.description ? ` · ${e.description}` : ''} · ${e.component} (${e.file}:${e.line})`;

/** The components a name refers to: exact (any case) first, else every one containing it. */
function componentsNamed(cat, name) {
  const all = [...new Set(usableIds(cat).map((e) => e.component))];
  const lower = name.toLowerCase().replace(/\.tsx$/, '').split('/').pop();
  const exact = all.filter((c) => c.toLowerCase() === lower);
  return exact.length ? exact : all.filter((c) => c.toLowerCase().includes(lower)).sort();
}

export function describeScreen(cat, name) {
  const components = componentsNamed(cat, name);
  if (!components.length) return `No component matches "${name}". Try find_test_id with words from the screen.`;
  return components
    .slice(0, 5)
    .map((c) => {
      const ids = usableIds(cat)
        .filter((e) => e.component === c)
        .sort((a, b) => a.pattern.localeCompare(b.pattern));
      const unique = ids.filter((e, i) => i === 0 || e.pattern !== ids[i - 1].pattern);
      return [`## ${c} · \`apps/web/src/frontend/${ids[0].file}\``, '', ...unique.map(line)].join('\n');
    })
    .join('\n\n');
}

// ── Scaffold ───────────────────────────────────────────────────────────────

/** The page object a test of this area starts from. */
const PAGE_OBJECTS = {
  'sql-editor': 'SqlEditorPage', utilities: 'SqlEditorPage', 'lokee-weave': 'LokeeHistoryPage',
  access: 'AccessPage', workflow: 'WorkflowPage', connections: 'ConnectionModal',
  git: 'MigrationPage', migrations: 'MigrationPage', 'object-detail': 'MigrationPage',
};

/** The public steps a page object already has, so a test reuses them. */
function pageObjectMethods(name) {
  const file = path.join(REPO_ROOT, 'apps/e2e/src/pages', `${name}.ts`);
  if (!fs.existsSync(file)) return [];
  return [...fs.readFileSync(file, 'utf8').matchAll(/^ {2}async (\w+)\(([^)]*)\)/gm)].map((m) => `${m[1]}(${m[2].replace(/\s+/g, ' ')})`);
}

const quoteTs = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
/** A run-time part as a local name that does not shadow the test's own (`page`, `driver`…). */
const local = (p) => (['page', 'driver', 'expect', 'describe', 'it', 'byTestId'].includes(p) ? `${p}Value` : p);

/** One statement that uses a control, by what it is. */
function step(e) {
  const at = e.params.length
    ? `byTestId(\`${e.pattern.replace(/\{([^}]*)\}/g, (_, p) => `\${${local(p)}}`)}\`)`
    : `byTestId(${quoteTs(e.pattern)})`;
  const loc = `driver.locator(${at})`;
  const act =
    e.element === 'input' || e.element === 'textarea'
      ? `await ${loc}.fill('');`
      : e.element === 'select'
        ? `await ${loc}.selectOption('');`
        : e.element === 'button' || e.element === 'a'
          ? `await ${loc}.click();`
          : `expect(await ${loc}.isVisible()).toBe(true);`;
  const what = [e.element, e.description].filter(Boolean).join(' · ');
  return { code: act, comment: what, runtime: e.params.length > 0 };
}

/**
 * A test file for one component. The controls the flow's words point at come
 * first and are live; the screen's other controls follow, commented out, so
 * the file compiles and the author deletes what the flow does not need.
 */
export function scaffoldTest(cat, { component, flow = '' }) {
  const [name] = componentsNamed(cat, component);
  if (!name) return `No component matches "${component}". Try find_test_id with words from the screen.`;
  const ids = usableIds(cat).filter((e) => e.component === name);
  const unique = ids.filter((e, i, all) => all.findIndex((x) => x.pattern === e.pattern) === i);
  const ranked = flow ? findTestIds({ entries: unique, missing: [] }, flow, unique.length) : [];
  const rest = unique.filter((e) => !ranked.includes(e)).sort((a, b) => a.pattern.localeCompare(b.pattern));
  const pageObject = PAGE_OBJECTS[ids[0].area];
  const title = flow.trim() || `${name} works`;
  const body = [];
  if (pageObject) {
    body.push(`    const page = new ${pageObject}(driver);`, `    // Get to the screen with ${pageObject}: ${pageObjectMethods(pageObject).slice(0, 8).join(', ') || 'see apps/e2e/src/pages'}.`);
  } else {
    body.push('    // Get to the screen first (apps/e2e/src/pages has a page object per area).');
  }
  const params = new Set();
  for (const e of ranked) {
    const s = step(e);
    e.params.forEach((p) => params.add(local(p)));
    body.push(`    ${s.code} // ${s.comment}`);
  }
  if (rest.length) {
    body.push('', `    // Other controls on ${name}:`);
    for (const e of rest) {
      const s = step(e);
      body.push(`    // ${s.code} // ${s.comment}`);
    }
  }
  const declared = [...params].map((p) => `    const ${p} = ''; // the ${p} this test uses`);
  return [
    '/**',
    ` * ${title}`,
    ' *',
    ' * Scaffolded from the test-ID catalog (docs/testing/WRITING_E2E.md).',
    ' */',
    "import { afterAll, beforeAll, describe, expect, it } from 'vitest';",
    "import type { Page } from 'playwright';",
    "import { buildDriver, quitDriver } from '../helpers/driver.js';",
    "import { byTestId } from '../helpers/test-ids.js';",
    ...(pageObject ? [`import { ${pageObject} } from '../pages/${pageObject}.js';`] : []),
    '',
    'let driver: Page;',
    'beforeAll(async () => {',
    '  driver = await buildDriver();',
    '});',
    'afterAll(async () => {',
    '  await quitDriver(driver);',
    '});',
    '',
    `describe(${quoteTs(name)}, () => {`,
    `  it(${quoteTs(title)}, async () => {`,
    ...declared,
    ...body,
    '  });',
    '});',
    '',
  ].join('\n');
}

// ── MCP ────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'find_test_id',
    description:
      'Find data-testid values in the FoxSchema web app by what a control is or says, e.g. "push button in the commit dialog". Returns IDs best match first, with element, on-screen text, component and file.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words describing the control or screen.' },
        limit: { type: 'number', description: 'Most results to return (default 10).' },
      },
      required: ['query'],
    },
    run: (args) => {
      const found = findTestIds(catalog(), String(args.query ?? ''), Number(args.limit) || 10);
      return found.length ? found.map(line).join('\n') : `Nothing matches "${args.query}".`;
    },
  },
  {
    name: 'describe_screen',
    description: 'Every test ID one web-app component draws (a dialog, panel or page), e.g. "CommitMigrationDialog". Accepts part of a name.',
    inputSchema: {
      type: 'object',
      properties: { component: { type: 'string', description: 'Component name or part of it.' } },
      required: ['component'],
    },
    run: (args) => describeScreen(catalog(), String(args.component ?? '')),
  },
  {
    name: 'scaffold_test',
    description:
      'A Playwright e2e test file (apps/e2e/src/tests) for one component, built on byTestId() and the page object for its area. Controls the flow words point at are live steps; the rest are listed commented out.',
    inputSchema: {
      type: 'object',
      properties: {
        component: { type: 'string', description: 'Component name or part of it.' },
        flow: { type: 'string', description: 'What the test does, in words, e.g. "write a note and commit and push".' },
      },
      required: ['component'],
    },
    run: (args) => scaffoldTest(catalog(), { component: String(args.component ?? ''), flow: String(args.flow ?? '') }),
  },
];

/** One JSON-RPC message in, its response out (null for a notification). */
export function handleMessage(msg) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return null;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'foxschema-test-ids', version: '1.0.0' },
        instructions: 'Find data-testid values for FoxSchema Playwright tests. Use byTestId() from apps/e2e/src/helpers/test-ids.ts with them.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ run: _run, ...tool }) => tool) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
      try {
        return reply({ content: [{ type: 'text', text: tool.run(msg.params.arguments ?? {}) }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true });
      }
    }
    case 'resources/list':
      return reply({
        resources: [{ uri: CATALOG_URI, name: 'Test-ID catalog', description: 'Every data-testid in the web app, by area and component.', mimeType: 'text/markdown' }],
      });
    case 'resources/read':
      if (msg.params?.uri !== CATALOG_URI) return fail(-32602, `Unknown resource: ${msg.params?.uri}`);
      return reply({ contents: [{ uri: CATALOG_URI, mimeType: 'text/markdown', text: renderMarkdown(catalog()) }] });
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const send = (out) => out && process.stdout.write(`${JSON.stringify(out)}\n`);
  readline.createInterface({ input: process.stdin }).on('line', (text) => {
    if (!text.trim()) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    for (const one of Array.isArray(msg) ? msg : [msg]) send(handleMessage(one));
  });
}
