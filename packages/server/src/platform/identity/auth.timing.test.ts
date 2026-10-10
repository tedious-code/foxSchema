/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A sign-in with an email that has no account must cost what a wrong password
 * costs — one scrypt — or response time says which emails exist. The hash it
 * is checked against is made when the module loads, never during a sign-in.
 */
import { expect, it, vi } from 'vitest';

process.env.APP_DB_PATH = ':memory:';

const hashes = vi.hoisted(() => ({ count: 0 }));
vi.mock('../crypto/crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('../crypto/crypto')>();
  return {
    ...real,
    hashPassword: (password: string) => {
      hashes.count += 1;
      return real.hashPassword(password);
    },
  };
});

import { AuthModule } from './auth.service';

it('makes no hash during a sign-in with an unknown email, the first one included', async () => {
  const auth = new AuthModule();
  await auth.getUserByToken('none'); // run migrations
  const before = hashes.count;
  await expect(auth.login('nobody@example.com', 'blue-lantern-42')).rejects.toThrow(/Invalid email or password/);
  expect(hashes.count - before).toBe(0);
});
