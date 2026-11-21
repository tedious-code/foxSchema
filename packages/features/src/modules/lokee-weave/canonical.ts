/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — canonical schema objects.
 *
 * Turns the normalised `TableSchema[]` that providers already produce into a
 * flat list of independently addressable objects, each with a stable key and a
 * deterministic body. Hashing happens elsewhere (`weave.ts`) because this
 * package must stay free of Node built-ins — see `purity.test.ts`.
 *
 * Granularity is deliberately below the table: a column is its own object, so
 * a history can say "email varchar(100) → varchar(255)" rather than "customer
 * changed", and an unrelated column added to the same table does not rewrite
 * every other column's identity.
 */
import type {
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  TableSchema,
  TriggerInfo,
} from '@foxschema/sql';

export type LokeeObjectType =
  | 'table'
  | 'view'
  | 'mqt'
  | 'column'
  | 'index'
  | 'primary_key'
  | 'foreign_key'
  | 'trigger'
  | 'sequence'
  | 'function'
  | 'procedure'
  | 'type';

export interface CanonicalObject {
  /** Stable logical address, e.g. `column:CUSTOMER.EMAIL`. */
  key: string;
  type: LokeeObjectType;
  /** Deterministic body; serialised with sorted keys before hashing. */
  body: Record<string, unknown>;
  /**
   * Original definition text, when the provider supplied one. Excluded from
   * the content hash (whitespace is not meaning) but kept so the inspector
   * can show procedure / view / trigger line counts.
   */
  sourceText?: string | null;
}

/**
 * Match keys are upper-cased, matching `compare.module.ts`.
 *
 * This is not cosmetic. Oracle and Db2 fold identifiers, so the same logical
 * table arrives as `CUSTOMER` from one dialect and `customer` from another;
 * folding here is what lets the invariant *compare-equal ⟺ hash-equal* hold.
 * The real, case-sensitive name is kept in the body — a key is an address, not
 * an identifier, and must never be used to build DDL.
 */
function matchKey(name: string): string {
  return name.trim().toUpperCase();
}

/**
 * The definition as stored: whitespace collapsed, terminator dropped, case and
 * qualifiers kept. Servers re-indent stored SQL, and revert rebuilds DDL from
 * this text (when no `sourceText` was kept), so it must stay valid SQL.
 *
 * Whether two definitions are the *same* is decided at hash time instead, by
 * `normalizeDefinitionText` — the rules Compare uses (case folded outside
 * string literals, the history's schema qualifier removed). See `hashObject`.
 * Without a parser, definitions that differ in more than that still hash
 * differently — the problem `DIALECTS.md` documents for view headers and Db2
 * system names.
 */
function normalizeDefinition(text: string | undefined): string | null {
  if (text == null) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim().replace(/;+$/, '').trim();
  return collapsed.length > 0 ? collapsed : null;
}

/** Type text differs only in case and spacing between drivers. */
function normalizeType(text: string | undefined): string | null {
  if (text == null) return null;
  const t = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return t.length > 0 ? t : null;
}

function columnObject(table: string, column: ColumnInfo): CanonicalObject {
  return {
    key: `column:${matchKey(table)}.${matchKey(column.name)}`,
    type: 'column',
    body: {
      name: column.name,
      table,
      dataType: normalizeType(column.type),
      nullable: column.nullable,
      // `undefined` and `null` both mean "no default"; collapse so two
      // providers reporting it differently agree.
      default: column.defaultValue ?? null,
      identity: column.identity ?? false,
      identityGeneration: column.identityGeneration ?? null,
      collation: column.collation ?? null,
    },
  };
}

function indexObject(table: string, index: IndexInfo): CanonicalObject {
  return {
    key: `index:${matchKey(table)}.${matchKey(index.name)}`,
    type: 'index',
    body: {
      name: index.name,
      table,
      // Column order is part of an index's meaning — never sorted.
      columns: index.columns,
      unique: index.unique,
      constraint: index.constraint ?? false,
      filter: normalizeDefinition(index.filter),
    },
  };
}

function foreignKeyObject(table: string, fk: ForeignKeyInfo): CanonicalObject {
  return {
    key: `foreign_key:${matchKey(table)}.${matchKey(fk.name)}`,
    type: 'foreign_key',
    body: {
      name: fk.name,
      table,
      columns: fk.columns,
      referencedTable: fk.referencedTable,
      referencedColumns: fk.referencedColumns,
    },
  };
}

function triggerObject(table: string, trigger: TriggerInfo): CanonicalObject {
  return {
    key: `trigger:${matchKey(table)}.${matchKey(trigger.name)}`,
    type: 'trigger',
    body: {
      name: trigger.name,
      table,
      timing: trigger.timing ?? null,
      event: trigger.event ?? null,
      definition: normalizeDefinition(trigger.definition),
    },
    sourceText: trigger.definition ?? null,
  };
}

const CONTAINER_TYPE: Record<string, LokeeObjectType> = {
  TABLE: 'table',
  MQT: 'mqt',
  VIEW: 'view',
  FUNCTION: 'function',
  PROCEDURE: 'procedure',
  TRIGGER: 'trigger',
  SEQUENCE: 'sequence',
  TYPE: 'type',
  ROLE: 'type',
};

/**
 * One `TableSchema` becomes a container object plus one object per child.
 *
 * The container body deliberately excludes children: if it repeated them, a
 * single column change would also change the table's hash and the delta would
 * carry both, defeating the point.
 */
export function canonicalizeObject(table: TableSchema): CanonicalObject[] {
  const type = CONTAINER_TYPE[table.objectType] ?? 'table';
  const out: CanonicalObject[] = [
    {
      key: `${type}:${matchKey(table.name)}`,
      type,
      body: {
        name: table.name,
        objectType: table.objectType,
        definition: normalizeDefinition(table.definition),
        tablespace: table.tablespace ?? null,
        sequence: table.sequence ?? null,
        userType: table.userType ?? null,
        parameters: table.parameters ?? null,
        functionKind: table.functionKind ?? null,
      },
      sourceText: table.definition ?? null,
    },
  ];

  for (const column of table.columns ?? []) out.push(columnObject(table.name, column));
  for (const index of table.indices ?? []) out.push(indexObject(table.name, index));
  for (const fk of table.foreignKeys ?? []) out.push(foreignKeyObject(table.name, fk));
  for (const trigger of table.triggers ?? []) out.push(triggerObject(table.name, trigger));

  if (table.primaryKey && table.primaryKey.columns.length > 0) {
    out.push({
      key: `primary_key:${matchKey(table.name)}`,
      type: 'primary_key',
      body: {
        // A PK's name is often server-generated and differs between two
        // databases holding the same logical schema, so it is not part of the
        // body — only the columns, in order, carry meaning.
        table: table.name,
        columns: table.primaryKey.columns,
      },
    });
  }

  return out;
}

/**
 * Canonicalise a whole schema.
 *
 * Duplicate keys are dropped rather than silently overwriting: a provider
 * returning the same object twice is a bug, and letting the last one win would
 * make the root hash depend on introspection order.
 */
export function canonicalizeSchema(tables: TableSchema[]): CanonicalObject[] {
  const byKey = new Map<string, CanonicalObject>();
  for (const table of tables) {
    for (const object of canonicalizeObject(table)) {
      if (!byKey.has(object.key)) byKey.set(object.key, object);
    }
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
