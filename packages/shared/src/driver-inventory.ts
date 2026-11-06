/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What GET /api/system/drivers answers: one row per npm driver package the
 * app can load (several dialects share pg / mysql2 / mssql). Used by the
 * Drivers card on Home, under Services.
 */

export interface DriverInventoryItem {
  packageName: string;
  /** Dialects that load through this package, in registry order. */
  dialects: string[];
  /** Written names for `dialects`, same order. */
  labels: string[];
  installed: boolean;
  version?: string;
  /**
   * Present after a version check (`?latest=1`). `null` means the registry
   * did not answer for this package.
   */
  latest?: string | null;
  updateAvailable: boolean;
  /**
   * Required for Fox Schema itself (`better-sqlite3` for the metadata store).
   * Those cannot be removed.
   */
  bundled: boolean;
  /** Installed and not bundled — Remove is offered. */
  removable: boolean;
  installCommand?: string;
  error?: string;
}

export interface DriverInventoryReport {
  drivers: DriverInventoryItem[];
  checkedAt: number;
  /** True when `latest` was asked for on this response. */
  latestChecked: boolean;
}
