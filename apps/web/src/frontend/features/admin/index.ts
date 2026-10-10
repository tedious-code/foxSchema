/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The admin feature's public API: a loader for the admin panel, which only
 * admins open, on a click.
 */
export const loadAdminAccessPanel = () =>
  import('./components/AdminAccessPanel').then((m) => ({ default: m.AdminAccessPanel }));
