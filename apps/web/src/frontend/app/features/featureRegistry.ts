/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every workspace view, in one typed list: where it sits on the activity
 * rail, who may see it, where someone goes who may not, what it adds to the
 * top toolbar, and where its code comes from. App.tsx, the rail and prefetch all read this; adding a view
 * touches no shell file.
 *
 * Code loads on demand. A feature's view is its `view.ts` entry, never its
 * barrel, so opening the rail does not drag a feature's other exports in.
 * Calling a loader twice fetches once: the browser keeps each module after its
 * first import, and React.lazy then resolves from that copy.
 *
 * Visibility here is not authorization: every API the views call checks
 * permissions on the server.
 */
import type { ComponentType, ElementType } from 'react';
import { Camera, GitCompareArrows, ShieldCheck, Terminal, Workflow, Wrench } from 'lucide-react';
import { COMMUNITY_NAV, filterNav, type Permission } from '@foxschema/shared';
import { HomeView } from '@/app/shell/HomeView';
import { CompareToolbarBelow, CompareToolbarEnd, CompareToolbarStart } from '@/features/compare/toolbar';
import { HistoryToolbar } from '@/features/lokee-weave/toolbar';
import type { ActiveView } from './viewIds';

export type Can = (permission: Permission) => boolean;

export interface RailButton {
  icon: ElementType;
  testId: string;
  /** A COMMUNITY_NAV top-level id: the label and the permission come from there. */
  navId?: string;
  /** Without `navId`: the label, and who sees the button. */
  label?: string;
  visible?: (can: Can) => boolean;
}

/**
 * What a view adds to the top toolbar while it is shown. The shell keeps its
 * own controls (activity, command palette) at the first row's end. These load
 * with the first page, like the toolbar.
 */
export interface ViewToolbar {
  /** Leads the first row. */
  start?: ComponentType;
  /** At the first row's end, after the shell's controls. */
  end?: ComponentType;
  /** A second row. */
  below?: ComponentType;
}

export interface WorkspaceViewDefinition {
  /** A button in the rail's main group, in registry order. Home and Preferences have fixed places. */
  rail?: RailButton;
  /** Whether this account may be shown the view. Absent: always. */
  allowed?: (can: Can) => boolean;
  /** Where to go instead when `allowed` says no. Default: Home. */
  fallback?: (can: Can) => ActiveView;
  /** The view: loaded on first show, or when its rail button is reached. */
  load?: () => Promise<{ default: ComponentType }>;
  /** Shown without loading (the first screen). */
  component?: ComponentType;
  /** What the view loads lazily inside itself, worth starting along with it on a likely click. */
  inside?: () => Promise<unknown>;
  toolbar?: ViewToolbar;
}

export const WORKSPACE_VIEWS: Record<ActiveView, WorkspaceViewDefinition> = {
  home: { component: HomeView },
  sync: {
    rail: { navId: 'compare', icon: GitCompareArrows, testId: 'view-sync-btn' },
    // Someone who may only use the editor lands there rather than on an empty Compare.
    allowed: (can) => can('schema.browse') || can('schema.compare') || !can('editor.access'),
    fallback: () => 'sqlEditor',
    load: () => import('@/features/compare/view'),
    toolbar: { start: CompareToolbarStart, end: CompareToolbarEnd, below: CompareToolbarBelow },
  },
  sqlEditor: {
    rail: { navId: 'editor', icon: Terminal, testId: 'view-sql-editor-btn' },
    allowed: (can) => can('editor.access'),
    fallback: (can) => (can('schema.browse') || can('schema.compare') ? 'sync' : 'home'),
    load: () => import('@/features/sql-editor/view'),
    // The editor's pane brings Monaco, the longest wait in the app.
    inside: () => import('@/features/sql-editor/viewPane'),
  },
  utilities: {
    rail: { label: 'Utils', icon: Wrench, testId: 'view-utilities-btn', visible: (can) => can('utility.access') },
    allowed: (can) => can('utility.access'),
    load: () => import('@/features/utilities/view'),
  },
  access: {
    rail: { navId: 'access', icon: ShieldCheck, testId: 'view-access-btn' },
    load: () => import('@/features/access/view'),
  },
  workflow: {
    rail: { navId: 'workflow', icon: Workflow, testId: 'view-workflow-btn' },
    load: () => import('@/features/workflow/view'),
  },
  snapshots: {
    rail: {
      label: 'Snapshots',
      icon: Camera,
      testId: 'sync-pane-history-btn',
      visible: (can) => can('compare.history') || can('schema.browse'),
    },
    allowed: (can) => can('schema.browse'),
    load: () => import('@/features/lokee-weave/view'),
    toolbar: { start: HistoryToolbar },
  },
  settings: { load: () => import('@/app/settings/SettingsView') },
};

/** Workflow is on in this edition; flags gate nav items, not routes. */
const NAV_FLAGS = { workflow: true } as const;

export interface RailItem {
  view: ActiveView;
  label: string;
  icon: ElementType;
  testId: string;
}

/** The rail's main buttons this account sees, in order. */
export function railItems(can: Can): RailItem[] {
  const nav = new Map(filterNav(COMMUNITY_NAV, can, NAV_FLAGS).map((item) => [item.id, item]));
  const out: RailItem[] = [];
  for (const [view, def] of Object.entries(WORKSPACE_VIEWS) as [ActiveView, WorkspaceViewDefinition][]) {
    const rail = def.rail;
    if (!rail) continue;
    if (rail.navId) {
      const item = nav.get(rail.navId);
      if (item) out.push({ view, label: item.label, icon: rail.icon, testId: rail.testId });
    } else if (rail.visible?.(can) ?? true) {
      out.push({ view, label: rail.label ?? view, icon: rail.icon, testId: rail.testId });
    }
  }
  return out;
}

/** Where to send someone who is on `view` but may not be: null when they may stay. */
export function redirectFor(view: ActiveView, can: Can): ActiveView | null {
  const def = WORKSPACE_VIEWS[view];
  if (!def.allowed || def.allowed(can)) return null;
  return def.fallback?.(can) ?? 'home';
}

/**
 * Start loading a view's code ahead of a likely click. `inside` also loads what
 * the view loads lazily; startup leaves it out, because Monaco's setup would
 * compete with the first screen. Failures are left to the click.
 */
export function prefetchView(view: ActiveView, { inside = true }: { inside?: boolean } = {}): void {
  const def = WORKSPACE_VIEWS[view];
  void def.load?.().catch(() => undefined);
  if (inside) void def.inside?.().catch(() => undefined);
}
