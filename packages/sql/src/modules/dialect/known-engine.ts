/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Whether Fox Schema knows an engine at all. A dialect fact, not a feature
 * check: the query subset and the capability table both ask it.
 */
import { PROVIDER_SETTINGS } from '../../providers/provider-settings.js';

/** Whether a connection can use this engine at all (any case). */
export function isKnownEngine(dialect: string): boolean {
  // Own keys only: `in` also finds `constructor` and `__proto__` on the
  // prototype, which then answered as engines with a function for a reason.
  return Object.hasOwn(PROVIDER_SETTINGS, (dialect || '').toLowerCase());
}
