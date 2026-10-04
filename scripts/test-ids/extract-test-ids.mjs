#!/usr/bin/env node
/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The test-ID catalog: every `data-testid` in the web app, as a tree
 * (area → component → ID), with what each control is.
 *
 *   node scripts/test-ids/extract-test-ids.mjs           print a summary
 *   node scripts/test-ids/extract-test-ids.mjs --write   regenerate the catalog
 *
 * It writes two files, never edited by hand:
 *   docs/testing/TEST_IDS.md              the tree people read
 *   apps/e2e/src/generated/test-ids.ts    the same tree, typed, for Playwright
 *
 * It also counts the buttons, text boxes, selects and textareas that have no
 * test ID; `packages/shared/src/test-id-catalog.test.ts` keeps that number
 * from going up, and fails when the catalog files are stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ts = createRequire(path.join(REPO_ROOT, 'package.json'))('typescript');

export const WEB_ROOT = 'apps/web/src/frontend';
export const MARKDOWN_PATH = 'docs/testing/TEST_IDS.md';
export const TYPESCRIPT_PATH = 'apps/e2e/src/generated/test-ids.ts';

/** Controls a person clicks or types into: each should carry a test ID. */
const CONTROLS = new Set(['button', 'input', 'textarea', 'select']);

/** Every component file under the web app, tests left out, in a stable order. */
function componentFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(rel);
    }
  };
  walk(WEB_ROOT);
  return out.sort();
}

/** `features/git/components/X.tsx` → area `git`; `app/…` → `app`; `shared/…` → `shared`. */
function areaOf(file) {
  const parts = file.slice(WEB_ROOT.length + 1).split('/');
  return parts[0] === 'features' ? parts[1] : parts[0];
}

const attr = (node, name) =>
  node.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === name);

/** A string literal attribute value, or ''. */
function literalValue(a) {
  const init = a?.initializer;
  if (!init) return '';
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)) return init.expression.text;
  return '';
}

/** A readable parameter name for a `${…}` in a template ID. */
function paramName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isCallExpression(expr)) return paramName(expr.expression);
  if (ts.isElementAccessExpression(expr)) return paramName(expr.expression);
  return 'value';
}

/**
 * The IDs an attribute value can produce: `'a'`, `{'a'}`, `{c ? 'a' : 'b'}`,
 * or a template (`{`git-run-${m.fileName}`}`) as a pattern with parameters.
 * Anything else (`{testId}`, passed in from a parent) is `fromProps`.
 */
function idsOf(init) {
  if (!init) return [];
  if (ts.isStringLiteral(init)) return [{ pattern: init.text, params: [] }];
  const expr = ts.isJsxExpression(init) ? init.expression : undefined;
  if (!expr) return [];
  const visit = (e) => {
    if (ts.isParenthesizedExpression(e)) return visit(e.expression);
    if (ts.isStringLiteralLike(e)) return [{ pattern: e.text, params: [] }];
    if (ts.isConditionalExpression(e)) return [...visit(e.whenTrue), ...visit(e.whenFalse)];
    if (ts.isTemplateExpression(e)) {
      const params = [];
      let pattern = e.head.text;
      for (const span of e.templateSpans) {
        let name = paramName(span.expression);
        while (params.includes(name)) name = `${name}${params.length + 1}`;
        params.push(name);
        pattern += `{${name}}${span.literal.text}`;
      }
      return [{ pattern, params }];
    }
    return [{ pattern: `{${e.getText()}}`, params: [], fromProps: true }];
  };
  return visit(expr);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e) => ENTITIES[e]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'legend']);

/** The words inside a JSX element: its text and string literals, nested elements included. */
function textOf(element) {
  const words = [];
  const collect = (n) => {
    if (ts.isJsxText(n)) words.push(n.text);
    else if (ts.isJsxExpression(n) && n.expression && ts.isStringLiteralLike(n.expression)) words.push(n.expression.text);
    else if (ts.isJsxElement(n)) n.children.forEach(collect);
  };
  element.children.forEach(collect);
  return decode(words.join(' ')).replace(/\s+/g, ' ').trim();
}

/** The first heading inside a container, which names it better than all its text. */
function headingOf(element) {
  let found = '';
  const visit = (n) => {
    if (found) return;
    if (ts.isJsxElement(n) && HEADINGS.has(n.openingElement.tagName.getText())) found = textOf(n);
    else ts.forEachChild(n, visit);
  };
  element.children.forEach(visit);
  return found;
}

/**
 * What an element says about itself: its aria-label, title or placeholder;
 * for a control its own text, or the label pointing at it; for a container
 * the first heading inside it.
 */
function describe(node, labels) {
  for (const name of ['aria-label', 'title', 'placeholder']) {
    const v = literalValue(attr(node, name));
    if (v) return decode(v);
  }
  const element = ts.isJsxOpeningElement(node) ? node.parent : undefined;
  if (element && ts.isJsxElement(element)) {
    const text = CONTROLS.has(node.tagName.getText()) ? textOf(element) : headingOf(element);
    if (text) return text.length > 70 ? `${text.slice(0, 67)}…` : text;
  }
  const id = literalValue(attr(node, 'id'));
  return (id && labels.get(id)) || '';
}

/** `<label htmlFor="x">Note</label>` → x → Note, for inputs described by a label elsewhere. */
function labelsOf(source) {
  const labels = new Map();
  const visit = (n) => {
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'label') {
      const forId = literalValue(attr(n.openingElement, 'htmlFor'));
      const text = textOf(n);
      if (forId && text) labels.set(forId, text);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return labels;
}

/** Read the web app: every test ID, and every control without one. */
export function collectTestIds(root = REPO_ROOT) {
  const entries = [];
  const missing = [];
  for (const file of componentFiles(root)) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const labels = labelsOf(source);
    const component = path.basename(file, '.tsx');
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const element = node.tagName.getText();
        const idAttr = attr(node, 'data-testid');
        const spread = node.attributes.properties.some((a) => ts.isJsxSpreadAttribute(a));
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (idAttr) {
          const description = describe(node, labels);
          for (const id of idsOf(idAttr.initializer)) {
            entries.push({ ...id, area: areaOf(file), component, file: file.slice(WEB_ROOT.length + 1), line, element, description });
          }
        } else if (!spread && CONTROLS.has(element) && !(element === 'input' && /hidden/.test(literalValue(attr(node, 'type'))))) {
          missing.push({ file: file.slice(WEB_ROOT.length + 1), line, element, description: describe(node, labels) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { entries, missing };
}

/**
 * Static IDs rendered by more than one component file: a selector cannot tell
 * them apart. Repeats within one file are usually alternative branches (loading
 * and loaded) of which only one is on screen, so they are not listed.
 */
export function duplicates({ entries }) {
  const seen = new Map();
  for (const e of entries) {
    if (e.params.length || e.fromProps) continue;
    const at = `${e.file}:${e.line}`;
    seen.set(e.pattern, [...(seen.get(e.pattern) ?? []), at]);
  }
  return [...seen].filter(([, at]) => new Set(at.map((a) => a.split(':')[0])).size > 1).sort(([a], [b]) => a.localeCompare(b));
}

/** Controls (not containers) that carry a test ID, each counted once. */
export function controlsWithId({ entries }) {
  return new Set(entries.filter((e) => CONTROLS.has(e.element)).map((e) => `${e.file}:${e.line}`)).size;
}

/** area → component → entries, every level sorted, one entry per pattern. */
function tree({ entries }) {
  const areas = new Map();
  for (const e of entries) {
    if (!areas.has(e.area)) areas.set(e.area, new Map());
    const components = areas.get(e.area);
    if (!components.has(e.component)) components.set(e.component, { file: e.file, ids: new Map() });
    const ids = components.get(e.component).ids;
    if (!ids.has(e.pattern)) ids.set(e.pattern, e);
  }
  return [...areas]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([area, components]) => ({
      area,
      components: [...components]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, c]) => ({ name, file: c.file, ids: [...c.ids.values()].sort((a, b) => a.pattern.localeCompare(b.pattern)) })),
    }));
}

const md = (s) => s.replace(/\|/g, '\\|').replace(/</g, '&lt;');

export function renderMarkdown(catalog) {
  const controls = controlsWithId(catalog);
  const total = controls + catalog.missing.length;
  const dupes = duplicates(catalog);
  const lines = [
    '# Test IDs',
    '',
    '<!-- Generated by scripts/test-ids/extract-test-ids.mjs. Do not edit: run `npm run test-ids`. -->',
    '',
    'Every `data-testid` in the web app, by area and component. In Playwright, use',
    '`page.getByTestId(...)` with the ID, or `TestIds` from `apps/e2e/src/generated/test-ids.ts`',
    'for the same tree with autocomplete. `{name}` marks a part filled in at run time.',
    '',
    `Controls with a test ID: **${controls} of ${total}** (${((controls / total) * 100).toFixed(1)}%). ` +
      `Without one: ${catalog.missing.length}, listed at the end.`,
    '',
  ];
  for (const { area, components } of tree(catalog)) {
    lines.push(`## ${area}`, '');
    for (const c of components) {
      lines.push(`- **${c.name}** · \`${c.file}\``);
      for (const e of c.ids) {
        const what = [e.element, e.description && md(e.description), e.fromProps && 'passed in by the parent'].filter(Boolean).join(' · ');
        lines.push(`  - \`${e.pattern}\` · ${what}`);
      }
    }
    lines.push('');
  }
  if (dupes.length) {
    lines.push('## Used in more than one place', '', 'A selector finds the first; give each its own ID.', '');
    for (const [id, at] of dupes) lines.push(`- \`${id}\`: ${at.map((a) => `\`${a}\``).join(', ')}`);
    lines.push('');
  }
  lines.push('## Controls without a test ID', '');
  const byFile = new Map();
  for (const m of catalog.missing) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
  for (const [file, list] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- \`${file}\``);
    for (const m of list) lines.push(`  - line ${m.line} · ${m.element}${m.description ? ` · ${md(m.description)}` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

const camel = (s) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^[A-Z]/, (c) => c.toLowerCase());
/** A string literal in the repo's style: single quotes. */
const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const safeKey = (s) => (/^[A-Za-z_$][\w$]*$/.test(s) ? s : quote(s));
const templateText = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

export function renderTypeScript(catalog) {
  const lines = [
    '/**',
    ' * Generated by scripts/test-ids/extract-test-ids.mjs. Do not edit: run `npm run test-ids`.',
    ' *',
    ' * Every data-testid in the web app, by area and component:',
    ' *   page.getByTestId(TestIds.git.CommitMigrationDialog.gitCommitPush)',
    ' * An ID built at run time is a function of its parts. See docs/testing/TEST_IDS.md.',
    ' */',
    'export const TestIds = {',
  ];
  for (const { area, components } of tree(catalog)) {
    lines.push(`  ${safeKey(camel(area))}: {`);
    for (const c of components) {
      const ids = c.ids.filter((e) => !e.fromProps);
      if (!ids.length) continue;
      lines.push(`    ${safeKey(c.name)}: {`);
      const used = new Set();
      for (const e of ids) {
        let key = camel(e.pattern.replace(/\{[^}]*\}/g, '-')) || 'id';
        if (/^[0-9]/.test(key)) key = `id${key}`;
        // `admin-git-activity` and `admin-git-activity-{id}` → adminGitActivity, adminGitActivityForId.
        if (used.has(key) && e.params.length) key += `For${e.params.map((p) => p[0].toUpperCase() + p.slice(1)).join('And')}`;
        for (let n = 2; used.has(key); n++) key = key.replace(/\d*$/, String(n));
        used.add(key);
        const doc = [e.element, e.description].filter(Boolean).join(' · ').replace(/\*\//g, '* /');
        lines.push(`      /** ${doc} */`);
        if (e.params.length) {
          const body = e.pattern.split(/(\{[^}]*\})/).map((part) => (/^\{.*\}$/.test(part) ? `\${${part.slice(1, -1)}}` : templateText(part))).join('');
          lines.push(`      ${safeKey(key)}: (${e.params.map((p) => `${p}: string | number`).join(', ')}) => \`${body}\`,`);
        } else {
          lines.push(`      ${safeKey(key)}: ${quote(e.pattern)},`);
        }
      }
      lines.push('    },');
    }
    lines.push('  },');
  }
  lines.push('} as const;', '');
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const catalog = collectTestIds();
  if (process.argv.includes('--write')) {
    for (const [rel, text] of [
      [MARKDOWN_PATH, renderMarkdown(catalog)],
      [TYPESCRIPT_PATH, renderTypeScript(catalog)],
    ]) {
      fs.mkdirSync(path.dirname(path.join(REPO_ROOT, rel)), { recursive: true });
      fs.writeFileSync(path.join(REPO_ROOT, rel), text);
      console.log(`wrote ${rel}`);
    }
  }
  const controls = controlsWithId(catalog);
  console.log(`${catalog.entries.length} test IDs; controls with an ID ${controls}, without ${catalog.missing.length}; ${duplicates(catalog).length} used in more than one place`);
}
