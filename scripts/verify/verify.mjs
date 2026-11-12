#!/usr/bin/env node
/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * `npm run verify`: what CI runs on a pull request, run here.
 *
 * Passing locally has to mean passing in CI. It did not: `npm run typecheck`
 * checks three projects, people and agents ran one, and a type error only the
 * third project sees reached main (#605). So this runs CI's own commands, and
 * `verify-ci-parity.test.mjs` fails when a workflow gains a command this does
 * not run, or drops one it does.
 *
 * Every step runs, so one pass shows every failure; a failed step prints the
 * end of its output, and the whole log is kept. A step that cannot run here
 * (gitleaks not installed, no network for npm audit) is SKIPPED, said so
 * loudly, and never counted as a pass.
 *
 *   npm run verify                  every step
 *   npm run verify -- --only=typecheck,unit
 *   npm run verify -- --skip=build,audit
 *   npm run verify -- --list        the steps, and the CI commands each covers
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * CI commands that need no local step, each with the reason. Anything else a
 * pull-request workflow runs must be covered by a step below.
 */
export const NOT_RUN_LOCALLY = {
  'npm i -g npm@11': 'sets up the CI runner',
  'gitleaks version': 'prints the version on the CI runner',
  'curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" | tar -xz -C /usr/local/bin gitleaks':
    'installs gitleaks on the CI runner',
  'npm audit --audit-level=high || echo "⚠️ High-severity advisories found — review npm-audit-full.json"':
    'advisory only: it never fails the job',
  'npm audit --json > npm-audit-full.json || true': 'writes a report artifact; never fails the job',
};

/** Workflows that run on pull requests but gate nothing. */
export const NOT_GATING_WORKFLOWS = {
  'test-ids.yml': 'posts a comment listing added and removed test IDs',
};

/**
 * The steps, in the order they run. `commands` run here; `covers` are the CI
 * commands, exactly as the workflows spell them, that each step stands for.
 */
export const STEPS = [
  {
    id: 'install',
    title: 'Installed packages match package-lock.json',
    check: checkInstall,
    covers: ['npm ci --ignore-scripts'],
  },
  {
    id: 'typecheck',
    title: 'Typecheck (web, e2e and cli projects)',
    commands: ['npm run typecheck'],
    covers: ['npm run typecheck'],
  },
  {
    id: 'unit',
    title: 'Unit tests',
    commands: ['npx vitest run'],
    covers: ['npx vitest run'],
  },
  {
    id: 'lint',
    title: 'ESLint, and the security lint',
    commands: ['npx eslint .', 'npm run lint:security'],
    covers: ['npx eslint .', 'npm run lint:security'],
  },
  {
    id: 'build',
    title: 'Frontend build and first-load budget',
    commands: ['npm run build -w @foxschema/web', 'node scripts/bundle/first-load.mjs apps/web/dist --budget-gzip-kb=170'],
    covers: ['npm run build -w @foxschema/web', 'node scripts/bundle/first-load.mjs apps/web/dist --budget-gzip-kb=170'],
  },
  {
    id: 'audit',
    title: 'npm audit',
    network: true,
    commands: ['npm audit signatures', 'npm audit --audit-level=critical --omit=dev', 'npm run audit:security'],
    covers: ['npm audit signatures', 'npm audit --audit-level=critical --omit=dev', 'npm run audit:security'],
  },
  {
    id: 'deps-scan',
    title: 'Scan node_modules for backdoors and port listeners',
    commands: ['node scripts/security/scan-node-modules.mjs --fail-on high'],
    covers: [
      'npm run scan:deps-security -- --report deps-backdoor-report.json',
      'node scripts/security/scan-node-modules.mjs --fail-on high --report deps-backdoor-report.json',
    ],
  },
  {
    id: 'secrets',
    title: 'Gitleaks on this branch’s commits',
    requires: 'gitleaks',
    install: 'brew install gitleaks',
    commands: ['gitleaks detect --source . --config .gitleaks.toml --redact --log-opts origin/main...HEAD'],
    covers: [
      'gitleaks detect --source . --config .gitleaks.toml --redact --report-format sarif --report-path gitleaks.sarif --log-opts "origin/${{ github.base_ref }}...HEAD"',
      'gitleaks detect --source . --config .gitleaks.toml --redact --report-format sarif --report-path gitleaks.sarif',
    ],
  },
];

/** npm's `os` / `cpu` lists: names a package runs on, or `!name` for one it does not. */
function allows(list, value) {
  if (!list?.length) return true;
  if (list.includes(`!${value}`)) return false;
  const positive = list.filter((x) => !x.startsWith('!'));
  return positive.length === 0 || positive.includes(value);
}

/**
 * Packages installed here that differ from package-lock.json, the file
 * `npm ci` installs from in CI. A stale install answers differently from CI:
 * a package the lockfile has and node_modules lacks is a type error, or a
 * test that passes, here and not there.
 */
export function installDrift(lock, installed, platform = process.platform, arch = process.arch) {
  const drift = [];
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path.includes('node_modules/') || meta.link) continue;
    // Built for another OS or CPU: CI's runner and this machine differ by design.
    if (!allows(meta.os, platform) || !allows(meta.cpu, arch)) continue;
    const have = installed.packages?.[path];
    if (!have) drift.push(`${path.replace(/^.*node_modules\//, '')} ${meta.version} is not installed`);
    else if (meta.version && have.version !== meta.version) {
      drift.push(`${path.replace(/^.*node_modules\//, '')} is ${have.version}, the lockfile says ${meta.version}`);
    }
  }
  return drift;
}

/**
 * Folders an interrupted npm install leaves behind (`@azure/.msal-node-4mcFJMIx`).
 * The dependency scan reads them as packages, so a run here can fail on one
 * that CI's clean install never has.
 */
export function leftoverInstallFolders(nodeModules) {
  const leftover = /^\.[^.].*-[A-Za-z0-9]{8}$/;
  const found = [];
  const list = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return [];
    }
  };
  for (const entry of list(nodeModules)) {
    if (leftover.test(entry.name)) found.push(entry.name);
    else if (entry.name.startsWith('@')) {
      for (const inner of list(join(nodeModules, entry.name))) {
        if (leftover.test(inner.name)) found.push(`${entry.name}/${inner.name}`);
      }
    }
  }
  return found;
}

function checkInstall() {
  const hidden = join(ROOT, 'node_modules/.package-lock.json');
  if (!existsSync(hidden)) return { ok: false, output: 'node_modules has no record of what npm installed. Run: npm ci' };
  const drift = [
    ...leftoverInstallFolders(join(ROOT, 'node_modules')).map((f) => `${f} is left over from an interrupted install`),
    ...installDrift(
      JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')),
      JSON.parse(readFileSync(hidden, 'utf8'))
    ),
  ];
  if (drift.length === 0) return { ok: true, output: '' };
  return {
    ok: false,
    output: [
      `${drift.length} difference(s) from a clean install of package-lock.json, which is what CI runs (npm ci):`,
      ...drift.slice(0, 15).map((d) => `  ${d}`),
      ...(drift.length > 15 ? [`  …and ${drift.length - 15} more`] : []),
      'Run: npm ci   (later steps would otherwise answer differently from CI)',
    ].join('\n'),
  };
}

const has = (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;

function withoutForceColor(env) {
  const copy = { ...env };
  delete copy.FORCE_COLOR;
  return copy;
}

/** Runs one command (no shell: arguments split on spaces), appending its output to `log`. */
function runCommand(command, log) {
  const [bin, ...args] = command.split(' ');
  return new Promise((done) => {
    const child = spawn(bin, args, {
      cwd: ROOT,
      // Plain text for the logs. Some tools read any FORCE_COLOR, even "0", as "force colour".
      env: { ...withoutForceColor(process.env), NO_COLOR: '1' },
      shell: process.platform === 'win32',
    });
    const chunks = [`$ ${command}\n`];
    child.stdout.on('data', (d) => chunks.push(d.toString()));
    child.stderr.on('data', (d) => chunks.push(d.toString()));
    child.on('error', (e) => {
      chunks.push(`${e.message}\n`);
      log.push(chunks.join(''));
      done(127);
    });
    child.on('close', (code) => {
      log.push(chunks.join(''));
      done(code ?? 1);
    });
  });
}

const offline = (text) => /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network request .* failed/i.test(text);

/** The CI Node major version, for a warning when this machine runs another. */
function ciNodeMajor() {
  const m = /node-version:\s*['"]?(\d+)/.exec(readFileSync(join(ROOT, '.github/workflows/build-gate.yml'), 'utf8'));
  return m ? Number(m[1]) : undefined;
}

function parseArgs(argv) {
  const list = (name) =>
    argv
      .find((a) => a.startsWith(`--${name}=`))
      ?.slice(name.length + 3)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return { only: list('only'), skip: list('skip') ?? [], listOnly: argv.includes('--list') };
}

const tail = (text, lines = 60) => text.trimEnd().split('\n').slice(-lines).join('\n');
const seconds = (ms) => `${(ms / 1000).toFixed(0)}s`;

async function main() {
  const { only, skip, listOnly } = parseArgs(process.argv.slice(2));
  const unknown = [...(only ?? []), ...skip].filter((id) => !STEPS.some((s) => s.id === id));
  if (unknown.length) {
    console.error(`Unknown step(s): ${unknown.join(', ')}. Steps: ${STEPS.map((s) => s.id).join(', ')}`);
    process.exit(2);
  }
  if (listOnly) {
    for (const s of STEPS) {
      console.log(`${s.id.padEnd(10)} ${s.title}`);
      for (const c of s.covers) console.log(`           CI: ${c}`);
    }
    return;
  }

  const ciNode = ciNodeMajor();
  const here = Number(process.versions.node.split('.')[0]);
  if (ciNode && ciNode !== here) console.log(`Note: Node ${here} here, Node ${ciNode} in CI.\n`);

  const logDir = join(tmpdir(), `foxschema-verify-${Date.now()}`);
  mkdirSync(logDir, { recursive: true });
  const results = [];
  for (const step of STEPS) {
    if ((only && !only.includes(step.id)) || skip.includes(step.id)) {
      results.push({ step, status: 'not run', reason: 'left out on the command line' });
      continue;
    }
    if (step.requires && !has(step.requires)) {
      results.push({ step, status: 'SKIPPED', reason: `${step.requires} is not installed (${step.install})` });
      console.log(`SKIPPED  ${step.title}: ${step.requires} is not installed`);
      continue;
    }
    // A progress line only on a terminal, where the result overwrites it.
    const tty = process.stdout.isTTY;
    if (tty) process.stdout.write(`…        ${step.title}`);
    const line = (text) => process.stdout.write(`${tty ? '\r' : ''}${text}\n`);
    const started = Date.now();
    const log = [];
    let ok = true;
    if (step.check) {
      const r = step.check();
      ok = r.ok;
      log.push(r.output);
    } else {
      for (const command of step.commands) {
        if ((await runCommand(command, log)) !== 0) ok = false;
      }
    }
    const output = log.join('\n');
    const file = join(logDir, `${step.id}.log`);
    writeFileSync(file, output);
    const took = seconds(Date.now() - started);
    if (!ok && step.network && offline(output)) {
      results.push({ step, status: 'SKIPPED', reason: 'no network', file });
      line(`SKIPPED  ${step.title}: no network (${took})`);
    } else if (ok) {
      results.push({ step, status: 'pass', file });
      line(`pass     ${step.title} (${took})`);
    } else {
      results.push({ step, status: 'FAIL', file });
      line(`FAIL     ${step.title} (${took})`);
      console.log(`\n${tail(output)
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n')}\n    Full log: ${file}\n`);
    }
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIPPED' || r.status === 'not run');
  console.log('');
  const ciFailures = failed.filter((r) => r.step.id !== 'install');
  if (ciFailures.length) console.log(`FAILED: ${ciFailures.map((r) => r.step.id).join(', ')}. CI would fail too.`);
  if (failed.some((r) => r.step.id === 'install')) {
    console.log('FAILED: install. This machine’s packages differ from what CI installs, so the other results may not match CI. Run npm ci.');
  }
  if (!failed.length) console.log('All steps that ran pass, as they would in CI.');
  if (skipped.length) {
    console.log(
      `Not checked here: ${skipped.map((r) => `${r.step.id} (${r.reason})`).join('; ')}. CI still runs them.`
    );
  }
  console.log('CI only: CodeQL (on main), and the test-ID comment on the pull request.');
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
