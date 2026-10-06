/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * `shared/lib/provider-settings.ts` must stay a re-export, not become a copy
 * again.
 *
 * It was a copy for a long time: 330 lines re-implementing the 16-dialect
 * registry, which drifted from the canonical one on `postgres.schemaRequired`
 * and broke schema browsing for any PostgreSQL connection saved without a
 * schema. This replaces the parity suite that used to compare the two — there
 * is only one registry now, so the thing worth asserting is that it stays that
 * way.
 *
 * Identity, not equality: a re-export yields the *same object*, a copy only an
 * equal one. That is the difference this test exists to catch.
 */
import { describe, expect, it } from 'vitest';
import * as core from '@foxschema/ui-shared';
import * as facade from './provider-settings';

describe('provider-settings is a facade over @foxschema/sql', () => {
  it('re-exports the registry itself, not a clone of it', () => {
    expect(facade.PROVIDER_SETTINGS).toBe(core.PROVIDER_SETTINGS);
  });

  it('re-exports each helper by reference', () => {
    expect(facade.getProviderSettings).toBe(core.getProviderSettings);
    expect(facade.buildConnectionString).toBe(core.buildConnectionString);
    expect(facade.withConnectionString).toBe(core.withConnectionString);
    expect(facade.isFileDialect).toBe(core.isFileDialect);
    expect(facade.DEFAULT_PORTS).toBe(core.DEFAULT_PORTS);
    expect(facade.connectionNeedsSecret).toBe(core.connectionNeedsSecret);
  });

  it('exposes every dialect the canonical registry has', () => {
    expect(Object.keys(facade.PROVIDER_SETTINGS).sort()).toEqual(
      Object.keys(core.PROVIDER_SETTINGS).sort()
    );
  });

  it('agrees with the canonical registry on PostgreSQL, the field that drifted', () => {
    expect(facade.getProviderSettings('postgres').schemaRequired).toBe(false);
    expect(facade.getProviderSettings('postgres').defaultSchema).toBe('public');
  });

  it('still knows which dialects are files on disk', () => {
    expect(facade.isFileDialect('sqlite')).toBe(true);
    expect(facade.isFileDialect('duckdb')).toBe(true);
    expect(facade.isFileDialect('postgres')).toBe(false);
  });
});
