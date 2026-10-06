/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Connection settings — a facade over `@foxschema/sql`, like the rest of
 * `shared/lib/`.
 *
 * This file used to be the exception: 330 lines re-implementing the whole
 * 16-dialect registry, including each engine's `buildConnectionString`. The
 * duplication was described as accepted, to keep the browser from pulling in
 * the driver runtime — but that reason does not apply. `@foxschema/sql` is
 * dependency-free and Node-free by design (`purity.test.ts`), the frontend
 * already imports it everywhere, and this module was already delegating half
 * its dialects to it.
 *
 * What the copy cost, before it went:
 *
 * - `postgres.schemaRequired` disagreed with the canonical registry — the form
 *   marked Schema optional and saved, then `POST /schema/load` refused the
 *   connection because it reads the canonical value. Fixed in
 *   `packages/sql/src/providers/postgres/postgres.settings.ts`.
 * - the "adding a dialect" checklist carried a step for updating this file,
 *   which is exactly the kind of step that gets missed.
 *
 * `Dialect` and `isFileDialect` moved into `@foxschema/sql` so this could
 * become a pure re-export; the registry has one home again.
 */
export {
  PROVIDER_SETTINGS,
  getProviderSettings,
  buildConnectionString,
  withConnectionString,
  isFileDialect,
  dialectFamily,
  DEFAULT_PORTS,
  connectionNeedsSecret,
  authMethodsForDialect,
  dialectOffersAuthMethods,
  normalizeAuthMethod,
  resolveAuthMethod,
  parseWindowsAccount,
  assertWindowsAccount,
  passwordFieldLabel,
  type Dialect,
  type ConnectionOptions,
  type ConnectionAuthMethod,
  type ProviderConnectionSettings,
  /** The registry entry type. Named `ProviderSettings` here for the callers that used it. */
  type ProviderConnectionSettings as ProviderSettings,
} from '@foxschema/ui-shared';
