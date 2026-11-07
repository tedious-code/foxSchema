/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Features the UI currently offers, for specs that would otherwise fail on a
 * feature the app deliberately hides.
 */

/**
 * Whether Workflow is on the activity rail — mirrors `NAV_FLAGS.workflow` in
 * `apps/web/src/frontend/app/features/featureRegistry.ts`, held back for 0.3.1.
 *
 * A view is reached only through the rail or the command palette; there is no
 * URL for one. With the flag off the Workflow view cannot be opened at all, so
 * its specs have nothing to drive. Turn this back to `true` with the flag and
 * they run again unchanged.
 */
export const WORKFLOW_ON_RAIL = false;
