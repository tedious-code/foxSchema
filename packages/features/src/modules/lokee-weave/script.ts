/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reconstruct a GitHub-diffable CREATE script from a Lokee blueprint.
 *
 * Tables/views/MQTs: columns + PK + FKs. Indexes are omitted on purpose —
 * Lokee stores them, but the inspector does not treat them as a first-class
 * history surface.
 */
import { parseTypeText } from './reversal.js';
import {
  isLokeeTableLikeType,
  objectKeyKind,
  type ObjectBlueprint,
  type StoredWeaveObject,
} from './blueprint.js';

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function lokeeTypeLabel(body: Record<string, unknown> | undefined): string {
  const raw = asString(body?.dataType) ?? asString(body?.type);
  if (!raw) return '—';
  const parsed = parseTypeText(raw);
  if (!parsed) return raw;
  if (parsed.length != null) return `${parsed.base}(${parsed.length})`;
  if (parsed.precision != null) {
    return parsed.scale != null
      ? `${parsed.base}(${parsed.precision},${parsed.scale})`
      : `${parsed.base}(${parsed.precision})`;
  }
  return parsed.base;
}

function nullLabel(body: Record<string, unknown> | undefined): string {
  return body?.nullable === false ? 'not null' : 'null';
}

function defaultLabel(body: Record<string, unknown> | undefined): string | null {
  const value = body?.default;
  if (value == null || value === '') return null;
  return String(value);
}

/** One-line type + constraints for a column at a single version. */
export function lokeeColumnSubtitle(
  body: Record<string, unknown> | undefined,
  options: { primaryKey?: boolean } = {}
): string {
  const parts = [lokeeTypeLabel(body)];
  if (options.primaryKey) parts.push('pk');
  if (body?.identity === true) parts.push('identity');
  if (body?.nullable === false && !options.primaryKey) parts.push('not null');
  const def = defaultLabel(body);
  if (def) parts.push(`default ${def}`);
  return parts.join(' · ');
}

/**
 * Subtitle when a column changed: type and constraint arrows, otherwise the
 * current type/constraints.
 */
export function lokeeColumnChangeSubtitle(
  current: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | undefined,
  options: { primaryKey?: boolean; previousPrimaryKey?: boolean } = {}
): string {
  if (!previous) return lokeeColumnSubtitle(current, { primaryKey: options.primaryKey });
  const parts: string[] = [];
  const fromType = lokeeTypeLabel(previous);
  const toType = lokeeTypeLabel(current);
  parts.push(fromType === toType ? toType : `${fromType} → ${toType}`);
  if (Boolean(options.previousPrimaryKey) !== Boolean(options.primaryKey)) {
    parts.push(options.primaryKey ? 'became pk' : 'dropped pk');
  } else if (options.primaryKey) {
    parts.push('pk');
  }
  if (previous.nullable !== current?.nullable) {
    parts.push(`${nullLabel(previous)} → ${nullLabel(current)}`);
  } else if (current?.nullable === false && !options.primaryKey) {
    parts.push('not null');
  }
  const fromDef = defaultLabel(previous);
  const toDef = defaultLabel(current);
  if (fromDef !== toDef) {
    parts.push(`${fromDef ? `default ${fromDef}` : 'no default'} → ${toDef ? `default ${toDef}` : 'no default'}`);
  }
  if (Boolean(previous.identity) !== Boolean(current?.identity)) {
    parts.push(current?.identity === true ? 'became identity' : 'dropped identity');
  }
  return parts.join(' · ');
}

function quoteIdent(name: string): string {
  return /[^A-Za-z0-9_]/u.test(name) ? `"${name.replaceAll('"', '""')}"` : name;
}

function columnDdl(column: StoredWeaveObject, primaryKey: boolean): string {
  const bits = [quoteIdent(column.name), lokeeTypeLabel(column.body)];
  if (primaryKey) bits.push('PRIMARY KEY');
  else if (column.body.nullable === false) bits.push('NOT NULL');
  if (column.body.identity === true) bits.push('GENERATED ALWAYS AS IDENTITY');
  const def = defaultLabel(column.body);
  if (def) bits.push(`DEFAULT ${def}`);
  return bits.join(' ');
}

function renderTableLike(blueprint: ObjectBlueprint): string {
  const table = blueprint.container ?? blueprint.object;
  const name = table?.name ?? 'object';
  const pkCols = asStringArray(blueprint.primaryKey?.body.columns);
  const pkSet = new Set(pkCols.map((c) => c.toUpperCase()));
  const inlinePk = pkCols.length === 1;
  const lines: string[] = [];
  for (const column of blueprint.columns) {
    const isPk = pkSet.has(column.name.toUpperCase());
    lines.push(`  ${columnDdl(column, inlinePk && isPk)}`);
  }
  if (!inlinePk && pkCols.length > 0) {
    lines.push(`  PRIMARY KEY (${pkCols.map(quoteIdent).join(', ')})`);
  }
  for (const fk of blueprint.foreignKeys) {
    const cols = asStringArray(fk.body.columns).map(quoteIdent).join(', ');
    const refTable = asString(fk.body.referencedTable) ?? 'unknown';
    const refCols = asStringArray(fk.body.referencedColumns).map(quoteIdent).join(', ');
    lines.push(`  FOREIGN KEY (${cols}) REFERENCES ${quoteIdent(refTable)} (${refCols})`);
  }
  const keyword =
    String(table?.type) === 'view' || objectKeyKind(blueprint.focusKey) === 'view'
      ? 'VIEW'
      : String(table?.type) === 'mqt'
        ? 'TABLE'
        : 'TABLE';
  if (lines.length === 0) return `CREATE ${keyword} ${quoteIdent(name)};`;
  return `CREATE ${keyword} ${quoteIdent(name)} (\n${lines.join(',\n')}\n);`;
}

/** CREATE script at this version. Empty string when there is nothing to show. */
export function renderLokeeObjectScript(blueprint: ObjectBlueprint): string {
  const focus = blueprint.object ?? blueprint.container;
  if (!focus) return '';
  const kind = objectKeyKind(blueprint.focusKey);
  const type = String(focus.type);
  const source = (focus.sourceText ?? asString(focus.body.definition) ?? '').trim();
  if (source && !isLokeeTableLikeType(type) && !isLokeeTableLikeType(kind)) return source;
  if (type === 'view' || kind === 'view') {
    if (source) return source;
  }
  if (isLokeeTableLikeType(type) || isLokeeTableLikeType(kind) || blueprint.columns.length > 0) {
    return renderTableLike(blueprint);
  }
  return source;
}
