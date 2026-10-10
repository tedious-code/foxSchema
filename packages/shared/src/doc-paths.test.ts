/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every repo path the navigational docs name must actually exist.
 *
 * `CLAUDE.md` is loaded into every agent session; `AGENTS.md`, `README.md` and
 * `docs/CODE_MAP.md` are where a human starts. They are not prose — they are
 * the index. When the tree moves and the index does not, the index stops being
 * wrong in a way anyone notices and starts being wrong in a way everyone acts
 * on.
 *
 * That already happened once. The backend moved from `apps/web/src/backend/` to
 * `packages/server/src/` and Express was removed entirely, and for some months
 * afterwards `CLAUDE.md` still pointed the append-only-migration rule — the
 * data-loss-class rule in this repo — at a `schema.ts` that no longer existed,
 * while nine files still described a server that was gone.
 *
 * The same drift is checked for elsewhere and for the same reason: see
 * `naming.test.ts` (conventions), `purity.test.ts` (package boundaries) and
 * `TRIGGER_KINDS` in the workflow engine (a contract that was copied by hand
 * and drifted twice).
 *
 * Scope is deliberately the *navigational* docs only. Plan and release
 * documents are history — `docs/API_RESTRUCTURE_PLAN.md` says in its own header
 * that its paths are stale and kept as the record of why, which is a legitimate
 * thing for a document to be. Those are not scanned.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Navigational docs that are in version control, and so exist in every clone
 * and in CI. These must be present and correct.
 */
const TRACKED_DOCS = [
  'AGENTS.md',
  'README.md',
  'CONTRIBUTING.md',
  'docs/CODE_MAP.md',
  'docs/ARCHITECTURE.md',
  'docs/CONVENTIONS.md',
  'docs/BACKEND_ARCHITECTURE.md',
  'docs/DEPLOYMENT.md',
  'docs/DEPENDENCY_POLICY.md',
  'docs/architecture/FEATURE-MODULE-GUIDE.md',
  'docs/architecture/FEATURE-DEPENDENCY-RULES.md',
];

/**
 * Navigational docs that `.gitignore` deliberately excludes, so they exist on a
 * maintainer's machine but not in CI.
 *
 * This is worth stating plainly, because it is the reason these two drifted
 * furthest: they are the docs no reviewer sees in a diff and no CI job checks
 * out. `CLAUDE.md` in particular is loaded into every agent session while being
 * the least reviewed file in the repository.
 *
 * They are checked when present and skipped when not, so this suite is useful
 * locally — where the drift actually happens — without failing a CI run that
 * legitimately has no copy of them.
 */
const LOCAL_ONLY_DOCS = ['CLAUDE.md', 'IMPLEMENTATION_STATE.md'];

const NAVIGATIONAL_DOCS = [...TRACKED_DOCS, ...LOCAL_ONLY_DOCS];

/** Top-level directories a repo-relative path can start with. */
const ROOTS = ['apps', 'packages', 'docs', 'scripts', 'docker', 'packaging', 'examples', 'Formula'];

/**
 * Paths that are intentionally not files on disk: globs, illustrative names,
 * and paths that only exist in a built or generated tree.
 *
 * Like `naming.test.ts`'s EXCEPTIONS, this list should shrink, never grow. An
 * entry here is a claim that a reader will not be misled — not a way to keep a
 * stale path.
 */
const EXCEPTIONS = new Set<string>([
  // Build output, present only after `npm run build`.
  'apps/web/dist',
  // Named in IMPLEMENTATION_STATE.md as what a current app *replaced*. Removing
  // the name would lose the record of where `apps/workflow-server` came from.
  'apps/foxworkflow',
  'apps/designer',
  // The old backend root, named in the docs precisely to say it is gone. Only
  // the bare directory is exempt — a file under it (the stale
  // `apps/web/src/backend/database/schema.ts` that started all this) still
  // fails, which is the case that matters.
  'apps/web/src/backend/',
]);

/** A path is a glob/placeholder rather than a literal file. */
function isPattern(p: string): boolean {
  return /[*<>{}]|\.\.\./.test(p);
}

/**
 * Pull repo-relative paths out of a Markdown file.
 *
 * Only backtick-quoted spans are considered: prose mentions a directory in
 * passing all the time, and a code span is the form the docs use when they mean
 * "look here". A trailing `:123` line reference and trailing punctuation are
 * stripped.
 */
function citedPaths(markdown: string): string[] {
  const found = new Set<string>();
  for (const [, span] of markdown.matchAll(/`([^`\n]+)`/g)) {
    // A code span may hold a command or a sentence; take each whitespace-
    // separated word that looks like a path under a known root.
    for (const word of span.split(/[\s(),]+/)) {
      // Strip a trailing line reference (`file.ts:42`, `file.ts:42-58`) then any
      // trailing punctuation. Two simple anchored patterns rather than one with
      // an optional repeated group — `(-\d+)?$` after `\d+` is the shape
      // security/detect-unsafe-regex rejects.
      const cleaned = word
        .replace(/:\d+-\d+$/, '')
        .replace(/:\d+$/, '')
        .replace(/[.,;]+$/, '');
      if (!cleaned.includes('/')) continue;
      const root = cleaned.split('/')[0];
      if (!ROOTS.includes(root)) continue;
      if (isPattern(cleaned)) continue;
      if (EXCEPTIONS.has(cleaned)) continue;
      found.add(cleaned);
    }
  }
  return [...found];
}

describe('navigational docs point at paths that exist', () => {
  for (const doc of TRACKED_DOCS) {
    it(`${doc} exists`, () => {
      expect(
        fs.existsSync(path.join(REPO, doc)),
        `${doc} is listed as a tracked navigational doc but is missing`,
      ).toBe(true);
    });
  }

  for (const doc of NAVIGATIONAL_DOCS) {
    const abs = path.join(REPO, doc);
    const localOnly = LOCAL_ONLY_DOCS.includes(doc);

    it(`${doc} cites only real paths${localOnly ? ' (skipped when absent)' : ''}`, (ctx) => {
      if (localOnly && !fs.existsSync(abs)) {
        ctx.skip(`${doc} is gitignored and not present in this checkout`);
        return;
      }
      const missing = citedPaths(fs.readFileSync(abs, 'utf8')).filter(
        (p) => !fs.existsSync(path.join(REPO, p)),
      );
      expect(
        missing,
        `${doc} names ${missing.length} path(s) that do not exist. Update the doc, or add a ` +
          `deliberate entry to EXCEPTIONS in doc-paths.test.ts:\n  ${missing.join('\n  ')}`,
      ).toEqual([]);
    });
  }
});

describe('Express is gone and the docs say so', () => {
  /**
   * Express was removed wholesale (see `docs/BACKEND_EXTRACTION_PLAN.md` §8).
   * The navigational docs described it as the running server for months
   * afterwards. This fails if that language comes back while no workspace
   * actually depends on Express — the combination that misleads.
   */
  it('no workspace depends on express', () => {
    const manifests = [
      'package.json',
      ...fs
        .readdirSync(path.join(REPO, 'packages'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `packages/${e.name}/package.json`),
      ...fs
        .readdirSync(path.join(REPO, 'apps'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `apps/${e.name}/package.json`),
    ].filter((m) => fs.existsSync(path.join(REPO, m)));

    const offenders = manifests.filter((m) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, m), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return Object.keys(deps).some((d) => d === 'express' || d.endsWith('/express'));
    });

    expect(offenders).toEqual([]);
  });

  it('the navigational docs do not present Express as the running server', () => {
    const claims: string[] = [];
    for (const doc of NAVIGATIONAL_DOCS) {
      const abs = path.join(REPO, doc);
      if (!fs.existsSync(abs)) continue;
      const text = fs.readFileSync(abs, 'utf8');
      // "Express API", "runs the Express", "Express is still the default" — the
      // present-tense forms. Past-tense history ("why Express came out") is fine.
      for (const [match] of text.matchAll(
        /(Express API|runs? the Express|Express is still|starts? both Express)/gi,
      )) {
        claims.push(`${doc}: ${match}`);
      }
    }
    expect(claims).toEqual([]);
  });
});
