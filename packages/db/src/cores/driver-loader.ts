/**
 * Fox Schema (@foxschema/db)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Loading an optional native driver, in one place.
 *
 * Every adapter needs its driver package only once a connection is made, and
 * none of them is a hard dependency — so a missing one has to become an
 * install hint, not a stack trace. Twelve adapters carried the same try/catch
 * for it.
 *
 * `createRequire` with a variable specifier is deliberate: bundlers leave it
 * alone, so drivers stay external to the CLI bundle (see apps/cli/build.mjs).
 */
import { createRequire } from 'node:module';
import { errorMessage } from '@foxschema/sql';

const nodeRequire = createRequire(import.meta.url);

export interface RequireDriverOptions {
  /** Module to load when it differs from the package (mysql2 → `mysql2/promise`). */
  specifier?: string;
  /** Extra `npm install` flags for the hint (ibm_db needs `--foreground-scripts`). */
  installFlags?: string;
  /**
   * Return `mod.default ?? mod` (the default). DuckDB's node-api has a `default`
   * export that is not the API, so it opts out.
   */
  unwrapDefault?: boolean;
}

/**
 * Why a driver would not load, fit to show a user. Node's "Cannot find
 * module" error ends with a Require stack: the absolute paths of the server's
 * own files. That says nothing about the fix and shows the server's folder
 * layout, so it is cut. Any other error (a native build that will not load)
 * is kept whole: its detail is what diagnoses it.
 */
export function driverLoadReason(error: unknown): string {
  return errorMessage(error).split(/\r?\n\s*Require stack:/)[0]!.trim();
}

/** Load `packageName` for `label` (a dialect name), or throw an install hint. */
export function requireDriver(
  packageName: string,
  label: string,
  options: RequireDriverOptions = {}
): any {
  try {
    const mod = nodeRequire(options.specifier ?? packageName);
    return options.unwrapDefault === false ? mod : (mod.default ?? mod);
  } catch (e: unknown) {
    const flags = options.installFlags ? ` ${options.installFlags}` : '';
    throw new Error(
      `Database driver "${packageName}" is not installed for ${label}. ` +
        `Install it with: npm install ${packageName}${flags} — ${driverLoadReason(e)}`
    );
  }
}
