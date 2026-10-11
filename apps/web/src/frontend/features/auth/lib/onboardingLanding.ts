/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ActiveView, SyncPane } from '@/platform/uiStore';

export interface OnboardingLanding {
  view: ActiveView;
  syncPane?: SyncPane;
}

/**
 * Where "What would you like to do first?" takes you. The answer used to be
 * saved and then ignored — every choice landed on the same screen, so the
 * question promised something the app did not do. Skipping (no goal) keeps
 * the default workspace.
 */
export function landingForGoal(goal: string | undefined): OnboardingLanding | null {
  switch (goal) {
    case 'COMPARE_SCHEMAS':
    case 'GENERATE_SQL':
      return { view: 'sync', syncPane: 'compare' };
    case 'EXPLORE_DATABASE':
      return { view: 'sqlEditor' };
    case 'CREATE_DOCUMENTATION':
      return { view: 'sync', syncPane: 'browse' };
    default:
      return null;
  }
}
