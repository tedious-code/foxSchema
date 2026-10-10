import type { SchemaMapping, SqlGeneratorModule } from '@/shared/lib/sql-generator';
import { loadOnce } from '@/shared/lib/loadOnce';
import { withConnectionString } from '@/shared/lib/provider-settings';
import type { SchemaCompareResult, TableDiff } from '@/shared/lib/types';
import type { ConnectionRef } from '@/shared/api/schemaApi';
import type { ConnectionConfig } from './syncTypes';
import { applySelectionToDiff } from '@/shared/lib/column-selection';

/**
 * Every deploy opt-in and opt-out, passed as one object.
 *
 * These were positional parameters. Six maps of the same type in a row is a
 * silent-swap waiting to happen — the compiler cannot tell `memberSelection`
 * from `indexSelection`, and getting them the wrong way round produces a script
 * that looks plausible and deploys the wrong things.
 */
export interface DeploySelections {
  selection: Record<string, boolean>;
  memberSelection: Record<string, Record<string, boolean>>;
  indexSelection: Record<string, Record<string, boolean>>;
  columnSelection?: Record<string, Record<string, boolean>>;
  triggerSelection?: Record<string, Record<string, boolean>>;
}

// Comparison runs server-side (/api/compare); SQL generation stays client-side
// because it re-runs interactively as deploy checkboxes toggle, with no DB round-trip.
//
// The generator is every engine's DDL code, and nothing needs it before there
// is a comparison. So it loads with the first browse or compare (both await it
// before they set `compareResult`), and the synchronous paths that follow,
// every one of which starts from a comparison, read it with `sqlGenerator()`.
export const loadSqlGenerator = loadOnce(async () => {
  const { SqlGeneratorModule } = await import('@/shared/lib/sql-generator');
  return new SqlGeneratorModule();
});

/** The loaded generator. Throws, rather than returning an empty script, if a path forgot to load it. */
export function sqlGenerator(): SqlGeneratorModule {
  const generator = loadSqlGenerator.peek();
  if (!generator) throw new Error('The SQL generator was used before a comparison loaded it.');
  return generator;
}

/**
 * A side's request payload: a saved connection (connectionId, resolved+decrypted
 * server-side) or an inline ad-hoc option. Keeps passwords off the wire for saved ones.
 */
export function buildRef(cfg: ConnectionConfig): ConnectionRef {
  if (cfg.connectionId) {
    // For a saved connection stored without its password, forward the session password
    // the user typed (kept in-memory on the config), so the server can connect with it.
    const password = cfg.option?.password || undefined;
    return { connectionId: cfg.connectionId, schema: cfg.schema, password };
  }
  return {
    dialect: cfg.dialect,
    option: withConnectionString(cfg.dialect, { ...cfg.option, schema: cfg.schema }),
    schema: cfg.schema,
  };
}

/**
 * The tables going into the script: ticked for deploy, or with at least one
 * index change opted in. Order follows `tables`.
 */
function inScriptTables(tables: TableDiff[], sel: DeploySelections): TableDiff[] {
  const { selection, indexSelection } = sel;
  return tables.filter(
    (t) =>
      selection[t.tableName] ||
      Object.values(indexSelection[t.tableName] ?? {}).some((v) => v === true)
  );
}

/**
 * Build the diffs to deploy from the object selection, applying per-role member
 * opt-outs (a role member explicitly set to false is dropped from the role's
 * diffs, so it won't appear in the generated GRANT/REVOKE) and per-index opt-ins
 * (an index change is only included once explicitly checked — see
 * sync-types.ts's indexSelection doc comment for why the polarity is reversed).
 *
 * Tables that are UNCHANGED in the tree (e.g. index rename-only) are still
 * included when the user opts into one or more of their index changes — the
 * generator only sees those indexes, promoted to MODIFIED for ALTER emission.
 */
export function buildIncludedDiffs(tables: TableDiff[], sel: DeploySelections): TableDiff[] {
  const { selection, memberSelection, indexSelection, columnSelection, triggerSelection } = sel;

  /** The index keys actually going into the script, so column rules can see them. */
  const includedIndexKeys = (tableName: string): Set<string> =>
    new Set(
      Object.entries(indexSelection[tableName] ?? {})
        .filter(([, v]) => v === true)
        .map(([k]) => k.toUpperCase())
    );

  const inScript = inScriptTables(tables, sel);

  return inScript
    .map((t) => {
      const idxSel = indexSelection[t.tableName] ?? {};
      const indexDiffs = t.indexDiffs.filter((i) => i.status === 'UNCHANGED' || idxSel[i.name] === true);
      const objectSelected = !!selection[t.tableName];

      if (objectSelected) {
        if (t.objectType !== 'ROLE') {
          // Column and trigger opt-outs apply to real objects; a role's
          // "columns" are its members and have their own selection below.
          //
          // `siblings` is the tables actually going into the script. A key on a
          // child that is not being migrated emits nothing, so it must not pin
          // a parent column the reader is free to leave out — but a child that
          // *is* being migrated names parent columns the parent's own diff
          // cannot see.
          return applySelectionToDiff(
            { ...t, indexDiffs },
            {
              columnSelection: columnSelection?.[t.tableName],
              triggerSelection: triggerSelection?.[t.tableName],
              includedIndexes: includedIndexKeys(t.tableName),
              siblings: inScript,
            }
          );
        }
        const memberSel = memberSelection[t.tableName] ?? {};
        return {
          ...t,
          indexDiffs,
          columnDiffs: t.columnDiffs.filter((c) => memberSel[c.name] !== false),
        };
      }

      // Index-only opt-in (rename-only UNCHANGED tables, or indexes checked without
      // Deploy): emit ALTER with just the opted index changes.
      const optedIndexes = indexDiffs.filter((i) => i.status !== 'UNCHANGED');
      return {
        ...t,
        status: 'MODIFIED' as const,
        columnDiffs: t.columnDiffs.filter((c) => c.status === 'UNCHANGED'),
        foreignKeyDiffs: t.foreignKeyDiffs.filter((f) => f.status === 'UNCHANGED'),
        triggerDiffs: (t.triggerDiffs ?? []).filter((tr) => tr.status === 'UNCHANGED'),
        indexDiffs: optedIndexes,
      };
    });
}

/**
 * Every table in the compare, with column and trigger opt-outs applied to the
 * ones being migrated.
 *
 * The validators need the *whole* compare: `findMissingFkTargets` decides a
 * parent is missing by not finding it, and `findDropDependencies` reports
 * dependents that were never selected. Handing them only the included diffs
 * made an added key look like it referenced a missing table whenever the parent
 * was an existing object nobody had ticked.
 *
 * They also must not see columns the script no longer touches, or an unticked
 * drop keeps warning — and can keep Execute disabled — about a statement that
 * is not there. So: same list, trimmed contents.
 */
export function applySelectionsForScan(
  tables: TableDiff[],
  sel: DeploySelections
): TableDiff[] {
  // Built once, not per table: it was an O(n²) filter on every checkbox click.
  const siblings = inScriptTables(tables, sel);
  const inScript = new Set(siblings.map((t) => t.tableName));
  return tables.map((t) => {
    if (t.objectType === 'ROLE' || !inScript.has(t.tableName)) return t;
    return applySelectionToDiff(t, {
      columnSelection: sel.columnSelection?.[t.tableName],
      triggerSelection: sel.triggerSelection?.[t.tableName],
      includedIndexes: new Set(
        Object.entries(sel.indexSelection[t.tableName] ?? {})
          .filter(([, v]) => v === true)
          .map(([k]) => k.toUpperCase())
      ),
      siblings,
    });
  });
}

/** The SQL-generation mapping derived from the active source/target configs. */
export function buildMapping(s: {
  sourceConfig: ConnectionConfig;
  targetConfig: ConnectionConfig;
  nonDestructive: boolean;
  targetServerVersion?: string;
}): SchemaMapping {
  return {
    sourceSchema: s.sourceConfig.schema,
    sourceDialect: s.sourceConfig.dialect,
    targetSchema: s.targetConfig.schema,
    nonDestructive: s.nonDestructive,
    targetServerVersion: s.targetServerVersion,
  };
}

/** Regenerate the preview migration script for a selection + per-role member opt-outs + per-index opt-ins. */
export function regenerateSql(
  s: {
    compareResult: SchemaCompareResult | null;
    sourceConfig: ConnectionConfig;
    targetConfig: ConnectionConfig;
    nonDestructive: boolean;
  },
  sel: DeploySelections
): string {
  if (!s.compareResult) return '';
  const includedDiffs = buildIncludedDiffs(s.compareResult.tables, sel);
  return sqlGenerator().generateMigrationSql(
    includedDiffs,
    s.targetConfig.dialect,
    buildMapping(s),
    s.compareResult.tables
  );
}
