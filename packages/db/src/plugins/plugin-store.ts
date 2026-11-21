/**
 * Fox Schema (@foxschema/db)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The add-on dialect contract and the registered plugins. Imports nothing
 * from the registries, so code the providers load (the connection factory,
 * the driver detector) can read it without an import cycle.
 */
import type { DriverAdapter, SchemaProvider } from '@foxschema/sql';

/** Why a driver that resolves still cannot be used, and how to fix it. */
export interface DriverProblem {
  error: string;
  installCommand: string;
}

export interface DialectPlugin {
  /** Lower-case dialect key, e.g. `db2`. */
  dialect: string;
  adapter: DriverAdapter;
  provider: SchemaProvider;
  /** Run before the driver is loaded or checked (e.g. point PATH at a client library). */
  prepareDriver?(): void;
  /** A driver that resolves but cannot work yet, or undefined when it is fine. */
  checkDriver?(): DriverProblem | undefined;
  /** How to install or repair the driver, shown when it is missing. */
  installCommand?: string;
}

/** Registered add-ons by lower-case dialect key. Written only by registerDialectPlugin. */
export const plugins = new Map<string, DialectPlugin>();

/** The registered plugin for a dialect, if any. */
export function dialectPlugin(dialect: string): DialectPlugin | undefined {
  return plugins.get(dialect.toLowerCase());
}
