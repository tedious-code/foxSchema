/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { assembleBlueprint, type StoredWeaveObject } from './blueprint.js';
import {
  lokeeColumnChangeSubtitle,
  lokeeColumnSubtitle,
  renderLokeeObjectScript,
} from './script.js';

function stored(
  key: string,
  type: string,
  name: string,
  body: Record<string, unknown> = {}
): StoredWeaveObject {
  return { key, type, name, hash: `h:${key}`, body };
}

describe('lokeeColumnSubtitle', () => {
  it('shows type and not-null / default / identity', () => {
    expect(
      lokeeColumnSubtitle({ dataType: 'varchar(100)', nullable: false, default: 'x' })
    ).toBe('varchar(100) · not null · default x');
    expect(lokeeColumnSubtitle({ dataType: 'integer', nullable: false }, { primaryKey: true })).toBe(
      'integer · pk'
    );
  });

  it('arrows type and constraint changes', () => {
    expect(
      lokeeColumnChangeSubtitle(
        { dataType: 'varchar(255)', nullable: false },
        { dataType: 'varchar(100)', nullable: true }
      )
    ).toBe('varchar(100) → varchar(255) · null → not null');
  });
});

describe('renderLokeeObjectScript', () => {
  it('emits CREATE TABLE with columns, pk and fk — not indexes', () => {
    const objects = new Map<string, StoredWeaveObject>([
      ['table:CUSTOMER', stored('table:CUSTOMER', 'table', 'customer')],
      [
        'column:CUSTOMER.ID',
        stored('column:CUSTOMER.ID', 'column', 'id', { dataType: 'integer', nullable: false }),
      ],
      [
        'column:CUSTOMER.EMAIL',
        stored('column:CUSTOMER.EMAIL', 'column', 'email', {
          dataType: 'varchar(255)',
          nullable: true,
        }),
      ],
      ['primary_key:CUSTOMER', stored('primary_key:CUSTOMER', 'primary_key', 'pk', { columns: ['id'] })],
      [
        'index:CUSTOMER.IDX',
        stored('index:CUSTOMER.IDX', 'index', 'idx_email', { columns: ['email'], unique: true }),
      ],
      [
        'foreign_key:CUSTOMER.FK',
        stored('foreign_key:CUSTOMER.FK', 'foreign_key', 'fk_tier', {
          columns: ['email'],
          referencedTable: 'users',
          referencedColumns: ['email'],
        }),
      ],
    ]);
    const sql = renderLokeeObjectScript(assembleBlueprint('table:CUSTOMER', objects));
    expect(sql).toContain('CREATE TABLE customer');
    expect(sql).toContain('id integer PRIMARY KEY');
    expect(sql).toContain('email varchar(255)');
    expect(sql).toContain('FOREIGN KEY (email) REFERENCES users (email)');
    expect(sql).not.toMatch(/idx_email|INDEX/i);
  });

  it('uses routine source text as the script', () => {
    const objects = new Map<string, StoredWeaveObject>([
      [
        'function:FN',
        {
          key: 'function:FN',
          type: 'function',
          name: 'fn',
          hash: 'h',
          body: { definition: 'create function fn() returns int as $$ select 1 $$' },
          sourceText: 'CREATE FUNCTION fn()\nRETURNS int\nAS $$ SELECT 1 $$',
        },
      ],
    ]);
    expect(renderLokeeObjectScript(assembleBlueprint('function:FN', objects))).toMatch(
      /CREATE FUNCTION fn/
    );
  });
});
