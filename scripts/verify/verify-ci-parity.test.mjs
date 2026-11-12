/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * `npm run verify` must stay what CI runs on a pull request. When a workflow
 * gains a command, this names it until a verify step covers it (or it is
 * listed in NOT_RUN_LOCALLY with a reason); when a workflow drops one, this
 * names the step still claiming it. Drift between the local gate and CI's is
 * how a type error only CI's typecheck saw reached main (#605).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readWorkflows, runCommands, runsOnPullRequests } from './ci-commands.mjs';
import { NOT_GATING_WORKFLOWS, NOT_RUN_LOCALLY, STEPS, installDrift, leftoverInstallFolders } from './verify.mjs';

const WORKFLOWS = resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows');
const gating = readWorkflows(WORKFLOWS).filter((w) => w.pullRequest && !(w.file in NOT_GATING_WORKFLOWS));
const ciCommands = new Set(gating.flatMap((w) => w.commands));
const covered = new Set(STEPS.flatMap((s) => s.covers));

describe('npm run verify matches CI', () => {
  it('knows every workflow that runs on pull requests', () => {
    const onPr = readWorkflows(WORKFLOWS)
      .filter((w) => w.pullRequest)
      .map((w) => w.file);
    expect(onPr).toEqual(expect.arrayContaining(Object.keys(NOT_GATING_WORKFLOWS)));
    expect(gating.length).toBeGreaterThan(0);
  });

  it('covers every command a pull-request workflow runs', () => {
    const missing = [...ciCommands].filter((c) => !covered.has(c) && !(c in NOT_RUN_LOCALLY));
    expect(missing).toEqual([]);
  });

  it('claims no command CI no longer runs', () => {
    const stale = [...covered, ...Object.keys(NOT_RUN_LOCALLY)].filter((c) => !ciCommands.has(c));
    expect(stale).toEqual([]);
  });

  it('runs CI’s own command wherever it can, not a lookalike', () => {
    // A step's command may drop report flags CI adds for its artifacts, but
    // where CI's command runs as it is, verify runs exactly that.
    for (const step of STEPS.filter((s) => s.commands)) {
      const same = step.covers.filter((c) => step.commands.includes(c));
      const reworded = step.covers.filter((c) => !step.commands.includes(c));
      for (const c of reworded) expect(c, `${step.id}: ${c}`).toMatch(/--report|gitleaks|scan:deps-security/);
      expect(same.length + reworded.length).toBe(step.covers.length);
    }
  });
});

describe('reading a workflow', () => {
  it('reads one-line and block commands, joining continuations', () => {
    const text = [
      'on:',
      '  pull_request:',
      'jobs:',
      '  a:',
      '    steps:',
      '      - run: npm ci --ignore-scripts',
      '      - name: Scan',
      '        run: |',
      '          gitleaks detect \\',
      '            --source .',
      '          # a comment',
      '          echo done',
      '      - run: "npx vitest run"',
    ].join('\n');
    expect(runsOnPullRequests(text)).toBe(true);
    expect(runCommands(text)).toEqual(['npm ci --ignore-scripts', 'gitleaks detect --source .', 'echo done', 'npx vitest run']);
    expect(runsOnPullRequests('on:\n  push:\n    branches: [main]\n')).toBe(false);
  });
});

describe('the install check', () => {
  const lock = {
    packages: {
      '': { name: 'root' },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b': { version: '2.0.0' },
      'node_modules/linux-only': { version: '1.0.0', os: ['linux'] },
      'node_modules/not-windows': { version: '1.0.0', os: ['!win32'] },
      'node_modules/x64-only': { version: '1.0.0', cpu: ['x64'] },
      'node_modules/workspace': { link: true },
      'apps/web/node_modules/c': { version: '3.0.0' },
    },
  };

  it('names what is missing or at another version, and ignores what another OS or CPU needs', () => {
    const installed = {
      packages: { 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '1.9.0' } },
    };
    expect(installDrift(lock, installed, 'darwin', 'arm64')).toEqual([
      'b is 1.9.0, the lockfile says 2.0.0',
      'not-windows 1.0.0 is not installed',
      'c 3.0.0 is not installed',
    ]);
    expect(installDrift(lock, installed, 'win32', 'x64')).toEqual([
      'b is 1.9.0, the lockfile says 2.0.0',
      'x64-only 1.0.0 is not installed',
      'c 3.0.0 is not installed',
    ]);
  });

  it('finds folders an interrupted install left behind, scoped ones too', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-nm-'));
    for (const d of ['vite', '.vite-vwHNAlXN', '@azure/msal-node', '@azure/.msal-node-4mcFJMIx', '.bin', '.cache']) {
      mkdirSync(join(root, d), { recursive: true });
    }
    writeFileSync(join(root, '.package-lock.json'), '{}');
    expect(leftoverInstallFolders(root).sort()).toEqual(['.vite-vwHNAlXN', '@azure/.msal-node-4mcFJMIx']);
  });
});
