/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resetSetupCode, setupCode, setupCodeMatches } from './setup-code';

describe('setup-code (derived from install encryption key)', () => {
  const prevAppKey = process.env.APP_ENCRYPTION_KEY;
  const prevFlowKey = process.env.FOXFLOW_ENCRYPTION_KEY;

  afterEach(() => {
    if (prevAppKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = prevAppKey;
    if (prevFlowKey === undefined) delete process.env.FOXFLOW_ENCRYPTION_KEY;
    else process.env.FOXFLOW_ENCRYPTION_KEY = prevFlowKey;
    resetSetupCode();
  });

  it('derives a deterministic XXXX-XXXX code from APP_ENCRYPTION_KEY and rotates on resetSetupCode', () => {
    process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64);
    const first = setupCode();
    expect(first).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(setupCode()).toBe(first);

    // Matching works case-insensitively, with or without the hyphen, and also accepts the raw key.
    expect(setupCodeMatches(first)).toBe(true);
    expect(setupCodeMatches(first.toLowerCase())).toBe(true);
    expect(setupCodeMatches(first.replace('-', ''))).toBe(true);
    expect(setupCodeMatches('a'.repeat(64))).toBe(true);
    expect(setupCodeMatches('A'.repeat(64))).toBe(true);
    expect(setupCodeMatches('0000-0000')).toBe(false);

    // Rotating the code changes the derived token.
    resetSetupCode();
    const rotated = setupCode();
    expect(rotated).not.toBe(first);
    expect(setupCodeMatches(rotated)).toBe(true);
    expect(setupCodeMatches(first)).toBe(false);
  });
});
