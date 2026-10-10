/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The registry is the shell's whole idea of which views exist, who sees them
 * and where someone goes who may not. These pin what the hand-wired shell
 * did, so moving to one list changed nothing a user can see.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMUNITY_NAV, DEFAULT_ROLE_PERMISSIONS, type Permission } from '@foxschema/shared';
import { railItems, redirectFor, WORKSPACE_VIEWS } from './featureRegistry';
import { VIEW_IDS } from './viewIds';

const FE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const canWith = (perms: readonly Permission[]) => (p: Permission) => perms.includes(p);
const can = (...perms: Permission[]) => canWith(perms);

describe('view registry', () => {
  it('defines every view id, each shown directly or loaded', () => {
    for (const id of VIEW_IDS) {
      const def = WORKSPACE_VIEWS[id];
      expect(def, id).toBeTruthy();
      expect(Boolean(def.component) !== Boolean(def.load), `${id}: exactly one of component / load`).toBe(true);
    }
    expect(Object.keys(WORKSPACE_VIEWS).sort()).toEqual([...VIEW_IDS].sort());
  });

  it('only names nav ids that COMMUNITY_NAV has', () => {
    const navIds = new Set(COMMUNITY_NAV.map((n) => n.id));
    for (const def of Object.values(WORKSPACE_VIEWS)) {
      if (def.rail?.navId) expect(navIds.has(def.rail.navId), def.rail.navId).toBe(true);
    }
  });

  it('loads each feature view from the feature’s view entry, which exists', () => {
    const src = fs.readFileSync(path.join(FE, 'app/features/featureRegistry.ts'), 'utf8');
    const specs = [...src.matchAll(/import\('(@\/[^']+)'\)/g)].map((m) => m[1]!);
    expect(specs.length).toBeGreaterThanOrEqual(8);
    for (const spec of specs) {
      const rel = spec.replace(/^@\//, '');
      const exists = ['.ts', '.tsx'].some((ext) => fs.existsSync(path.join(FE, rel + ext)));
      expect(exists, spec).toBe(true);
      const feature = /^@\/features\/([^/]+)\/(.+)$/.exec(spec);
      // A feature is loaded through its root `view*` entry, never a deep path.
      if (feature) expect(feature[2], spec).toMatch(/^view[A-Za-z]*$/);
    }
  });
});

describe('the rail', () => {
  it('shows an owner every workspace, in the order the rail always had', () => {
    expect(railItems(canWith(DEFAULT_ROLE_PERMISSIONS.owner)).map((i) => [i.view, i.label, i.testId])).toEqual([
      ['sync', 'Compare', 'view-sync-btn'],
      ['sqlEditor', 'Editor', 'view-sql-editor-btn'],
      ['utilities', 'Utils', 'view-utilities-btn'],
      ['access', 'Access', 'view-access-btn'],
      ['workflow', 'Workflow', 'view-workflow-btn'],
      ['snapshots', 'Snapshots', 'sync-pane-history-btn'],
    ]);
  });

  it('hides what a viewer may not use', () => {
    expect(railItems(canWith(DEFAULT_ROLE_PERMISSIONS.viewer)).map((i) => i.view)).toEqual([
      'sync',
      'sqlEditor',
      'access',
      'workflow',
      'snapshots',
    ]);
  });

  it('shows Snapshots for history or browse, and nothing without permissions', () => {
    expect(railItems(can('compare.history')).map((i) => i.view)).toEqual(['snapshots']);
    expect(railItems(can('schema.browse')).map((i) => i.view)).toContain('snapshots');
    expect(railItems(can()).map((i) => i.view)).toEqual([]);
  });
});

describe('redirects', () => {
  it('sends an editor-only account from Compare to the editor', () => {
    expect(redirectFor('sync', can('editor.access'))).toBe('sqlEditor');
    expect(redirectFor('sync', can('schema.browse'))).toBeNull();
    expect(redirectFor('sync', can())).toBeNull();
  });

  it('sends someone without the editor to Compare when they may use it, else Home', () => {
    expect(redirectFor('sqlEditor', can('schema.compare'))).toBe('sync');
    expect(redirectFor('sqlEditor', can())).toBe('home');
    expect(redirectFor('sqlEditor', can('editor.access'))).toBeNull();
  });

  it('sends someone without Utilities or browse home from those views', () => {
    expect(redirectFor('utilities', can())).toBe('home');
    expect(redirectFor('snapshots', can('compare.history'))).toBe('home');
    expect(redirectFor('snapshots', can('schema.browse'))).toBeNull();
  });

  it('never redirects from views that check access themselves', () => {
    for (const view of ['home', 'access', 'workflow', 'settings'] as const) expect(redirectFor(view, can())).toBeNull();
  });
});
