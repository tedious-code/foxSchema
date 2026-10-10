/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The migrations feature's public API: a loader for the history panel, which
 * opens from the rail on a click.
 */
export const loadMigrationHistory = () =>
  import('./components/MigrationHistory').then((m) => ({ default: m.MigrationHistory }));
