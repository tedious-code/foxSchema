import { type SchemaCompareResult, type TableDiff, type ColumnDiff, type IndexDiff, type ForeignKeyDiff, type TriggerDiff } from '../../interfaces/index.js';
import { type TableSchema, type ColumnInfo, type IndexInfo, type ForeignKeyInfo, type TriggerInfo } from '../../interfaces/index.js';
import type { SqlDialect } from '../dialect/sql-dialect.interface.js';
import { resolveDialect } from '../dialect/registry.js';
import { canonicalEquals } from '../dialect/type-mapping.js';
import { compareKey } from './compare-key.js';
import { normalizeDefinitionText, stripSchemaQualifiers } from './definition-text.js';

export class CompareModule {
  /** When set (and the dialects differ), columns are compared by canonical type. */
  private sourceDialect: SqlDialect | null = null;
  private targetDialect: SqlDialect | null = null;
  /**
   * The source/target schema names (e.g. demo_a, demo_b). Their qualifiers are
   * stripped from definitions and defaults so that a routine/trigger/default which is
   * identical except for its schema prefix (which the migration re-qualifies to the
   * target) doesn't read as MODIFIED after a deploy.
   */
  private compareSchemas: string[] = [];

  /**
   * Normalizes an object name for matching: drops any leading "schema." qualifier
   * and uppercases. So HUY.MyTable, "YOU".MyTable and MyTable all match —
   * the comparison is about the object, not which schema it was read from.
   */
  private key(name: string): string {
    return compareKey(name);
  }

  /**
   * Ordered, case-insensitive comparison of two identifier lists (index / FK / PK
   * columns). The tool matches every identifier case-insensitively (see `key`), so a
   * column list read as `category_id` from one schema and `CATEGORY_ID` from the other
   * (e.g. after a migration re-emits DDL) must not read as a change. Order matters —
   * a composite index (a, b) differs from (b, a).
   */
  private sameColumns(a: string[] = [], b: string[] = []): boolean {
    if (a.length !== b.length) return false;
    return a.every((c, i) => (c ?? '').toUpperCase() === (b[i] ?? '').toUpperCase());
  }

  async compare(
    sourceSchemas: TableSchema[],
    targetSchemas: TableSchema[],
    dialects?: { source?: string; target?: string },
    schemas?: { source?: string; target?: string }
  ): Promise<SchemaCompareResult> {
    // Cross-dialect: resolve both strategies so equivalent native types (e.g.
    // DB2 VARCHAR(255) vs Postgres "character varying(255)") aren't false-flagged.
    const src = dialects?.source;
    const tgt = dialects?.target;
    const crossDialect = !!src && !!tgt && resolveDialect(src) !== resolveDialect(tgt);
    this.sourceDialect = crossDialect ? resolveDialect(src!) : null;
    this.targetDialect = crossDialect ? resolveDialect(tgt!) : null;
    // Both sides are normalized with both schema names stripped, so a definition that
    // references demo_a.* (source) matches its migrated demo_b.* (target) counterpart.
    this.compareSchemas = [schemas?.source, schemas?.target].filter((s): s is string => !!s);

    const sourceMap = new Map<string, TableSchema>(sourceSchemas.map((t) => [this.key(t.name), t]));
    const targetMap = new Map<string, TableSchema>(targetSchemas.map((t) => [this.key(t.name), t]));

    const allTableNames = Array.from(new Set([...Array.from(sourceMap.keys()), ...Array.from(targetMap.keys())]));
    const tableDiffs: TableDiff[] = [];

    let added = 0;
    let removed = 0;
    let modified = 0;
    let unchanged = 0;

    for (const tableName of allTableNames) {
      const source = sourceMap.get(tableName);
      const target = targetMap.get(tableName);

      if (source && !target) {
        // Table added in source (needs to be created in target to sync)
        added++;
        tableDiffs.push({
          tableName,
          objectType: source.objectType,
          status: 'ADDED',
          definition: source.definition,
          columnDiffs: source.columns.map((c) => ({ name: c.name, status: 'ADDED', source: c })),
          indexDiffs: source.indices.map((i) => ({ name: i.name, status: 'ADDED', source: i })),
          foreignKeyDiffs: source.foreignKeys.map((f) => ({ name: f.name, status: 'ADDED', source: f })),
          triggerDiffs: (source.triggers ?? []).map((t) => ({ name: t.name, status: 'ADDED' as const, source: t })),
          sourceTable: source,
        });
      } else if (!source && target) {
        // Table exists in target but not in source (needs to be dropped in target to match source)
        removed++;
        tableDiffs.push({
          tableName,
          objectType: target.objectType,
          status: 'REMOVED',
          definition: target.definition,
          columnDiffs: target.columns.map((c) => ({ name: c.name, status: 'REMOVED', target: c })),
          indexDiffs: target.indices.map((i) => ({ name: i.name, status: 'REMOVED', target: i })),
          foreignKeyDiffs: target.foreignKeys.map((f) => ({ name: f.name, status: 'REMOVED', target: f })),
          triggerDiffs: (target.triggers ?? []).map((t) => ({ name: t.name, status: 'REMOVED' as const, target: t })),
          targetTable: target,
        });
      } else if (source && target) {
        // Evaluate structural differences
        const columnDiffs = this.compareColumns(source.columns, target.columns);
        const indexDiffs = this.compareIndices(source.indices, target.indices);
        const foreignKeyDiffs = this.compareForeignKeys(source.foreignKeys, target.foreignKeys);
        const triggerDiffs = this.compareTriggers(source.triggers ?? [], target.triggers ?? []);

        const pkChanged = !this.sameColumns(source.primaryKey?.columns, target.primaryKey?.columns);
        const engineChanged =
          (source.engine ?? '').toLowerCase() !== (target.engine ?? '').toLowerCase();
        const orderByChanged = !this.sameColumns(source.orderBy, target.orderBy);

        // Sequences and user-defined types carry their state in dedicated fields
        const sequenceChanged = JSON.stringify(source.sequence ?? {}) !== JSON.stringify(target.sequence ?? {});
        const userTypeChanged = JSON.stringify(source.userType ?? {}) !== JSON.stringify(target.userType ?? {});

        // Index renames (same columns/unique, different name) stay in indexDiffs for
        // the blueprint opt-in, but must not roll the table up as MODIFIED.
        const isModified =
          columnDiffs.some((d) => d.status !== 'UNCHANGED') ||
          indexDiffs.some((d) => d.status !== 'UNCHANGED' && !d.nameOnly) ||
          foreignKeyDiffs.some((d) => d.status !== 'UNCHANGED') ||
          triggerDiffs.some((d) => d.status !== 'UNCHANGED') ||
          pkChanged ||
          engineChanged ||
          orderByChanged ||
          sequenceChanged ||
          userTypeChanged ||
          this.normalizeDefinition(source.definition) !== this.normalizeDefinition(target.definition);

        if (isModified) {
          modified++;
        } else {
          unchanged++;
        }

        tableDiffs.push({
          tableName,
          objectType: source.objectType,
          status: isModified ? 'MODIFIED' : 'UNCHANGED',
          definition: source.definition || target.definition,
          columnDiffs,
          indexDiffs,
          foreignKeyDiffs,
          triggerDiffs,
          sourceTable: source,
          targetTable: target,
        });
      }
    }

    return {
      tables: tableDiffs.sort((a, b) => a.tableName.localeCompare(b.tableName)),
      summary: { added, removed, modified, unchanged },
    };
  }

  /**
   * Whether two native type strings differ. Same-dialect: a case-insensitive
   * string compare (unchanged behavior). Cross-dialect: a canonical compare so
   * equivalent types across dialects aren't flagged as a change.
   */
  /**
   * Normalize a procedural object definition (view body, function body, etc.)
   * for semantic comparison. Postgres reformats definitions on storage — different
   * whitespace, implicit schema prefixes, lower-cased identifiers — so a raw
   * string compare always shows MODIFIED after a successful migration.
   *
   * The rules live in `normalizeDefinitionText`, shared with Lokee's content
   * hash so the two cannot disagree about whether an object changed.
   */
  private normalizeDefinition(d: string | undefined | null): string {
    return normalizeDefinitionText(d, this.compareSchemas);
  }

  private stripSchemaQualifiers(s: string): string {
    return stripSchemaQualifiers(s, this.compareSchemas);
  }

  /**
   * Normalize a column default for comparison so cosmetic differences (like
   * Postgres auto-qualifying `nextval('seq')` → `nextval('schema.seq'::regclass)`)
   * don't show up as changes after a successful migration.
   */
  private normalizeDefault(d: string | undefined | null): string {
    if (d == null) return '';
    // DEFAULT NULL is semantically identical to having no default. MariaDB's
    // information_schema reports the literal string 'NULL' for nullable
    // no-default columns (MySQL 8 reports a real NULL there), so without this
    // a MariaDB side false-flags every nullable column against any engine
    // that reports "no default" as absent.
    if (d.trim().toUpperCase() === 'NULL') return '';
    // Drop schema qualifiers first, so SQL Server `NEXT VALUE FOR [demo_a].[order_seq]`
    // matches its migrated `[demo_b].[order_seq]` counterpart.
    return this.stripSchemaQualifiers(d)
      // Strip ::regclass / ::text / ::character varying etc. casts
      // eslint-disable-next-line security/detect-unsafe-regex -- false positive: (\([^)]*\)) uses a negated class, which cannot backtrack catastrophically
      .replace(/::[\w\s]+(\([^)]*\))?/g, '')
      // nextval('schema.seq') → nextval('seq') — ignore schema qualifier inside nextval
      .replace(/nextval\('([^']+)'\)/gi, (_, seq) => `nextval('${seq.split('.').pop()!}')`)
      // Oracle: demo_a.order_seq.NEXTVAL → order_seq.NEXTVAL — drop the schema prefix
      // (case-insensitively) so demo_a.* vs DEMO_B.* on the same sequence converges
      // to UNCHANGED after a migration. Only strips the schema before <seq>.NEXTVAL/CURRVAL.
      .replace(/\b[\w$]+\s*\.\s*([\w$]+\s*\.\s*(?:nextval|currval))\b/gi, '$1')
      // lowercase + collapse whitespace
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  private typeChanged(sourceType: string, targetType: string): boolean {
    if (this.sourceDialect && this.targetDialect) {
      return !canonicalEquals(this.sourceDialect.parseType(sourceType), this.targetDialect.parseType(targetType));
    }
    return sourceType.toLowerCase() !== targetType.toLowerCase();
  }

  /**
   * Collation names are dialect-specific vocabulary (Postgres "en_US.utf8" vs
   * MySQL "utf8mb4_unicode_ci" vs SQL Server "SQL_Latin1_General_CP1_CI_AS") with
   * no cross-engine mapping, unlike types. A raw compare across genuinely
   * different dialects would flag nearly every character column as changed, so
   * this only fires within the same dialect (or a same-catalog family already
   * treated as non-cross-dialect, e.g. MySQL/MariaDB, SQL Server/Azure SQL).
   */
  private collationChanged(source?: string, target?: string): boolean {
    if (this.sourceDialect && this.targetDialect) return false;
    return (source ?? '').trim().toUpperCase() !== (target ?? '').trim().toUpperCase();
  }

  private compareColumns(sourceCols: ColumnInfo[], targetCols: ColumnInfo[]): ColumnDiff[] {
    const sMap = new Map(sourceCols.map((c) => [this.key(c.name), c]));
    const tMap = new Map(targetCols.map((c) => [this.key(c.name), c]));
    const allColNames = Array.from(new Set([...Array.from(sMap.keys()), ...Array.from(tMap.keys())]));

    return allColNames.map((name) => {
      const sCol = sMap.get(name);
      const tCol = tMap.get(name);

      if (sCol && !tCol) {
        return { name, status: 'ADDED', source: sCol };
      } else if (!sCol && tCol) {
        return { name, status: 'REMOVED', target: tCol };
      } else if (sCol && tCol) {
        const typeChanged = this.typeChanged(sCol.type, tCol.type);
        const nullChanged = sCol.nullable !== tCol.nullable;
        const defaultChanged = this.normalizeDefault(sCol.defaultValue) !== this.normalizeDefault(tCol.defaultValue);
        const pkChanged = sCol.primaryKey !== tCol.primaryKey;
        const identityChanged = !!sCol.identity !== !!tCol.identity;
        const collationChanged = this.collationChanged(sCol.collation, tCol.collation);

        if (typeChanged || nullChanged || defaultChanged || pkChanged || identityChanged || collationChanged) {
          return { name, status: 'MODIFIED', source: sCol, target: tCol };
        }
        return { name, status: 'UNCHANGED', source: sCol, target: tCol };
      }
      return { name, status: 'UNCHANGED' };
    });
  }

  /**
   * Structural signature for pairing rename-only indexes: ordered columns + unique.
   * Name is intentionally excluded — that is what "rename" means here.
   */
  private indexSignature(idx: { columns: string[]; unique: boolean }): string {
    const cols = (idx.columns ?? []).map((c) => (c ?? '').toUpperCase()).join('\0');
    return `${cols}|${idx.unique ? 'U' : 'N'}`;
  }

  /**
   * Pair unmatched ADDED ↔ REMOVED indexes that share columns + uniqueness and
   * mark both sides `nameOnly`. Left as ADDED/REMOVED so the blueprint can still
   * offer DROP+CREATE when the user opts in.
   */
  private markNameOnlyIndexRenames(diffs: IndexDiff[]): IndexDiff[] {
    const added = diffs
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.status === 'ADDED' && d.source);
    const removed = diffs
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.status === 'REMOVED' && d.target);

    const usedAdded = new Set<number>();
    const nameOnlyIdx = new Set<number>();

    for (const { d: rem, i: remI } of removed) {
      const sig = this.indexSignature(rem.target!);
      const match = added.find(({ d, i }) => !usedAdded.has(i) && this.indexSignature(d.source!) === sig);
      if (!match) continue;
      usedAdded.add(match.i);
      nameOnlyIdx.add(remI);
      nameOnlyIdx.add(match.i);
    }

    if (nameOnlyIdx.size === 0) return diffs;
    return diffs.map((d, i) => (nameOnlyIdx.has(i) ? { ...d, nameOnly: true } : d));
  }

  private compareIndices(sourceInds: IndexInfo[], targetInds: IndexInfo[]): IndexDiff[] {
    const sMap = new Map(sourceInds.map((i) => [this.key(i.name), i]));
    const tMap = new Map(targetInds.map((i) => [this.key(i.name), i]));
    const allIndNames = Array.from(new Set([...Array.from(sMap.keys()), ...Array.from(tMap.keys())]));

    const byName = allIndNames.map((name) => {
      const sIdx = sMap.get(name);
      const tIdx = tMap.get(name);

      if (sIdx && !tIdx) {
        return { name, status: 'ADDED' as const, source: sIdx };
      } else if (!sIdx && tIdx) {
        return { name, status: 'REMOVED' as const, target: tIdx };
      } else if (sIdx && tIdx) {
        const columnsChanged = !this.sameColumns(sIdx.columns, tIdx.columns);
        const uniqueChanged = sIdx.unique !== tIdx.unique;

        if (columnsChanged || uniqueChanged) {
          return { name, status: 'MODIFIED' as const, source: sIdx, target: tIdx };
        }
        return { name, status: 'UNCHANGED' as const, source: sIdx, target: tIdx };
      }
      return { name, status: 'UNCHANGED' as const };
    });

    return this.markNameOnlyIndexRenames(byName);
  }

  private compareTriggers(sourceTrgs: TriggerInfo[], targetTrgs: TriggerInfo[]): TriggerDiff[] {
    const sMap = new Map(sourceTrgs.map((t) => [this.key(t.name), t]));
    const tMap = new Map(targetTrgs.map((t) => [this.key(t.name), t]));
    const allNames = Array.from(new Set([...Array.from(sMap.keys()), ...Array.from(tMap.keys())]));

    return allNames.map((name) => {
      const sTrg = sMap.get(name);
      const tTrg = tMap.get(name);

      if (sTrg && !tTrg) {
        return { name, status: 'ADDED' as const, source: sTrg };
      } else if (!sTrg && tTrg) {
        return { name, status: 'REMOVED' as const, target: tTrg };
      } else if (sTrg && tTrg) {
        const defChanged = this.normalizeDefinition(sTrg.definition) !== this.normalizeDefinition(tTrg.definition);
        if (defChanged) {
          return { name, status: 'MODIFIED' as const, source: sTrg, target: tTrg };
        }
        return { name, status: 'UNCHANGED' as const, source: sTrg, target: tTrg };
      }
      return { name, status: 'UNCHANGED' as const };
    });
  }

  private compareForeignKeys(sourceFks: ForeignKeyInfo[], targetFks: ForeignKeyInfo[]): ForeignKeyDiff[] {
    const sMap = new Map(sourceFks.map((f) => [this.key(f.name), f]));
    const tMap = new Map(targetFks.map((f) => [this.key(f.name), f]));
    const allFkNames = Array.from(new Set([...Array.from(sMap.keys()), ...Array.from(tMap.keys())]));

    return allFkNames.map((name) => {
      const sFk = sMap.get(name);
      const tFk = tMap.get(name);

      if (sFk && !tFk) {
        return { name, status: 'ADDED', source: sFk };
      } else if (!sFk && tFk) {
        return { name, status: 'REMOVED', target: tFk };
      } else if (sFk && tFk) {
        const colChanged = !this.sameColumns(sFk.columns, tFk.columns);
        const refTableChanged = this.key(sFk.referencedTable) !== this.key(tFk.referencedTable);
        const refColChanged = !this.sameColumns(sFk.referencedColumns, tFk.referencedColumns);

        if (colChanged || refTableChanged || refColChanged) {
          return { name, status: 'MODIFIED', source: sFk, target: tFk };
        }
        return { name, status: 'UNCHANGED', source: sFk, target: tFk };
      }
      return { name, status: 'UNCHANGED' };
    });
  }
}
