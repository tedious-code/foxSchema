/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The workspace views the shell can show. Kept apart from the registry, with
 * no imports, so the UI store can validate a persisted view without loading
 * the registry's icons and components.
 *
 * Adding a view: add its id here; TypeScript then requires its entry in
 * `featureRegistry.ts`.
 */
export const VIEW_IDS = ['home', 'sync', 'sqlEditor', 'utilities', 'access', 'workflow', 'snapshots', 'settings'] as const;

export type ActiveView = (typeof VIEW_IDS)[number];

export function isActiveView(value: unknown): value is ActiveView {
  return typeof value === 'string' && (VIEW_IDS as readonly string[]).includes(value);
}
