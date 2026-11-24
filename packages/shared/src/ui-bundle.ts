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

/** Default Cloudflare Workers CDN feed serving signed UI bundles. */
export const DEFAULT_FOX_UI_FEED_URL = 'https://fox-ui.foxschema.workers.dev';

/** Limits enforced on both the bundler and the backend installer. */
export const UI_BUNDLE_MAX_FILES = 2000;
export const UI_BUNDLE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export interface UiBundleEnvelope {
  schema: number;
  alg: 'Ed25519';
  keyId: string;
  signature: string;
  payload: string;
}

export interface UiBundleChannelEntry {
  version: string;
  sequence: number;
  manifest: string;
  sha256: string;
}

export interface UiBundleChannel {
  schema: number;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  releases: Record<string, UiBundleChannelEntry>;
}

export interface UiBundleManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface UiBundleManifest {
  schema: number;
  version: string;
  sequence: number;
  apiContract: number;
  publishedAt: string;
  pack: { sha256: string; size: number };
  files: UiBundleManifestFile[];
}

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
