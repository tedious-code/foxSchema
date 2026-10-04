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
 * It also lists the buttons, text boxes, selects and textareas that have no
 * test ID; `packages/shared/src/test-id-catalog.test.ts` fails on any of them,
 * on a static ID two components use, and on stale catalog files.
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
 * What a file declares that an ID can be built from: its constants
 * (`const savedTestId = side === 'source' ? … : …`, `const NAV_TEST_IDS = {…}`)
 * and its one-line helpers (`const part = (name) => `${testId}-${name}``).
 * A name declared twice is left out: which one an ID uses is not knowable here.
 */
function declarationsOf(source) {
  const consts = new Map();
  const fns = new Map();
  const seen = new Set();
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isVariableDeclarationList(n.parent) && n.parent.flags & ts.NodeFlags.Const) {
      const name = n.name.text;
      const init = n.initializer;
      const fn = ts.isArrowFunction(init) && !ts.isBlock(init.body) && init.parameters.every((p) => ts.isIdentifier(p.name));
      if (seen.has(name)) {
        consts.delete(name);
        fns.delete(name);
      } else if (fn) fns.set(name, init);
      else consts.set(name, init);
      seen.add(name);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return { consts, fns };
}

/** `{a}-x-{a}` → `{a}-x-{a2}`: each part of a pattern gets its own name. */
function uniqueParams({ pattern, params, ...rest }) {
  const names = [];
  let i = 0;
  const renamed = pattern.replace(/\{([^}]*)\}/g, (whole, inner) => {
    if (params[i] !== inner) return whole;
    let name = inner;
    for (let n = 2; names.includes(name); n++) name = `${inner}${n}`;
    names.push(name);
    i++;
    return `{${name}}`;
  });
  return { ...rest, pattern: renamed, params: names };
}

/**
 * The IDs an expression can produce: `'a'`, `c ? 'a' : 'b'`, a template
 * (`git-run-${m.fileName}` → `git-run-{fileName}`), a constant or a helper
 * call declared in the same file. What cannot be known here (`{testId}`, a
 * prop) is `fromProps`, and a parent's value fills it in later.
 */
function patternsOf(expr, decls, env = new Map(), depth = 0) {
  const again = (e, scope = env) => patternsOf(e, decls, scope, depth + 1);
  const unknown = (e) => [{ pattern: `{${e.getText()}}`, params: [], fromProps: true }];
  if (!expr || depth > 8) return [];
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) return again(expr.expression);
  // `testId ? `${testId}-x` : undefined`: the empty branch renders no ID.
  if (expr.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(expr) && expr.text === 'undefined')) return [];
  if (ts.isStringLiteralLike(expr)) return [{ pattern: expr.text, params: [] }];
  if (ts.isConditionalExpression(expr)) return [...again(expr.whenTrue), ...again(expr.whenFalse)];
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return again(expr.right);
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return [...again(expr.left), ...again(expr.right)];
  }
  if (ts.isIdentifier(expr)) {
    if (env.has(expr.text)) return env.get(expr.text);
    const init = decls.consts.get(expr.text);
    return init ? again(init) : unknown(expr);
  }
  // NAV_TEST_IDS[view] → every value; NAV_TEST_IDS.access → that one.
  if ((ts.isElementAccessExpression(expr) || ts.isPropertyAccessExpression(expr)) && ts.isIdentifier(expr.expression)) {
    const object = decls.consts.get(expr.expression.text);
    if (object && ts.isObjectLiteralExpression(object)) {
      const props = object.properties.filter(ts.isPropertyAssignment);
      const picked = ts.isPropertyAccessExpression(expr) ? props.filter((p) => p.name.getText() === expr.name.text) : props;
      return picked.flatMap((p) => again(p.initializer));
    }
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && decls.fns.has(expr.expression.text)) {
    const fn = decls.fns.get(expr.expression.text);
    const scope = new Map(env);
    fn.parameters.forEach((p, i) => scope.set(p.name.text, expr.arguments[i] ? again(expr.arguments[i]) : []));
    return again(fn.body, scope);
  }
  if (ts.isTemplateExpression(expr)) {
    let combos = [{ pattern: expr.head.text, params: [] }];
    for (const span of expr.templateSpans) {
      const known = ts.isIdentifier(span.expression) ? again(span.expression).filter((p) => !p.fromProps) : [];
      const options = known.length ? known : [{ pattern: `{${paramName(span.expression)}}`, params: [paramName(span.expression)] }];
      combos = combos
        .flatMap((c) => options.map((o) => ({ pattern: c.pattern + o.pattern + span.literal.text, params: [...c.params, ...o.params] })))
        .slice(0, 32);
    }
    return combos.map(uniqueParams);
  }
  return unknown(expr);
}

/** The IDs a JSX attribute value can produce; see patternsOf. */
function idsOf(init, decls) {
  if (!init) return [];
  if (ts.isStringLiteral(init)) return [{ pattern: init.text, params: [] }];
  return ts.isJsxExpression(init) ? patternsOf(init.expression, decls) : [];
}

/** The component a node is drawn by: the nearest enclosing function with a capitalized name. */
function ownerOf(node, fallback) {
  for (let n = node.parent; n; n = n.parent) {
    const name =
      (ts.isFunctionDeclaration(n) && n.name?.text) ||
      (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text) ||
      '';
    if (/^[A-Z]/.test(name)) return name;
  }
  return fallback;
}

/** `{testId}-toggle` → the prop it starts with (`testId`) and the rest; else undefined. */
function slotOf(entry) {
  const m = /^\{(?:props\.)?([A-Za-z_$][\w$]*)\}/.exec(entry.pattern);
  if (!m) return undefined;
  return { prop: m[1], rest: entry.pattern.slice(m[0].length), params: entry.params[0] === m[1] ? entry.params.slice(1) : entry.params };
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

/** Props that hand a child component a test ID to draw: `testId`, `data-testid`, `rowTestId`… */
const ID_PROP = /^(data-testid|testId|[a-z]\w*TestId)$/;
/** An object property holding a test ID for whatever draws the object: `{ label: 'Clone', testId: 'utilities-clone-table' }`. */
const ID_KEY = /^['"]?(testId|data-testid)['"]?$/;

/** A string property next to a data ID that says what it is: `label`, `title` or `name`. */
function siblingLabel(property) {
  const object = property.parent;
  for (const key of ['label', 'title', 'name']) {
    const p = object.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText() === key && ts.isStringLiteralLike(q.initializer));
    if (p) return p.initializer.text;
  }
  return '';
}

/**
 * Read the web app: every test ID, and every control without one.
 *
 * An ID is found where it is written. Mostly that is a `data-testid` on the
 * element itself. It can also be:
 * - a `testId` property in data the component maps over;
 * - a prop a parent hands to a shared component, `<Autocomplete testId="x">`.
 *   The component draws `x` and `x-toggle`, and both are listed at the
 *   parent, where the ID is written (`via` names the component).
 */
export function collectTestIds(root = REPO_ROOT) {
  const entries = [];
  const missing = [];
  const passes = [];
  const aliases = new Map();
  for (const file of componentFiles(root)) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const labels = labelsOf(source);
    const decls = declarationsOf(source);
    const component = path.basename(file, '.tsx');
    const rel = file.slice(WEB_ROOT.length + 1);
    const at = (node) => ({ area: areaOf(file), component, file: rel, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    const visit = (node) => {
      // `function Autocomplete({ 'data-testid': testId })`: the prop `data-testid` is the local `testId`.
      if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parameters[0] && ts.isObjectBindingPattern(node.parameters[0].name)) {
        const owner = ts.isFunctionDeclaration(node) && node.name ? node.name.text : ownerOf(node, component);
        for (const el of node.parameters[0].name.elements) {
          if (el.propertyName && ts.isIdentifier(el.name)) aliases.set(`${owner}\u0000${el.name.text}`, el.propertyName.getText().replace(/['"]/g, ''));
        }
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const element = node.tagName.getText();
        const idAttr = attr(node, 'data-testid');
        const spread = node.attributes.properties.some((a) => ts.isJsxSpreadAttribute(a));
        if (/^[A-Z]/.test(element)) {
          // Resolved once every file is read: what the component draws with it.
          const site = { ...at(node), owner: ownerOf(node, component), description: describe(node, labels) };
          for (const a of node.attributes.properties) {
            if (ts.isJsxAttribute(a)) passes.push({ tag: element, prop: a.name.getText(), init: a.initializer, decls, site, named: ID_PROP.test(a.name.getText()) });
          }
        } else if (idAttr) {
          const description = describe(node, labels);
          for (const id of idsOf(idAttr.initializer, decls)) entries.push({ ...id, ...at(node), owner: ownerOf(node, component), element, description });
        } else if (!spread && CONTROLS.has(element) && !(element === 'input' && /hidden/.test(literalValue(attr(node, 'type'))))) {
          missing.push({ file: rel, line: at(node).line, element, description: describe(node, labels) });
        }
      }
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ID_KEY.test(node.name.getText())) {
        const init = ts.isPropertyAssignment(node) ? node.initializer : node.name;
        const value = ts.isArrowFunction(init) && !ts.isBlock(init.body) ? init.body : init;
        for (const id of patternsOf(value, decls)) {
          if (!id.fromProps) entries.push({ ...id, ...at(node), owner: ownerOf(node, component), element: 'data', description: siblingLabel(node) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  resolvePasses(entries, passes, aliases);
  return { entries, missing };
}

/**
 * Follow the IDs parents hand to components. A component draws a prop as
 * `{testId}`, `{testId}-toggle`, or passes it on to another component; each
 * value a parent gives becomes an entry at the parent, through any number of
 * hand-offs. A parent's ID no component is known to draw is listed as-is,
 * with the component as its element.
 */
function resolvePasses(entries, passes, aliases) {
  const key = (owner, prop) => `${owner}\u0000${aliases.get(`${owner}\u0000${prop}`) ?? prop}`;
  const slots = new Map();
  const addSlot = (owner, prop, slot) => {
    const k = key(owner, prop);
    slots.set(k, [...(slots.get(k) ?? []), slot]);
  };
  for (const e of entries) {
    const s = slotOf(e);
    if (s) addSlot(e.owner, s.prop, { ...s, element: e.element, description: e.description });
  }
  for (const p of passes) {
    if (!p.named) continue;
    p.values = idsOf(p.init, p.decls);
    for (const v of p.values) {
      const s = slotOf(v);
      if (s) addSlot(p.site.owner, s.prop, { ...s, forward: p });
    }
  }
  const resolve = (tag, prop, values, site, depth) => {
    const found = slots.get(`${tag}\u0000${prop}`) ?? [];
    for (const s of found) {
      for (const v of values) {
        const id = uniqueParams({ pattern: v.pattern + s.rest, params: [...v.params, ...s.params] });
        if (s.forward) {
          const drawn = depth < 6 && resolve(s.forward.tag, s.forward.prop, [id], site, depth + 1);
          if (!drawn) entries.push({ ...id, ...site, element: s.forward.tag, description: site.description, via: tag });
        } else {
          const description = (s.rest ? s.description || site.description : site.description || s.description) ?? '';
          entries.push({ ...id, ...site, element: s.element, description, via: tag });
        }
      }
    }
    return found.length > 0;
  };
  for (const p of passes) {
    if (!p.named && !slots.has(`${p.tag}\u0000${p.prop}`)) continue;
    p.values ??= idsOf(p.init, p.decls);
    const concrete = p.values.filter((v) => !v.fromProps && !slotOf(v));
    if (!resolve(p.tag, p.prop, concrete, p.site, 0) && p.named) {
      for (const v of concrete) entries.push({ ...v, ...p.site, element: p.tag });
    }
  }
}

/**
 * IDs two components share on purpose: the same thing on screen, drawn by
 * whichever of them is showing, so a test finds it either way.
 */
export const SHARED_IDS = {
  'lokee-summary': 'the history header: LokeeWeavePage draws it in graph mode, VersionTimeline otherwise',
};

/** IDs e2e tests check are gone: a screen that was removed must stay removed. */
export const REMOVED_IDS = {
  'view-lokee-weave-btn': 'the standalone Lokee tab, now the Snapshots rail; smoke.test.ts checks it stays gone',
};

/**
 * Static IDs rendered by more than one component file: a selector cannot tell
 * them apart. Repeats within one file are usually alternative branches (loading
 * and loaded) of which only one is on screen, so they are not listed.
 */
export function duplicates({ entries }) {
  const seen = new Map();
  for (const e of entries) {
    if (e.params.length || e.fromProps || e.pattern in SHARED_IDS) continue;
    const at = `${e.file}:${e.line}`;
    seen.set(e.pattern, [...(seen.get(e.pattern) ?? []), at]);
  }
  return [...seen].filter(([, at]) => new Set(at.map((a) => a.split(':')[0])).size > 1).sort(([a], [b]) => a.localeCompare(b));
}

/** Controls (not containers) that carry a test ID, each counted once, where it is drawn. */
export function controlsWithId({ entries }) {
  return new Set(entries.filter((e) => CONTROLS.has(e.element) && !e.via).map((e) => `${e.file}:${e.line}`)).size;
}

/**
 * The IDs a test can use, as patterns: `git-run-{fileName}`. Left out are the
 * placeholders a shared component fills from its parent (`{testId}-toggle`),
 * which are listed at each parent instead.
 */
export function usableIds({ entries }) {
  return entries.filter((e) => !e.fromProps && !slotOf(e));
}

export const E2E_ROOT = 'apps/e2e/src';

/**
 * The test IDs a piece of e2e code names: `[data-testid="x"]` (also `^=`, `$=`
 * and `*=`), `getByTestId('x')` and `byTestId('x')`. A `${…}` in the ID is a
 * part only known at run time.
 */
export function selectorsIn(text) {
  const found = [];
  const lineAt = (i) => text.slice(0, i).split('\n').length;
  for (const m of text.matchAll(/data-testid([\^$*]?)=(["'])((?:(?!\2)[^\]])*)\2/g)) {
    found.push({ id: m[3], match: { '': 'exact', '^': 'prefix', $: 'suffix', '*': 'contains' }[m[1]], line: lineAt(m.index) });
  }
  for (const m of text.matchAll(/\b(?:getByTestId|byTestId)\(\s*(['"`])((?:(?!\1)[\s\S])*)\1\s*\)/g)) {
    found.push({ id: m[2], match: 'exact', line: lineAt(m.index) });
  }
  return found;
}

const RUNTIME = '\u0001';
const shape = (s, part) => s.split(part).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]+');
/** Could an e2e selector and a catalogued pattern name the same element? */
function compatible(selector, pattern) {
  const sample = pattern.replace(/\{[^}]*\}/g, RUNTIME);
  const wanted = { exact: (x) => x, prefix: (x) => `${x}${RUNTIME}`, suffix: (x) => `${RUNTIME}${x}`, contains: (x) => `${RUNTIME}${x}${RUNTIME}` }[selector.match](
    selector.id.replace(/\$\{[^}]*\}/g, RUNTIME),
  );
  const either = (a, b) => new RegExp(`^${shape(a, RUNTIME)}$`).test(b.replaceAll(RUNTIME, RUNTIME));
  // `prefix` allows the empty rest too: `[data-testid^="sql-pane"]` finds `sql-pane`.
  const loose = (x) => x.replace(new RegExp(`(^${RUNTIME}|${RUNTIME}$)`, 'g'), '');
  return either(wanted, sample) || either(sample, wanted) || (selector.match !== 'exact' && (either(loose(wanted), sample) || sample.includes(loose(wanted).replaceAll(RUNTIME, ''))));
}

/** Every selector in the e2e code that names an ID the web app does not have. */
export function unknownSelectors(catalog, root = REPO_ROOT) {
  const patterns = [...new Set(usableIds(catalog).map((e) => e.pattern))];
  const unknown = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'generated') walk(rel);
      } else if (entry.name.endsWith('.ts')) {
        for (const sel of selectorsIn(fs.readFileSync(path.join(root, rel), 'utf8'))) {
          if (!(sel.id in REMOVED_IDS) && !patterns.some((p) => compatible(sel, p))) unknown.push({ file: rel, ...sel });
        }
      }
    }
  };
  walk(E2E_ROOT);
  return unknown;
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
    'Every `data-testid` in the web app, by area and component. In e2e code, select one with',
    '`byTestId(...)` from `apps/e2e/src/helpers/test-ids.ts`, which only accepts IDs listed here,',
    'or `TestIds` for the same tree with autocomplete. `{name}` marks a part filled in at run',
    'time; "in FilterPicker" marks an ID a shared component draws from the prop written here.',
    'How to write a test with them: [WRITING_E2E.md](WRITING_E2E.md).',
    '',
    catalog.missing.length
      ? `Controls with a test ID: **${controls} of ${total}** (${((controls / total) * 100).toFixed(1)}%). ` +
        `Without one: ${catalog.missing.length}, listed at the end.`
      : `Every control has a test ID: **${controls}** buttons, text boxes, selects and textareas.`,
    '',
  ];
  for (const { area, components } of tree(catalog)) {
    lines.push(`## ${area}`, '');
    for (const c of components) {
      lines.push(`- **${c.name}** · \`${c.file}\``);
      for (const e of c.ids) {
        const what = [e.via ? `${e.element} in ${e.via}` : e.element, e.description && md(e.description), (e.fromProps || slotOf(e)) && 'passed in by the parent']
          .filter(Boolean)
          .join(' · ');
        lines.push(`  - \`${e.pattern}\` · ${what}`);
      }
    }
    lines.push('');
  }
  lines.push('## Shared on purpose', '', 'One thing on screen, drawn by whichever component is showing.', '');
  for (const [id, why] of Object.entries(SHARED_IDS)) lines.push(`- \`${id}\`: ${why}`);
  lines.push('');
  if (dupes.length) {
    lines.push('## Used in more than one place', '', 'A selector finds the first; give each its own ID.', '');
    for (const [id, at] of dupes) lines.push(`- \`${id}\`: ${at.map((a) => `\`${a}\``).join(', ')}`);
    lines.push('');
  }
  if (!catalog.missing.length) return lines.join('\n');
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
    ' * An ID built at run time is a function of its parts. `TestId` is every ID as one type,',
    ' * for byTestId() in helpers/test-ids.ts. See docs/testing/WRITING_E2E.md.',
    ' */',
    'export const TestIds = {',
  ];
  for (const { area, components } of tree(catalog)) {
    lines.push(`  ${safeKey(camel(area))}: {`);
    for (const c of components) {
      const ids = c.ids.filter((e) => !e.fromProps && !slotOf(e));
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
  const union = [...new Set(usableIds(catalog).map((e) => e.pattern.split(/\{[^}]*\}/).map(templateText).join('${string}')))].sort();
  lines.push(
    '/** Any test ID in the web app; `${string}` is a part filled in at run time. */',
    'export type TestId =',
    ...union.map((u, i) => `  | ${u.includes('${string}') ? `\`${u}\`` : quote(u)}${i === union.length - 1 ? ';' : ''}`),
    '',
  );
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
