/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — rebuild `TableSchema[]` from canonical objects.
 *
 * Capture stores a table as a container plus one object per column / index /
 * FK / trigger. Revert and SQL generation need the nested shape Compare and
 * the dialect generators already speak, so this is the inverse of
 * `canonicalizeObject` — pure, and therefore safe to share with the browser.
 */
import type {
  ColumnInfo,
  DbObjectType,
  ForeignKeyInfo,
  IndexInfo,
  TableSchema,
  TriggerInfo,
} from '@foxschema/sql';
import type { CanonicalObject } from './canonical.js';
import { objectKeyOwner, pickOwnerContainer } from './blueprint.js';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asRecord<T>(value: unknown): T | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as T)
    : undefined;
}

function columnNameFromKey(key: string): string {
  const rest = key.slice(key.indexOf(':') + 1);
  const dot = rest.lastIndexOf('.');
  return dot < 0 ? rest : rest.slice(dot + 1);
}

function toColumn(object: CanonicalObject, pkColumns: string[]): ColumnInfo {
  const name = asString(object.body.name) ?? columnNameFromKey(object.key);
  const pk = pkColumns.some((c) => c.toUpperCase() === name.toUpperCase());
  return {
    name,
    type: asString(object.body.dataType) ?? 'text',
    nullable: asBool(object.body.nullable, true),
    defaultValue: asString(object.body.default),
    primaryKey: pk,
    identity: asBool(object.body.identity),
    identityGeneration: asString(object.body.identityGeneration),
    collation: asString(object.body.collation),
  };
}

function toIndex(object: CanonicalObject): IndexInfo {
  return {
    name: asString(object.body.name) ?? columnNameFromKey(object.key),
    columns: asStringArray(object.body.columns),
    unique: asBool(object.body.unique),
    constraint: asBool(object.body.constraint),
    filter: asString(object.body.filter),
  };
}

function toForeignKey(object: CanonicalObject): ForeignKeyInfo {
  return {
    name: asString(object.body.name) ?? columnNameFromKey(object.key),
    columns: asStringArray(object.body.columns),
    referencedTable: asString(object.body.referencedTable) ?? '',
    referencedColumns: asStringArray(object.body.referencedColumns),
  };
}

function toTrigger(object: CanonicalObject): TriggerInfo {
  return {
    name: asString(object.body.name) ?? columnNameFromKey(object.key),
    timing: asString(object.body.timing),
    event: asString(object.body.event),
    definition: object.sourceText ?? asString(object.body.definition),
  };
}

/**
 * Group hashed objects back into the `TableSchema[]` Compare already consumes.
 *
 * Objects whose owner has no container (orphaned children) are dropped rather
 * than invented as tables — a revert must not CREATE a table the history never
 * recorded.
 */
export function hydrateTableSchemas(objects: readonly CanonicalObject[]): TableSchema[] {
  const byOwner = new Map<string, CanonicalObject[]>();
  for (const object of objects) {
    const owner = objectKeyOwner(object.key);
    const group = byOwner.get(owner);
    if (group) group.push(object);
    else byOwner.set(owner, [object]);
  }

  const tables: TableSchema[] = [];
  for (const group of byOwner.values()) {
    // Prefer `table:OWNER` over a child `trigger:OWNER.NAME` that shares the
    // owner — both are container types, and Map/hash load order is unstable.
    const container = pickOwnerContainer(group);
    if (!container) continue;

    const pk = group.find((item) => item.type === 'primary_key');
    const pkColumns = pk ? asStringArray(pk.body.columns) : [];
    const name = asString(container.body.name) ?? objectKeyOwner(container.key);
    const objectType = (asString(container.body.objectType) as DbObjectType | undefined) ?? 'TABLE';
    const kind = container.body.functionKind;

    tables.push({
      name,
      objectType,
      definition: container.sourceText ?? asString(container.body.definition),
      columns: group.filter((item) => item.type === 'column').map((item) => toColumn(item, pkColumns)),
      indices: group.filter((item) => item.type === 'index').map(toIndex),
      foreignKeys: group.filter((item) => item.type === 'foreign_key').map(toForeignKey),
      primaryKey: pkColumns.length > 0 ? { columns: pkColumns } : undefined,
      triggers: group.filter((item) => item.type === 'trigger' && item !== container).map(toTrigger),
      sequence: asRecord(container.body.sequence),
      userType: asRecord(container.body.userType),
      parameters: Array.isArray(container.body.parameters)
        ? (container.body.parameters as TableSchema['parameters'])
        : undefined,
      functionKind: kind === 'scalar' || kind === 'table' ? kind : undefined,
      tablespace: asString(container.body.tablespace),
    });
  }

  return tables.sort((a, b) => a.name.localeCompare(b.name));
}
