/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee's content hash decides "same definition" by the rules Compare uses.
 *
 * It used to collapse whitespace only, so a view the engine re-cased, or one
 * captured with its schema qualifier, minted a new version while Compare
 * called it UNCHANGED. The hash now goes through `normalizeDefinitionText`;
 * the stored body keeps the definition as written, because revert builds DDL
 * from it.
 */
import { describe, expect, it } from 'vitest';
import { canonicalizeSchema } from './canonical';
import { hashObject, weave, type Digest, type LatestIndex } from './weave';
import type { TableSchema } from '@foxschema/sql';

const digest: Digest = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

function view(definition: string): TableSchema {
  return { name: 'v_active', objectType: 'VIEW', definition, columns: [], indices: [], foreignKeys: [] };
}

/** Capture `first`, then `second`, and report whether the second made a version. */
function secondCaptureChanges(first: string, second: string, schemas: string[] = []): boolean {
  const opts = { schemas };
  const v1 = weave(canonicalizeSchema([view(first)]), new Map(), digest, opts);
  const latest: LatestIndex = new Map(v1.objects.map((o) => [o.key, o.hash]));
  return weave(canonicalizeSchema([view(second)]), latest, digest, opts).changed;
}

describe('Lokee definition hashing follows Compare', () => {
  it('upper- vs lower-case definitions make no new version', () => {
    expect(
      secondCaptureChanges(
        'CREATE VIEW V_ACTIVE AS SELECT ID FROM ORDERS',
        'create view v_active as select id from orders'
      )
    ).toBe(false);
  });

  it("schema-qualified vs unqualified definitions make no new version (the history's schema)", () => {
    expect(
      secondCaptureChanges(
        'CREATE VIEW app.v_active AS SELECT o.id FROM app.orders o WHERE app.is_live(o.id)',
        'CREATE VIEW v_active AS SELECT o.id FROM orders o WHERE is_live(o.id)',
        ['app']
      )
    ).toBe(false);
  });

  it('equivalent definitions differing only in whitespace and terminator make no new version', () => {
    expect(secondCaptureChanges('SELECT id\n  FROM orders;', 'select id from orders')).toBe(false);
  });

  it('a genuinely changed definition makes a new version', () => {
    expect(secondCaptureChanges('SELECT id FROM orders', 'SELECT id, total FROM orders')).toBe(true);
  });

  it("a string literal's case is a real change", () => {
    expect(
      secondCaptureChanges(
        "SELECT id FROM orders WHERE status = 'Active'",
        "SELECT id FROM orders WHERE status = 'active'"
      )
    ).toBe(true);
  });

  it('keeps the stored definition as written — revert builds DDL from it', () => {
    const [container] = canonicalizeSchema([view("SELECT ID FROM app.Orders WHERE status = 'Active'")]);
    expect(container!.body.definition).toBe("SELECT ID FROM app.Orders WHERE status = 'Active'");
  });

  it('hashes the stored forms of equivalent definitions alike, so old and new captures compare', () => {
    // planRevert re-hashes stored bodies when stored hashes differ; this is the
    // property it relies on.
    const [a] = canonicalizeSchema([view('SELECT ID FROM app.ORDERS')]);
    const [b] = canonicalizeSchema([view('select id from orders')]);
    expect(hashObject(a!, digest, { schemas: ['app'] })).toBe(hashObject(b!, digest, { schemas: ['app'] }));
  });
});
