/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { assertHttpTargetAllowed } from './http-target.js';

describe('assertHttpTargetAllowed', () => {
  it.each([
    'http://localhost/api/health',
    'http://127.0.0.1:3210/api/hooks/x',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]:3210/',
    'http://[::ffff:7f00:1]:3210/',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
  ])('refuses %s', async (url) => {
    await expect(assertHttpTargetAllowed(url, { resolveHost: false })).rejects.toThrow(/not a public address/);
  });

  it('allows a public HTTPS URL without resolving DNS when a test fetch is injected', async () => {
    await expect(
      assertHttpTargetAllowed('https://api.example.com/items', { resolveHost: false }),
    ).resolves.toBeUndefined();
  });
});
