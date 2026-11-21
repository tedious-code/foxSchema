/**
 * Fox Schema (@foxschema/db-db2)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * IBM Db2 for @foxschema/db, as an add-on.
 *
 * Db2's driver (`ibm_db` with the IBM CLI driver, ~59 MB) is too heavy for
 * every @foxschema/db install, so it lives here. Db2 *SQL* (DDL, type
 * mapping) stays in @foxschema/sql: generating a Db2 migration needs no
 * driver at all.
 *
 * With this package installed, `openDatabase('db2', …)` loads it on its own.
 * A host that wants Db2 from the start registers it once:
 *
 *   import { registerDb2 } from '@foxschema/db-db2';
 *   registerDb2();
 */
import { IBM_DB_VERSION } from '@foxschema/sql';
import { registerDialectPlugin, type DialectPlugin } from '@foxschema/db';
import { db2Adapter } from './db2.adapter.js';
import { hasDb2Clidriver, hasIbmDb, setupDb2ClientEnv } from './db2.env.js';
import { Db2Provider } from './db2.provider.js';

const INSTALL_COMMAND = `foxschema drivers install db2   # or: npm install ibm_db@${IBM_DB_VERSION} --foreground-scripts -w @foxschema/db`;

/** What @foxschema/db registers for `db2`. */
export const dialectPlugin: DialectPlugin = {
  dialect: 'db2',
  adapter: db2Adapter,
  provider: new Db2Provider(),
  // ibm_db's native bindings need the bundled clidriver on PATH /
  // LD_LIBRARY_PATH (especially on Windows) before the module loads.
  prepareDriver: setupDb2ClientEnv,
  // `require('ibm_db')` can still succeed with the clidriver download skipped,
  // and then fails on first use with a bindings-path dump. Say so up front.
  // An ibm_db that is not installed at all is left to the ordinary
  // "not installed" check.
  checkDriver: () =>
    !hasIbmDb() || hasDb2Clidriver()
      ? undefined
      : {
          installCommand: INSTALL_COMMAND,
          error: 'ibm_db is present but the DB2 clidriver was not downloaded (install scripts were skipped).',
        },
  installCommand: INSTALL_COMMAND,
};

/** Register Db2 with @foxschema/db and set up its client environment. Safe to call twice. */
export function registerDb2(): void {
  registerDialectPlugin(dialectPlugin);
  setupDb2ClientEnv();
}

export { db2Adapter } from './db2.adapter.js';
export { Db2Provider } from './db2.provider.js';
export { hasDb2Clidriver, hasIbmDb, setupDb2ClientEnv } from './db2.env.js';
