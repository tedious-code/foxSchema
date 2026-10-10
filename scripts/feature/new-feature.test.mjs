/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The feature scaffold. Its registry edits run against the real registry
 * files, so a change to one of them that the scaffold can no longer edit fails
 * here rather than for the next person who adds a feature.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PATHS,
  addContractRoute,
  addViewId,
  applyPlan,
  invalidId,
  namesFor,
  planFeature,
  registerServerFeature,
  registerView,
  serverFiles,
  webFiles,
} from './new-feature.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const n = namesFor('audit-log');

describe('ids and names', () => {
  it('accepts kebab-case and refuses anything else, and the shell’s own names', () => {
    for (const ok of ['audit-log', 'reports', 'db2-tools']) expect(invalidId(ok), ok).toBeNull();
    for (const bad of ['Audit', 'audit_log', 'audit--log', 'audit-', '-audit', '2fa', '', 'settings', 'home']) {
      expect(invalidId(bad), bad).not.toBeNull();
    }
  });

  it('derives the spellings each side uses', () => {
    expect(namesFor('audit-log')).toEqual({ id: 'audit-log', camel: 'auditLog', pascal: 'AuditLog', title: 'Audit log' });
    expect(namesFor('reports')).toMatchObject({ camel: 'reports', pascal: 'Reports' });
  });
});

describe('registry edits, on the real files', () => {
  it('imports the server feature after the others and appends it to FEATURES', () => {
    const out = registerServerFeature(read(PATHS.serverRegistry), n);
    expect(out).toContain("import { auditLogFeature } from '../features/audit-log';");
    const list = out.slice(out.indexOf('export const FEATURES'), out.indexOf('];', out.indexOf('export const FEATURES')));
    expect(list.trimEnd().endsWith('auditLogFeature,')).toBe(true);
    expect(() => registerServerFeature(out, n)).toThrow(/already imports/);
  });

  it('lists the starter route in the contract table and raises the count by one', () => {
    const src = read(PATHS.contract);
    const was = Number(/expect\(ROUTES\.length\)\.toBe\((\d+)\)/.exec(src)[1]);
    const out = addContractRoute(src, n);
    expect(out).toContain(`expect(ROUTES.length).toBe(${was + 1});`);
    const table = out.slice(out.indexOf('const ROUTES'), out.indexOf('\n];', out.indexOf('const ROUTES')));
    expect(table).toContain("{ method: 'GET', path: '/api/audit-log', status: 200 },");
    expect(() => addContractRoute(out, n)).toThrow(/already lists/);
  });

  it('adds the view id and a registry entry that loads the view', () => {
    const ids = addViewId(read(PATHS.viewIds), n);
    expect(ids).toMatch(/VIEW_IDS = \[[^\]]*'auditLog'\] as const/);
    expect(() => addViewId(ids, n)).toThrow(/exists already/);
    const reg = registerView(read(PATHS.viewRegistry), n);
    expect(reg).toContain("  auditLog: { load: () => import('@/features/audit-log/view') },\n  settings: {");
  });
});

describe('templates', () => {
  it('import only modules that exist', () => {
    const files = { ...serverFiles(n), ...webFiles(n) };
    const own = new Set(Object.keys(files).map((f) => f.replace(/\.tsx?$/, '')));
    for (const [file, src] of Object.entries(files)) {
      for (const [, spec] of src.matchAll(/from '([^']+)'/g)) {
        if (!spec.startsWith('.') && !spec.startsWith('@/')) continue;
        const base = spec.startsWith('@/')
          ? path.join('apps/web/src/frontend', spec.slice(2))
          : path.normalize(path.join(path.dirname(file), spec));
        const found = own.has(base) || ['.ts', '.tsx'].some((ext) => fs.existsSync(path.join(ROOT, base + ext)));
        expect(found, `${file} → ${spec}`).toBe(true);
      }
    }
  });

  it('name files the way the naming rules ask', () => {
    for (const file of Object.keys(serverFiles(n))) expect(path.basename(file)).toMatch(/^(index|audit-log\.[a-z.]+)\.ts$/);
    expect(Object.keys(webFiles(n)).map((f) => path.basename(f)).sort()).toEqual(
      ['AuditLogView.test.tsx', 'AuditLogView.tsx', 'auditLogApi.ts', 'index.ts', 'view.ts']
    );
  });
});

describe('planFeature and applyPlan', () => {
  const tmp = [];
  afterEach(() => {
    for (const dir of tmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A copy of just the files the scaffold reads, so the real tree is never written. */
  function mirror() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-new-'));
    tmp.push(dir);
    for (const rel of [PATHS.serverRegistry, PATHS.contract, PATHS.viewIds, PATHS.viewRegistry]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
    }
    return dir;
  }

  it('refuses an id a feature already has, on either side, before writing anything', () => {
    expect(() => planFeature(ROOT, 'compare')).toThrow(/exists already/);
    expect(() => planFeature(ROOT, 'workspaces', { server: false })).toThrow(/exists already/);
    expect(() => planFeature(ROOT, 'Not Kebab')).toThrow(/kebab-case/);
  });

  it('writes both sides and the four registry edits, and then refuses the same id', () => {
    const dir = mirror();
    const plan = planFeature(dir, 'audit-log');
    expect(Object.keys(plan.edits).sort()).toEqual(
      [PATHS.contract, PATHS.serverRegistry, PATHS.viewIds, PATHS.viewRegistry].sort()
    );
    applyPlan(dir, plan);
    for (const rel of Object.keys(plan.files)) expect(fs.existsSync(path.join(dir, rel)), rel).toBe(true);
    expect(fs.readFileSync(path.join(dir, PATHS.serverRegistry), 'utf8')).toContain('auditLogFeature,');
    expect(() => planFeature(dir, 'audit-log')).toThrow(/exists already/);
  });

  it('writes one side when asked, and leaves the other side’s registry alone', () => {
    const dir = mirror();
    const plan = planFeature(dir, 'audit-log', { web: false });
    expect(Object.keys(plan.edits).sort()).toEqual([PATHS.contract, PATHS.serverRegistry].sort());
    expect(Object.keys(plan.files).every((f) => f.startsWith(PATHS.serverFeatures))).toBe(true);
  });
});
