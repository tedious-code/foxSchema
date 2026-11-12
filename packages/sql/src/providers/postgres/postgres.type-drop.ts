/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Drop Type on PostgreSQL and its family: enums and domains, and composites
 * no column uses (a composite has no built-in type to move its columns to).
 *
 * A column's default is written with a cast to its type (`'new'::order_status`),
 * so the default depends on the type too: it is dropped before the column
 * changes and set again without the cast. An enum has no implicit cast to
 * text, so the change spells one out.
 */
import type { ColumnChangeStep } from '../../modules/utilities/column-change.types.js';
import type {
  TypeDropColumnContext,
  TypeDropDialect,
} from '../../modules/utilities/type-drop.types.js';
import { normType } from '../../modules/utilities/column-type-shape.js';

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const qualified = (schema: string | undefined, name: string) => (schema ? `${q(schema)}.${q(name)}` : q(name));
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;
const escapeWord = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A default without its casts to the type: `'new'::shop.order_status` is
 * `'new'`, which the column's new type takes as it is.
 */
export function withoutTypeCast(expression: string, typeName: string, schema?: string): string {
  const name = `"?${escapeWord(typeName)}"?`;
  const prefix = schema ? `(?:"?${escapeWord(schema)}"?\\.)?` : '(?:"?[A-Za-z_][A-Za-z0-9_$]*"?\\.)?';
  return expression.replace(new RegExp(`::${prefix}${name}(?:\\[\\])*`, 'gi'), '');
}

function assertNoForeignKey(ctx: TypeDropColumnContext): void {
  const name = ctx.column.name.toLowerCase();
  const has = (cols: string[]) => cols.some((c) => c.toLowerCase() === name);
  const outbound = (ctx.table.foreignKeys ?? []).find((fk) => has(fk.columns));
  if (outbound) {
    throw new Error(`it has a foreign key (${outbound.name}) whose other side would keep the type. Drop that key first.`);
  }
  const inbound = ctx.tables.find(
    (t) =>
      t !== ctx.table &&
      (t.foreignKeys ?? []).some(
        (fk) => fk.referencedTable.toLowerCase() === ctx.table.name.toLowerCase() && has(fk.referencedColumns)
      )
  );
  if (inbound) {
    throw new Error(`${inbound.name} has a foreign key pointing at it. Drop that key first.`);
  }
}

export function postgresFamilyTypeDrop(options: {
  /** A session setting the engine wants before a general type change (CockroachDB). */
  alterTypeSetting?: string;
  /** Whether the column's statements can share one transaction (CockroachDB: no). */
  transactional: boolean;
}): TypeDropDialect {
  return {
    canKeepValuesCheck: true,

    kindOf: (type) => {
      const meta = type.userType?.metaType;
      return meta === 'E' ? 'enum' : meta === 'O' ? 'composite' : 'domain';
    },

    // text, not varchar(n): no length to get wrong, and PostgreSQL stores both alike.
    // A composite has fields, not one built-in type to fall back on: its columns refuse.
    suggestReplacement: (type, kind) =>
      kind === 'enum' ? 'text' : kind === 'domain' ? type.userType?.sourceType?.trim() || undefined : undefined,

    convertColumnSteps: (ctx) => {
      assertNoForeignKey(ctx);
      const t = qualified(ctx.schema, ctx.table.name);
      const col = q(ctx.column.name);
      const target = ctx.array ? `${ctx.replacement}[]` : ctx.replacement;
      const viaText = ctx.array ? `${col}::text[]` : `${col}::text`;
      const using =
        ctx.kind !== 'enum'
          ? `${col}::${target}`
          : normType(ctx.replacement) === 'text'
            ? viaText
            : `${viaText}::${target}`;

      const statements: string[] = [];
      const defaultValue = ctx.column.defaultValue?.trim();
      if (defaultValue) statements.push(`ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT;`);
      statements.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${target} USING ${using};`);
      if (defaultValue) {
        statements.push(
          `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${withoutTypeCast(defaultValue, ctx.typeName, ctx.schema)};`
        );
      }
      const check = ctx.keepValuesCheck && ctx.kind === 'enum' && ctx.values.length > 0;
      if (check) {
        const values = ctx.values.map(lit).join(', ');
        const rule = ctx.array ? `${col} <@ ARRAY[${values}]::${target}` : `${col} IN (${values})`;
        const name = `${ctx.table.name}_${ctx.column.name}_check`.slice(0, 63);
        statements.push(`ALTER TABLE ${t} ADD CONSTRAINT ${q(name)} CHECK (${rule});`);
      }

      const body = options.transactional ? ['BEGIN;', ...statements, 'COMMIT;'] : statements;
      const sql = [...(options.alterTypeSetting ? [options.alterTypeSetting] : []), ...body].join('\n');
      const step: ColumnChangeStep = {
        phase: 'add',
        title: `Change ${ctx.table.name}.${ctx.column.name} to ${target}`,
        rerunSafe: false,
        sql,
        note: [
          ctx.kind === 'enum' ? 'The values stay, as text.' : 'The values stay as they are.',
          options.transactional
            ? 'One transaction: a failure leaves the column as it was.'
            : 'These run one at a time: this engine will not change a column type inside a transaction.',
          'Indexes on the column are rebuilt. The change rewrites the table and blocks it while it runs.',
          'It is refused while a view uses the column, or an index or check compares it with a value cast to the type: drop those first.',
        ].join(' '),
      };
      return [step];
    },

    dropStep: ({ schema, typeName, kind }) => ({
      phase: 'finish',
      title: `Drop ${typeName}`,
      rerunSafe: false,
      sql: `DROP ${kind === 'domain' ? 'DOMAIN' : 'TYPE'} ${qualified(schema, typeName)};`,
      note:
        'No CASCADE: if a column, a function or a view still depends on the type, the database refuses, names it, and drops nothing.',
    }),
  };
}

export const postgresTypeDrop = postgresFamilyTypeDrop({ transactional: true });
