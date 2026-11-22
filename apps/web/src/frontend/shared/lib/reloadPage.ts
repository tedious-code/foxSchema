/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reload the page. Its own module so a test can replace it.
 */
export function reloadPage(): void {
  window.location.reload();
}
