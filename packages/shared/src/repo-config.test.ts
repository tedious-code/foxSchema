/**
 * Fox Schema (@foxschema/shared)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The repo's own wiring, checked — because both bugs it covers were silent.
 *
 * Adding Turborepo, I gave each package `lint: eslint src` and pointed the root
 * `lint` script at `turbo lint`. That looked like a speedup and was a trap:
 * `eslint .` covers 904 files, the per-package sum covered 801. `npm run lint`
 * passed while CI — which runs `eslint .` in three workflows — still failed, on
 * apps/e2e, apps/cli's scripts and the root scripts. A local gate that checks
 * less than CI is worse than no local gate, because it is trusted.
 *
 * In the same change I listed `tsconfig.base.json` in `globalDependencies`. No
 * such file exists. Turbo hashes nothing for a missing entry, so the cache key
 * silently *narrowed* while the config claimed it had widened — the failure
 * mode being a stale cache hit, which is the one thing a build cache must never
 * do.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(repoRoot, p), 'utf8'));

describe('the local lint gate matches the one CI runs', () => {
  const workflows = path.join(repoRoot, '.github', 'workflows');

  /** The lint command every CI workflow invokes. */
  function ciLintCommands(): string[] {
    const found = new Set<string>();
    for (const file of fs.readdirSync(workflows)) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      const body = fs.readFileSync(path.join(workflows, file), 'utf8');
      // Line by line with a trimmed prefix rather than one multiline regex.
      // The regex version had `\s*(?:-\s*)?` at the start, which nests
      // quantifiers over the same character class — `security/detect-unsafe-regex`
      // flagged it, and it was right: that is the backtracking shape, and the
      // input here is a file on disk. This has no quantifier ambiguity at all.
      for (const raw of body.split('\n')) {
        const line = raw.trim().replace(/^-\s*/, '');
        if (!line.startsWith('run:')) continue;
        const command = line.slice('run:'.length).trim();
        if (/eslint/.test(command) && /^np[mx]\b/.test(command)) found.add(command);
      }
    }
    return [...found];
  }

  it('finds CI actually linting, so the check below is not vacuous', () => {
    expect(ciLintCommands().length).toBeGreaterThan(0);
  });

  it('runs the same command locally as in CI', () => {
    // Not "a lint command" — the same one. Any narrower local script lets a
    // change pass review and fail on push.
    const root = read('package.json');
    expect(root.scripts.lint).toBe('eslint .');
    for (const cmd of ciLintCommands()) {
      expect(cmd, 'CI lint command').toMatch(/eslint \.$/);
    }
  });

  it('leaves no package-level lint script to shadow it', () => {
    // `turbo lint` runs every `lint` it finds. A per-package one covering only
    // src/ is how the 103-file gap appeared.
    for (const dir of ['packages', 'apps']) {
      for (const pkg of fs.readdirSync(path.join(repoRoot, dir))) {
        const manifest = path.join(repoRoot, dir, pkg, 'package.json');
        if (!fs.existsSync(manifest)) continue;
        const scripts = JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts ?? {};
        expect(scripts.lint, `${dir}/${pkg}`).toBeUndefined();
      }
    }
  });
});

describe('turbo.json refers only to files that exist', () => {
  const turbo = read('turbo.json');

  it('declares global dependencies at all', () => {
    expect(turbo.globalDependencies?.length).toBeGreaterThan(0);
  });

  it('names a real file for each', () => {
    // A missing entry hashes to nothing: the config reads as though the cache
    // key covers that file when it does not.
    const missing = (turbo.globalDependencies as string[]).filter(
      (f) => !fs.existsSync(path.join(repoRoot, f))
    );
    expect(missing).toEqual([]);
  });

  it('keeps the build graph ordered so a dependent never reads stale output', () => {
    // db's build resolves @foxschema/sql's *built* types. Without this edge it
    // followed the workspace symlink into sql's source and emitted 334 files
    // next to it.
    expect(turbo.tasks.build.dependsOn).toContain('^build');
    expect(turbo.tasks.build.outputs).toContain('dist/**');
  });
});

describe('the package manager is pinned', () => {
  it('names one, which Turbo requires and npm honours', () => {
    expect(read('package.json').packageManager).toMatch(/^npm@\d+\.\d+\.\d+$/);
  });

  it('keeps exactly one lockfile, so the pin means something', () => {
    const locks = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].filter((f) =>
      fs.existsSync(path.join(repoRoot, f))
    );
    expect(locks).toEqual(['package-lock.json']);
  });
});

describe('the e2e runner runs every e2e suite', () => {
  /**
   * Same failure as the lint gate above, one directory over.
   *
   * `node scripts/run-all.mjs` is the documented "run everything" for
   * apps/e2e, and it ran 24 of 37 suites. The twelve it skipped were not
   * marked skipped anywhere — they were simply absent from a hand-maintained
   * list, so they had never run and nobody could tell. Among them was the
   * entire Database Access dialect matrix, and `sql-editor-peek-row-form`,
   * which had rotted to the point of failing outright.
   *
   * The runner is read as text rather than imported: it launches every browser
   * test on import.
   */
  const e2e = path.join(repoRoot, 'apps', 'e2e');
  const runner = fs.readFileSync(path.join(e2e, 'scripts', 'run-all.mjs'), 'utf8');

  /** Every `*.test.ts` under apps/e2e/src/tests, as a repo-style path. */
  function everySuite(): string[] {
    const root = path.join(e2e, 'src', 'tests');
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith('.test.ts')
          ? [path.relative(path.join(e2e), full).split(path.sep).join('/')]
          : [];
      });
    return walk(root).sort();
  }

  it('finds the suites at all', () => {
    // A walker that matched nothing would make the assertion below vacuous.
    expect(everySuite().length).toBeGreaterThan(20);
  });

  it('either runs each suite or says why it does not', () => {
    const unreached = everySuite().filter((suite) => !runner.includes(suite));
    expect(unreached).toEqual([]);
  });

  it('names no suite that does not exist', () => {
    // The other direction, and the one the walk above cannot see: it enumerates
    // files on disk, so a runner entry pointing at nothing is invisible to it.
    // That is not hypothetical — this PR listed sql-editor-peek-stacking.test.ts
    // while the file itself was on another branch. Vitest exits non-zero on a
    // filter that matches no file, so a phantom entry fails the whole suite.
    const named = [...runner.matchAll(/src\/tests\/[A-Za-z0-9\-/.]+\.test\.ts/g)].map((m) => m[0]);
    expect(named.length).toBeGreaterThan(20);
    const missing = [...new Set(named)]
      .filter((rel) => !fs.existsSync(path.join(e2e, rel)))
      .sort();
    expect(missing, 'run-all names a suite that is not in the repo').toEqual([]);
  });

  it('gives a reason for each suite it deliberately skips', () => {
    // The skip list is what makes the check above honest: without a reason
    // attached, "listed in the file" and "actually run" drift apart again.
    const block = /const DELIBERATELY_SKIPPED = \{([\s\S]*?)\n\};/.exec(runner)?.[1] ?? '';
    const entries = [...block.matchAll(/'([^']+\.test\.ts)':\s*\n?\s*'([^']*)'/g)];
    expect(entries.length).toBeGreaterThan(0);
    for (const [, file, reason] of entries) {
      expect(fs.existsSync(path.join(e2e, file!)), `${file} does not exist`).toBe(true);
      expect(reason!.length, `${file} has no reason`).toBeGreaterThan(20);
    }
  });
});

describe('Markdown is tracked unless it is a personal note', () => {
  // A blanket `*.md` ignore once swallowed the dialect checklist and an example
  // guide without anyone noticing; only named notes may be ignored.
  const ignored = (file: string) => spawnSync('git', ['check-ignore', '-q', file], { cwd: repoRoot }).status === 0;

  it('does not ignore a new doc, wherever it lives', () => {
    for (const file of ['docs/a-new-guide.md', 'docs/examples/a-new-example.md', 'packages/sql/NOTES.md', 'README.md']) {
      expect(ignored(file), file).toBe(false);
    }
  });

  it('still ignores the personal working notes', () => {
    for (const file of ['IMPLEMENTATION_STATE.md', 'docs/IMPLEMENTATION_HISTORY.md']) expect(ignored(file), file).toBe(true);
  });
});
