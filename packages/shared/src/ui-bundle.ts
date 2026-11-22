/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What a signed UI bundle and the backend that serves it must agree on
 * (docs/plans/2026-11-22-signed-ui-bundles.md).
 *
 * This file imports nothing on purpose: `scripts/ui-release/ui-release.mjs`
 * loads it directly with Node's type stripping, outside any bundler.
 */

/**
 * The API contract this build of the backend and UI speaks.
 *
 * Within one number the API only grows: new endpoints, new optional fields.
 * Removing or changing an endpoint, a field or its meaning raises it. A UI
 * bundle records the number it was built against, and a backend installs a
 * bundle only when that number is one it serves.
 */
export const API_CONTRACT = 1;

/** One key UI bundles may be signed with. */
export interface UiBundlePublicKey {
  /** Short stable name, written into every signature made with this key. */
  id: string;
  /** Ed25519 public key: the JWK `x` value (32 bytes, base64url). */
  x: string;
}

/**
 * The keys a UI bundle signature is accepted from. Pinned here, never fetched:
 * whoever controls the CDN must not also be able to choose the key.
 *
 * Add the next key before retiring the current one, so a rotation never
 * leaves an installed backend unable to verify a release.
 * `node scripts/ui-release/ui-release.mjs pubkey` prints the entry for a key.
 */
export const UI_BUNDLE_PUBLIC_KEYS: readonly UiBundlePublicKey[] = [];
