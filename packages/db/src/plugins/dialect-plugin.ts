/**
 * Fox Schema (@foxschema/db)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dialects that ship as an add-on package instead of inside @foxschema/db.
 *
 * Db2 is the first: its driver (`ibm_db`, ~59 MB with the IBM CLI driver) is
 * too heavy to make every user of this package download. The add-on brings the
 * adapter and schema provider and registers them here; this package keeps no
 * Db2 code of its own.
 *
 * A host that always wants the dialect (the Fox app, the CLI) registers the
 * plugin at startup. A library user just connects: the first `openDatabase` or
 * `ConnectionFactory.create` for an add-on dialect imports the add-on, and a
 * missing add-on says which package to install.
 */
import { ADAPTERS } from '../providers/adapter-registry.js';
import { PROVIDERS } from '../providers/provider-registry.js';
import { addonPackageFor, missingAddonMessage } from './addon-packages.js';
import { plugins, type DialectPlugin } from './plugin-store.js';

export { dialectPlugin, type DialectPlugin, type DriverProblem } from './plugin-store.js';

/**
 * Register an add-on dialect. Registering the same plugin again is a no-op;
 * registering a different implementation for a dialect already taken throws,
 * so two copies of an add-on cannot silently replace each other.
 */
export function registerDialectPlugin(plugin: DialectPlugin): void {
  const key = plugin.dialect.toLowerCase();
  const existing = plugins.get(key);
  if (existing) {
    if (existing.adapter === plugin.adapter && existing.provider === plugin.provider) return;
    throw new Error(`A different plugin is already registered for dialect "${key}".`);
  }
  if (ADAPTERS[key] || PROVIDERS[key]) {
    throw new Error(`Dialect "${key}" is built into @foxschema/db; it cannot be registered as a plugin.`);
  }
  plugins.set(key, plugin);
  ADAPTERS[key] = plugin.adapter;
  PROVIDERS[key] = plugin.provider;
}

function isModuleNotFound(error: unknown, pkg: string): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && message.includes(pkg);
}

/**
 * Import and register the add-on for `dialect` when it is not registered yet.
 * True when the dialect is usable afterwards. A missing add-on is false; an
 * add-on that is present but fails to load rethrows its own error.
 */
export async function loadDialectPlugin(dialect: string): Promise<boolean> {
  const key = dialect.toLowerCase();
  if (plugins.has(key)) return true;
  const pkg = addonPackageFor(key);
  if (!pkg) return false;
  let mod: { dialectPlugin?: DialectPlugin };
  try {
    // A variable specifier on purpose: @foxschema/db must not depend on its
    // add-ons, at build time or in a bundle.
    mod = (await import(pkg)) as { dialectPlugin?: DialectPlugin };
  } catch (error) {
    if (isModuleNotFound(error, pkg)) return false;
    throw error;
  }
  if (!mod.dialectPlugin) throw new Error(`${pkg} does not export a dialectPlugin.`);
  registerDialectPlugin(mod.dialectPlugin);
  return true;
}

/** Load the add-on for `dialect` if it has one, or throw the install hint. */
export async function ensureDialect(dialect: string): Promise<void> {
  if (!addonPackageFor(dialect) || plugins.has(dialect.toLowerCase())) return;
  if (!(await loadDialectPlugin(dialect))) throw new Error(missingAddonMessage(dialect));
}

/** Tests only: forget every registered plugin. */
export function resetDialectPluginsForTest(): void {
  for (const key of plugins.keys()) {
    delete ADAPTERS[key];
    delete PROVIDERS[key];
  }
  plugins.clear();
}
