/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * `foxschema open` signs the owner in with a launch link while they have no
 * account, and otherwise opens the plain address. A launch link is a
 * convenience: when one cannot be made, Fox still opens.
 */
import { describe, expect, it } from 'vitest';
import { launchAddress } from '../launchLink';

const prepare = () => undefined;

describe('launchAddress', () => {
  it('carries the token in the fragment, where no server log sees it', async () => {
    const target = await launchAddress('http://localhost:3210', { prepare, issue: async () => 'tok_-AZ09' });
    expect(target).toEqual({ url: 'http://localhost:3210/#launch=tok_-AZ09', launched: true });
  });

  it('opens the plain address once the owner has an account', async () => {
    expect(await launchAddress('http://localhost:3210', { prepare, issue: async () => null })).toEqual({
      url: 'http://localhost:3210',
      launched: false,
    });
  });

  it('still opens Fox when the link cannot be made', async () => {
    const failing = await launchAddress('http://localhost:3210', {
      prepare,
      issue: async () => {
        throw new Error('database is locked');
      },
    });
    expect(failing).toEqual({ url: 'http://localhost:3210', launched: false });
    const noEnv = await launchAddress('http://localhost:3210', {
      prepare: () => {
        throw new Error('no key');
      },
      issue: async () => 'never-reached',
    });
    expect(noEnv.launched).toBe(false);
  });
});
