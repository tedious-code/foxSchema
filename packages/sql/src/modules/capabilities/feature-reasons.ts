/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The sentences a feature check gives when it has no engine-specific reason,
 * shared by the full capability table and the lighter schema-compare check so
 * the two always say the same thing.
 */
import { PROVIDER_SETTINGS } from '../../providers/provider-settings.js';

/** The engine's own name, so a sentence does not read "mongodb has no…". */
export function engineLabel(key: string): string {
  return PROVIDER_SETTINGS[key]?.label ?? key;
}

/** Whether a connection can use this engine at all (any case). */
export function isKnownEngine(dialect: string): boolean {
  return (dialect || '').toLowerCase() in PROVIDER_SETTINGS;
}

/** For an engine Fox Schema does not know. */
export function unknownEngineReason(dialect: string, feature: string): string {
  return `Fox Schema does not know ${dialect || 'this engine'}, so it cannot offer ${feature}.`;
}

/** For a known engine whose feature is unavailable and nothing says why. */
export function fallbackReason(key: string, feature: string): string {
  return `Fox Schema does not offer ${feature} for ${engineLabel(key)}.`;
}
