/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Navigation registry — one source for the activity rail, deep links, and RBAC.
 * Community ships an implicit workspace (`local`); enterprise packages may
 * filter by feature flags later without forking the shell.
 */
import type { Permission } from './permissions';

export type NavFeatureFlag = 'workflow' | 'enterprise.channels';

export interface NavItem {
  id: string;
  label: string;
  /** Hide the item when the actor has none of these (one, or any of a list). */
  permission?: Permission | readonly Permission[];
  children?: NavItem[];
  featureFlag?: NavFeatureFlag;
}

/** Community information architecture (Compare · Access · Editor · Workflow). */
export const COMMUNITY_NAV: NavItem[] = [
  {
    id: 'compare',
    label: 'Compare',
    // Browsing or comparing: either is a reason to open the workspace.
    permission: ['schema.browse', 'schema.compare'],
    children: [
      { id: 'compare.compare', label: 'Compare', permission: 'schema.compare' },
      { id: 'compare.browse', label: 'Browse', permission: 'schema.browse' },
      { id: 'compare.history', label: 'History', permission: 'compare.history' },
    ],
  },
  {
    id: 'access',
    label: 'Access',
    permission: 'access.access',
    children: [
      { id: 'access.users', label: 'Users', permission: 'access.users' },
      {
        id: 'access.permissions',
        label: 'Permissions',
        permission: 'access.builder',
        children: [
          { id: 'access.builder', label: 'Builder', permission: 'access.builder' },
          { id: 'access.diff', label: 'Insight', permission: 'access.diff' },
          { id: 'access.inspector', label: 'Inspector', permission: 'access.inspector' },
        ],
      },
      { id: 'access.report', label: 'Report', permission: 'access.report' },
    ],
  },
  {
    id: 'editor',
    label: 'Editor',
    permission: 'editor.access',
    children: [{ id: 'editor.main', label: 'Editor', permission: 'editor.access' }],
  },
  {
    id: 'workflow',
    label: 'Workflow',
    permission: 'workflow.access',
    featureFlag: 'workflow',
    children: [
      { id: 'workflow.designer', label: 'Designer', permission: 'workflow.design' },
      { id: 'workflow.runs', label: 'Runs', permission: 'workflow.run' },
      { id: 'workflow.engine', label: 'Control panel', permission: 'workflow.admin' },
      { id: 'workflow.variables', label: 'Variables', permission: 'workflow.design' },
    ],
  },
];

export function filterNav(
  items: NavItem[],
  can: (permission: Permission) => boolean,
  flags: Partial<Record<NavFeatureFlag, boolean>> = {},
): NavItem[] {
  const out: NavItem[] = [];
  for (const item of items) {
    if (item.featureFlag && !flags[item.featureFlag]) continue;
    const needs = typeof item.permission === 'string' ? [item.permission] : item.permission;
    if (needs && !needs.some((p) => can(p))) continue;
    const children = item.children ? filterNav(item.children, can, flags) : undefined;
    out.push(children ? { ...item, children } : { ...item });
  }
  return out;
}
