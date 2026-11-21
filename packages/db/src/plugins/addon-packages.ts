/**
 * Fox Schema (@foxschema/db)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which dialects come from an add-on package. Kept apart from the plugin
 * registry so the adapter and provider registries can name the add-on in
 * their errors without importing the registry that imports them.
 */
/** Add-on package for each dialect that is not built in. */
const ADDON_PACKAGES: Readonly<Record<string, string>> = { db2: '@foxschema/db-db2' };

/** The add-on package that provides a dialect, when it is not built in. */
export function addonPackageFor(dialect: string): string | undefined {
  const key = dialect.toLowerCase();
  return Object.hasOwn(ADDON_PACKAGES, key) ? ADDON_PACKAGES[key] : undefined;
}

/** Every dialect that comes from an add-on, registered or not. */
export function addonDialects(): string[] {
  return Object.keys(ADDON_PACKAGES);
}

/** The error for an add-on dialect whose package is not installed. */
export function missingAddonMessage(dialect: string): string {
  const pkg = addonPackageFor(dialect);
  return `${dialect} support is an add-on: npm install ${pkg}`;
}
