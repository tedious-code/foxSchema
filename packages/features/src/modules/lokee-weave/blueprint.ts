/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — assemble a table (or routine) blueprint from hashed objects.
 *
 * Capture stores each column, index, trigger, and container as its own
 * content-addressed row. The inspector needs them back as one picture: "this
 * table, at this version, with these children." That join is pure and belongs
 * here so the Node store and the browser graph share one definition of
 * relatedness.
 */

import type { LokeeObjectType } from './canonical.js';

/** A stored (or reconstructed) object the inspector can render. */
export interface StoredWeaveObject {
  key: string;
  type: LokeeObjectType | string;
  name: string;
  hash: string;
  body: Record<string, unknown>;
  sourceText?: string | null;
  lineCount?: number | null;
  firstSeenAt?: string | null;
}

const CONTAINER_TYPES: readonly LokeeObjectType[] = [
  'table',
  'view',
  'mqt',
  'function',
  'procedure',
  'trigger',
  'sequence',
  'type',
];

export function isLokeeContainerType(type: string): boolean {
  return (CONTAINER_TYPES as readonly string[]).includes(type);
}

/** Tables / views / MQTs — objects that grow columns, indexes, and triggers. */
const TABLE_LIKE_TYPES: readonly LokeeObjectType[] = ['table', 'view', 'mqt'];

export function isLokeeTableLikeType(type: string): boolean {
  return (TABLE_LIKE_TYPES as readonly string[]).includes(type);
}

const CHILD_TYPES = {
  column: 'columns',
  index: 'indexes',
  foreign_key: 'foreignKeys',
  trigger: 'triggers',
  primary_key: 'primaryKey',
} as const;

/** `column:CUSTOMER.EMAIL` → `column`. */
export function objectKeyKind(key: string): string {
  const i = key.indexOf(':');
  return i < 0 ? key : key.slice(0, i);
}

/**
 * Logical owner of a key: `column:CUSTOMER.EMAIL` and `table:CUSTOMER` both
 * yield `CUSTOMER`. Keys are already match-folded (upper case).
 */
export function objectKeyOwner(key: string): string {
  const rest = key.slice(key.indexOf(':') + 1);
  const dot = rest.indexOf('.');
  return (dot < 0 ? rest : rest.slice(0, dot)).toUpperCase();
}

/** Count physical lines in original source (not the whitespace-collapsed hash body). */
export function countSourceLines(text: string | null | undefined): number {
  if (typeof text !== 'string') return 0;
  const trimmed = text.replace(/^\uFEFF/, '').replace(/\s+$/u, '');
  if (trimmed.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code === 10) lines += 1;
    else if (code === 13 && trimmed.charCodeAt(i + 1) !== 10) lines += 1;
  }
  return lines;
}

function byName(a: StoredWeaveObject, b: StoredWeaveObject): number {
  return a.name.localeCompare(b.name);
}

function containerKeyForOwner(
  objects: ReadonlyMap<string, StoredWeaveObject>,
  owner: string
): string | null {
  for (const type of CONTAINER_TYPES) {
    const key = `${type}:${owner}`;
    if (objects.has(key)) return key;
  }
  return null;
}

/**
 * Pick the owner-level container from a same-owner object group.
 *
 * Table-owned triggers are also typed `trigger` and share the table's owner
 * (`trigger:CUSTOMER.TRG` → owner `CUSTOMER`). A naïve
 * `find(isLokeeContainerType)` can therefore treat the child trigger as the
 * table when it appears first in the group — hydrate then emits wrong DDL
 * (e.g. `ALTER TABLE trg …` instead of `customer`). Prefer the same ordered
 * `type:OWNER` keys {@link assembleBlueprint} uses.
 */
export function pickOwnerContainer<T extends { key: string }>(objects: readonly T[]): T | undefined {
  if (objects.length === 0) return undefined;
  const owner = objectKeyOwner(objects[0]!.key);
  const byKey = new Map(objects.map((object) => [object.key, object]));
  for (const type of CONTAINER_TYPES) {
    const hit = byKey.get(`${type}:${owner}`);
    if (hit) return hit;
  }
  return undefined;
}

export interface ObjectBlueprint {
  focusKey: string;
  /** Table / view / routine the focus belongs to. */
  container: StoredWeaveObject | null;
  /** The clicked object (may equal `container`). */
  object: StoredWeaveObject | null;
  columns: StoredWeaveObject[];
  indexes: StoredWeaveObject[];
  foreignKeys: StoredWeaveObject[];
  triggers: StoredWeaveObject[];
  primaryKey: StoredWeaveObject | null;
}

/**
 * Group every live object that belongs to the same owner as `objectKey`.
 *
 * Clicking a column still returns the parent table's columns/indexes/triggers
 * so the inspector can show a blueprint rather than a single field.
 */
export function assembleBlueprint(
  objectKey: string,
  objects: ReadonlyMap<string, StoredWeaveObject>
): ObjectBlueprint {
  const owner = objectKeyOwner(objectKey);
  const containerKey = containerKeyForOwner(objects, owner);
  const container = containerKey ? (objects.get(containerKey) ?? null) : null;
  const object = objects.get(objectKey) ?? null;

  const columns: StoredWeaveObject[] = [];
  const indexes: StoredWeaveObject[] = [];
  const foreignKeys: StoredWeaveObject[] = [];
  const triggers: StoredWeaveObject[] = [];
  let primaryKey: StoredWeaveObject | null = null;

  for (const item of objects.values()) {
    if (objectKeyOwner(item.key) !== owner) continue;
    const kind = objectKeyKind(item.key);
    if (kind === 'column') columns.push(item);
    else if (kind === 'index') indexes.push(item);
    else if (kind === 'foreign_key') foreignKeys.push(item);
    else if (kind === 'trigger' && item.key !== containerKey) triggers.push(item);
    else if (kind === 'primary_key') primaryKey = item;
  }

  columns.sort(byName);
  indexes.sort(byName);
  foreignKeys.sort(byName);
  triggers.sort(byName);

  return {
    focusKey: objectKey,
    container,
    object,
    columns,
    indexes,
    foreignKeys,
    triggers,
    primaryKey,
  };
}

export function blueprintChildCounts(blueprint: ObjectBlueprint): {
  columns: number;
  indexes: number;
  foreignKeys: number;
  triggers: number;
} {
  return {
    columns: blueprint.columns.length,
    indexes: blueprint.indexes.length,
    foreignKeys: blueprint.foreignKeys.length,
    triggers: blueprint.triggers.length,
  };
}
