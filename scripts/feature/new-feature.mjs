#!/usr/bin/env node
/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Scaffold a feature on both sides and register it.
 *
 *   npm run feature:new -- <id> [--server-only | --web-only] [--dry-run]
 *
 * <id> is kebab-case (`audit-log`). The server side is a feature module
 * (index, routes, service and their tests) mounted at /api/<id> for a
 * signed-in user, added to the feature registry and the HTTP contract table.
 * The web side is a feature folder (index, api client, a view and its test,
 * the lazy `view.ts`) whose view is added to the view registry. Nothing is
 * discovered at run time: both registries stay static, typed lists, and this
 * script only writes the lines a person would.
 *
 * The result passes the whole suite as written, so work starts from green.
 * docs/architecture/FEATURE-MODULE-GUIDE.md has the checklist for what comes
 * next.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HEADER = `/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *`;

export const PATHS = {
  serverFeatures: 'packages/server/src/features',
  serverRegistry: 'packages/server/src/app/feature-registry.ts',
  contract: 'packages/server/src/api/http-contract.test.ts',
  webFeatures: 'apps/web/src/frontend/features',
  viewIds: 'apps/web/src/frontend/app/features/viewIds.ts',
  viewRegistry: 'apps/web/src/frontend/app/features/featureRegistry.ts',
};

/** Names the shell already uses, or that would read as one of its own. */
const RESERVED = new Set(['app', 'api', 'shared', 'platform', 'features', 'home', 'settings', 'index', 'view']);

/** Why an id cannot be used, or null when it can. */
export function invalidId(id) {
  const kebab = typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id) && !id.includes('--') && !id.endsWith('-');
  if (!kebab) {
    return `"${id}" is not a kebab-case id: lowercase letters and digits, words joined by "-", starting with a letter (audit-log)`;
  }
  if (RESERVED.has(id)) return `"${id}" is reserved`;
  return null;
}

/** `audit-log` → { id, camel: auditLog, pascal: AuditLog, title: 'Audit log' }. */
export function namesFor(id) {
  const words = id.split('-');
  const camel = words[0] + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  const pascal = camel[0].toUpperCase() + camel.slice(1);
  const title = words.join(' ').replace(/^./, (c) => c.toUpperCase());
  return { id, camel, pascal, title };
}

/** Inserts `text` right after the last line `pattern` matches. */
function afterLastLine(src, pattern, text) {
  const lines = src.split('\n');
  let last = -1;
  lines.forEach((line, i) => {
    if (pattern.test(line)) last = i;
  });
  if (last < 0) throw new Error(`no line matches ${pattern}`);
  lines.splice(last + 1, 0, text);
  return lines.join('\n');
}

/** The server registry with the feature imported and appended to FEATURES. */
export function registerServerFeature(src, n) {
  if (src.includes(`'../features/${n.id}'`)) throw new Error(`the server registry already imports features/${n.id}`);
  const out = afterLastLine(src, /^import \{ \w+Feature \} from '\.\.\/features\//, `import { ${n.camel}Feature } from '../features/${n.id}';`);
  const head = 'export const FEATURES: readonly ServerFeatureModule[] = [\n';
  const start = out.indexOf(head);
  const end = start < 0 ? -1 : out.indexOf('];', start);
  const entries = start < 0 ? [] : out.slice(start + head.length, end).split('\n').filter(Boolean);
  if (end < 0 || !entries.every((line) => /^ {2}\w+,$/.test(line))) {
    throw new Error('FEATURES is not the one-per-line list this script edits');
  }
  return out.slice(0, end) + `  ${n.camel}Feature,\n` + out.slice(end);
}

/** The contract table with the feature's starter route, and the count raised to match. */
export function addContractRoute(src, n) {
  const row = `  { method: 'GET', path: '/api/${n.id}', status: 200 },`;
  if (src.includes(`path: '/api/${n.id}'`)) throw new Error(`the contract table already lists /api/${n.id}`);
  const start = src.indexOf('const ROUTES: RouteExpectation[] = [');
  if (start < 0) throw new Error('no ROUTES table in the contract test');
  const end = src.indexOf('\n];', start);
  let out = src.slice(0, end) + '\n' + row + src.slice(end);
  const count = /( +)expect\(ROUTES\.length\)\.toBe\((\d+)\);/;
  const m = count.exec(out);
  if (!m) throw new Error('no ROUTES.length assertion in the contract test');
  const [, indent, was] = m;
  const now = Number(was) + 1;
  out = out.replace(
    count,
    `${indent}//\n${indent}// ${was} -> ${now}: ${n.title} (/api/${n.id}), from npm run feature:new.\n${indent}expect(ROUTES.length).toBe(${now});`
  );
  return out;
}

/** VIEW_IDS with the feature's view id appended. */
export function addViewId(src, n) {
  const ids = /(export const VIEW_IDS = \[)([^\]]*)(\] as const;)/;
  const m = ids.exec(src);
  if (!m) throw new Error('no VIEW_IDS list in viewIds.ts');
  if (new RegExp(`'${n.camel}'`).test(m[2])) throw new Error(`the view id "${n.camel}" exists already`);
  return src.replace(ids, `$1$2, '${n.camel}'$3`);
}

/** The view registry with an entry that loads the feature's view. */
export function registerView(src, n) {
  if (src.includes(`'@/features/${n.id}/view'`)) throw new Error(`the view registry already loads features/${n.id}`);
  const anchor = /^ {2}settings: \{/m;
  if (!anchor.test(src)) throw new Error('no settings entry in the view registry to insert before');
  return src.replace(anchor, `  ${n.camel}: { load: () => import('@/features/${n.id}/view') },\n  settings: {`);
}

export function serverFiles(n) {
  const dir = `${PATHS.serverFeatures}/${n.id}`;
  return {
    [`${dir}/index.ts`]: `${HEADER}
 * The ${n.title.toLowerCase()} feature. TODO: say in a sentence what it does.
 */
import type { ServerFeatureModule } from '../../app/feature-module';
import { create${n.pascal}Routes } from './${n.id}.routes';

export const ${n.camel}Feature: ServerFeatureModule = {
  id: '${n.id}',
  mounts: [{ prefix: '/api/${n.id}', access: 'user', routes: () => create${n.pascal}Routes() }],
};
`,
    [`${dir}/${n.id}.routes.ts`]: `${HEADER}
 * The ${n.title.toLowerCase()} routes, mounted at /api/${n.id} for a signed-in user.
 *
 * A route that needs more than a session takes \`requirePermissions('…')\`
 * from platform/authorization. Every route is listed, with what it answers,
 * in api/http-contract.test.ts.
 */
import type { FastifyReply } from 'fastify';
import { Router } from '../../platform/http/router';
import type { AuthedRequest } from '../../platform/http/types';
import { ${n.pascal}Service } from './${n.id}.service';

export function create${n.pascal}Routes(service = new ${n.pascal}Service()): Router {
  const router = Router();

  router.get('/', async (req: AuthedRequest, res: FastifyReply) => {
    res.send({ summary: await service.summary(req.userId!) });
  });

  return router;
}
`,
    [`${dir}/${n.id}.service.ts`]: `${HEADER}
 * The ${n.title.toLowerCase()} logic, with no HTTP types.
 */
export interface ${n.pascal}Summary {
  userId: string;
}

export class ${n.pascal}Service {
  async summary(userId: string): Promise<${n.pascal}Summary> {
    return { userId };
  }
}
`,
    [`${dir}/${n.id}.service.test.ts`]: `${HEADER}
 */
import { describe, expect, it } from 'vitest';
import { ${n.pascal}Service } from './${n.id}.service';

describe('${n.pascal}Service', () => {
  it('summarises for the caller', async () => {
    expect(await new ${n.pascal}Service().summary('u1')).toEqual({ userId: 'u1' });
  });
});
`,
    [`${dir}/${n.id}.routes.test.ts`]: `${HEADER}
 */
import { describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { AuthedRequest } from '../../platform/http/types';
import { create${n.pascal}Routes } from './${n.id}.routes';
import { ${n.pascal}Service } from './${n.id}.service';

function handler(method: string, path: string) {
  const route = create${n.pascal}Routes(new ${n.pascal}Service())
    .flatten()
    .find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(\`\${method} \${path} is not registered\`);
  return route.handler;
}

function fakeReply() {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    code(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

describe('${n.id} routes', () => {
  it('GET / answers the caller’s summary', async () => {
    const { reply, sent } = fakeReply();
    await handler('GET', '/')({ userId: 'u1' } as unknown as AuthedRequest, reply);
    expect(sent.body).toEqual({ summary: { userId: 'u1' } });
  });
});
`,
  };
}

export function webFiles(n) {
  const dir = `${PATHS.webFeatures}/${n.id}`;
  return {
    [`${dir}/index.ts`]: `${HEADER}
 * The ${n.title.toLowerCase()} feature's public API. Keep it light: the first
 * screen may import it. The view is the lazy \`view.ts\`.
 */
export { fetch${n.pascal}Summary, type ${n.pascal}Summary } from './api/${n.camel}Api';
`,
    [`${dir}/view.ts`]: `${HEADER}
 * The ${n.title.toLowerCase()} view, loaded on demand by the view registry.
 */
export { ${n.pascal}View as default } from './components/${n.pascal}View';
`,
    [`${dir}/api/${n.camel}Api.ts`]: `${HEADER}
 * Calls to /api/${n.id}. No business rules here.
 */
import { api } from '@/shared/api/client';

export interface ${n.pascal}Summary {
  userId: string;
}

export async function fetch${n.pascal}Summary(): Promise<${n.pascal}Summary> {
  return (await api.get<{ summary: ${n.pascal}Summary }>('/${n.id}')).summary;
}
`,
    [`${dir}/components/${n.pascal}View.tsx`]: `${HEADER}
 * The ${n.title.toLowerCase()} view. TODO: say what someone comes here to do.
 */
import React, { useEffect, useState } from 'react';
import { fetch${n.pascal}Summary, type ${n.pascal}Summary } from '../api/${n.camel}Api';

export function ${n.pascal}View(): React.ReactElement {
  const [summary, setSummary] = useState<${n.pascal}Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch${n.pascal}Summary().then(
      (next) => {
        if (!cancelled) setSummary(next);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section data-testid="${n.id}-view" className="flex-1 overflow-auto p-6 text-slate-100">
      <h1 className="text-lg font-semibold">${n.title}</h1>
      {error ? (
        <p data-testid="${n.id}-error" className="mt-2 text-sm text-rose-300">
          {error}
        </p>
      ) : (
        <p data-testid="${n.id}-summary" className="mt-2 text-sm text-slate-400">
          {summary ? \`Signed in as \${summary.userId}\` : 'Loading…'}
        </p>
      )}
    </section>
  );
}
`,
    [`${dir}/components/${n.pascal}View.test.tsx`]: `${HEADER}
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ${n.pascal}View } from './${n.pascal}View';

const fetchSummary = vi.fn();
vi.mock('../api/${n.camel}Api', () => ({ fetch${n.pascal}Summary: () => fetchSummary() }));

afterEach(() => {
  cleanup();
  fetchSummary.mockReset();
});

describe('${n.pascal}View', () => {
  it('shows what the server answers', async () => {
    fetchSummary.mockResolvedValue({ userId: 'u1' });
    render(<${n.pascal}View />);
    expect((await screen.findByTestId('${n.id}-summary')).textContent).toBe('Signed in as u1');
  });

  it('says what failed', async () => {
    fetchSummary.mockRejectedValue(new Error('offline'));
    render(<${n.pascal}View />);
    expect((await screen.findByTestId('${n.id}-error')).textContent).toBe('offline');
  });
});
`,
  };
}

/**
 * Everything the scaffold writes, without writing it: new files, and the new
 * content of each registry. Throws, naming the clash, when any part exists.
 */
export function planFeature(root, id, { server = true, web = true } = {}) {
  const why = invalidId(id);
  if (why) throw new Error(why);
  const n = namesFor(id);
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const files = {};
  const edits = {};
  if (server) {
    if (fs.existsSync(path.join(root, PATHS.serverFeatures, id))) throw new Error(`${PATHS.serverFeatures}/${id} exists already`);
    Object.assign(files, serverFiles(n));
    edits[PATHS.serverRegistry] = registerServerFeature(read(PATHS.serverRegistry), n);
    edits[PATHS.contract] = addContractRoute(read(PATHS.contract), n);
  }
  if (web) {
    if (fs.existsSync(path.join(root, PATHS.webFeatures, id))) throw new Error(`${PATHS.webFeatures}/${id} exists already`);
    Object.assign(files, webFiles(n));
    edits[PATHS.viewIds] = addViewId(read(PATHS.viewIds), n);
    edits[PATHS.viewRegistry] = registerView(read(PATHS.viewRegistry), n);
  }
  return { names: n, files, edits };
}

/** Writes a plan. Nothing is written until the whole plan was built. */
export function applyPlan(root, plan) {
  for (const [rel, content] of Object.entries(plan.files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, { flag: 'wx' });
  }
  for (const [rel, content] of Object.entries(plan.edits)) fs.writeFileSync(path.join(root, rel), content);
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [id] = argv.filter((a) => !a.startsWith('--'));
  const unknown = [...flags].filter((f) => !['--server-only', '--web-only', '--dry-run'].includes(f));
  if (!id || unknown.length || (flags.has('--server-only') && flags.has('--web-only'))) {
    console.error('usage: npm run feature:new -- <id> [--server-only | --web-only] [--dry-run]');
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const web = !flags.has('--server-only');
  const server = !flags.has('--web-only');
  let plan;
  try {
    plan = planFeature(root, id, { server, web });
  } catch (err) {
    console.error(`feature:new: ${err.message}`);
    process.exit(1);
  }
  const verb = flags.has('--dry-run') ? 'would write' : 'wrote';
  if (!flags.has('--dry-run')) {
    applyPlan(root, plan);
    // The new view's test ids belong in the catalog the e2e suite reads.
    if (web) execFileSync(process.execPath, ['scripts/test-ids/extract-test-ids.mjs', '--write'], { cwd: root, stdio: 'ignore' });
  }
  for (const rel of Object.keys(plan.files)) console.log(`${verb}   ${rel}`);
  for (const rel of Object.keys(plan.edits)) console.log(`${verb === 'wrote' ? 'updated' : 'would update'} ${rel}`);
  const n = plan.names;
  console.log(`
Next:
  - Say what it does in the headers marked TODO.${
    web
      ? `
  - The view "${n.camel}" is registered without a rail button. To show one, add \`rail\`
    to its entry in app/features/featureRegistry.ts, and the button to featureRegistry.test.ts.`
      : ''
  }${
    server
      ? `
  - Each route you add gets a row in packages/server/src/api/http-contract.test.ts.`
      : `
  - The api client calls /api/${n.id}, which --web-only did not create: point it at the
    endpoint the view reads.`
  }
  - Check: cd apps/web && npx tsc --noEmit, then npx vitest run from the repo root.
  - The checklist: docs/architecture/FEATURE-MODULE-GUIDE.md.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
