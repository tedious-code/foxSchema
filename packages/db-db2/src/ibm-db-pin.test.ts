/**
 * Fox Schema (@foxschema/db)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The ibm_db version is named once in code (`IBM_DB_VERSION`) and twice in
 * package manifests, which npm reads and code cannot. The install hints, the
 * `fox drivers install db2` pin and the server's driver installer all use the
 * constant; this keeps the manifests on the same release.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IBM_DB_VERSION } from '@foxschema/sql';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function manifest(rel: string): {
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
} {
  return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
}

describe('ibm_db is pinned to one release', () => {
  it('@foxschema/db-db2 installs exactly IBM_DB_VERSION', () => {
    expect(manifest('packages/db-db2/package.json').optionalDependencies?.ibm_db).toBe(IBM_DB_VERSION);
  });

  it('@foxschema/db does not install ibm_db at all', () => {
    // Db2 is the add-on's job; a pin left here would download the driver for
    // every user of @foxschema/db again.
    const db = manifest('packages/db/package.json');
    expect(db.optionalDependencies?.ibm_db).toBeUndefined();
    expect(db.peerDependencies?.ibm_db).toBeUndefined();
  });

  it('apps/web installs exactly IBM_DB_VERSION', () => {
    expect(manifest('apps/web/package.json').optionalDependencies?.ibm_db).toBe(IBM_DB_VERSION);
  });
});
