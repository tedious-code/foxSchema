/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { COMMUNITY_NAV, filterNav } from './nav';
import type { Permission } from './permissions';

describe('nav registry', () => {
  it('lists Compare Access Editor Workflow top items', () => {
    expect(COMMUNITY_NAV.map((i) => i.id)).toEqual([
      'compare',
      'access',
      'editor',
      'workflow',
    ]);
  });

  it('hides Workflow when the feature flag is off', () => {
    const can = () => true;
    expect(filterNav(COMMUNITY_NAV, can, {}).map((i) => i.id)).not.toContain('workflow');
    expect(filterNav(COMMUNITY_NAV, can, { workflow: true }).map((i) => i.id)).toContain(
      'workflow',
    );
  });

  it('shows an item needing any of several permissions for each one of them', () => {
    const only = (granted: Permission) => (p: Permission) => p === granted;
    expect(filterNav(COMMUNITY_NAV, only('schema.compare')).map((i) => i.id)).toContain('compare');
    expect(filterNav(COMMUNITY_NAV, only('schema.browse')).map((i) => i.id)).toContain('compare');
    expect(filterNav(COMMUNITY_NAV, only('editor.access')).map((i) => i.id)).not.toContain('compare');
  });

  it('filters Access children by permission', () => {
    const granted = new Set<Permission>(['access.access', 'access.users']);
    const can = (p: Permission) => granted.has(p);
    const access = filterNav(COMMUNITY_NAV, can, {}).find((i) => i.id === 'access');
    expect(access?.children?.map((c) => c.id)).toEqual(['access.users']);
  });
});
