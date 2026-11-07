import { ConnectionFactory } from '../../cores/connection-factory.js';
import { stripCreateViewHeader } from '../../cores/view-definition.js';
import { dbSchemaToTableSchemas, groupForeignKeyRows, errorMessage } from '@foxschema/sql';
import {
  type SchemaProvider,
  type ConnectionOptions,
  type DbSchema,
  type DbTable,
  type DbColumn,
  type DbTrigger,
  type DbView,
  type DbForeignKey,
  type DbIndex,
  type TableSchema,
} from '@foxschema/sql';

// sqlite_master / PRAGMA result shapes
interface SqliteMasterRaw { name: string; sql: string | null; tbl_name?: string; }
interface SqliteColRaw { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number; }
interface SqliteIdxRaw { seq: number; name: string; unique: number; origin: string; partial: number; }
interface SqliteIdxColRaw { seqno: number; cid: number; name: string; }
interface SqliteFkRaw { id: number; seq: number; table: string; from: string; to: string | null; }

export class SqliteProvider implements SchemaProvider {
  readonly provider = 'sqlite';

  async testConnection(options: ConnectionOptions): Promise<boolean> {
    try {
      await ConnectionFactory.executeQuery(this.provider, options, `SELECT 1`);
      return true;
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  }

  /** SQLite has no schemas — returns the attached database names. */
  async listSchemas(options: ConnectionOptions): Promise<string[]> {
    const rows = await ConnectionFactory.executeQuery<{ name: string }>(
      this.provider,
      options,
      `PRAGMA database_list`
    );
    return rows.map((r) => r.name);
  }

  async getTables(options: ConnectionOptions, schema: string): Promise<TableSchema[]> {
    const dbSchema = await this.loadSchema(options, schema);
    return dbSchemaToTableSchemas(dbSchema);
  }

  async loadSchema(options: ConnectionOptions, _schema: string): Promise<DbSchema> {
    // SQLite has no schema namespaces — all objects are in one flat space.
    // We run all PRAGMA queries against the single open database.
    const exec = <T>(sql: string, params: readonly unknown[] = []) =>
      ConnectionFactory.executeQuery<T>(this.provider, options, sql, params);

    const [rawTables, rawViews, rawTriggers] = await Promise.all([
      exec<SqliteMasterRaw>(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`),
      exec<SqliteMasterRaw>(`SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name`),
      exec<SqliteMasterRaw>(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name`),
    ]);

    const tables: Record<string, DbTable> = {};
    const columns: Record<string, DbColumn[]> = {};
    const functions: Record<string, never[]> = {}; // SQLite has no stored functions
    const procedures: Record<string, never[]> = {};
    const triggers: Record<string, DbTrigger[]> = {};
    const sequences: Record<string, never[]> = {};
    const userTypes: Record<string, never[]> = {};
    const primaryKeys: Record<string, never[]> = {};
    const foreignKeys: Record<string, DbForeignKey[]> = {};
    const uniqueConstraints: Record<string, never[]> = {};
    const indexes: Record<string, DbIndex[]> = {};
    const indexColumns: Record<string, never[]> = {};
    const views: Record<string, DbView[]> = {};

    // Bound PRAGMA fan-out so large DBs don't open N+1 storms serially forever.
    const PRAGMA_CONCURRENCY = 12;
    const qIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

    const mapPool = async <T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
      if (items.length === 0) return [];
      const results = new Array<R>(items.length);
      let next = 0;
      const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
          const i = next++;
          results[i] = await fn(items[i]!);
        }
      });
      await Promise.all(workers);
      return results;
    };

    type TableLoad = {
      name: string;
      colMap: Record<string, DbColumn>;
      colList: DbColumn[];
      pkCols: string[];
      fkList: DbForeignKey[];
      tableIdxs: DbIndex[];
    };

    const loadedTables = await mapPool(rawTables, PRAGMA_CONCURRENCY, async (t): Promise<TableLoad> => {
      const [rawCols, rawIdxList, rawFkList] = await Promise.all([
        exec<SqliteColRaw>(`PRAGMA table_info(${qIdent(t.name)})`),
        exec<SqliteIdxRaw>(`PRAGMA index_list(${qIdent(t.name)})`),
        exec<SqliteFkRaw>(`PRAGMA foreign_key_list(${qIdent(t.name)})`),
      ]);

      const pkCols = rawCols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);

      const colMap: Record<string, DbColumn> = {};
      const colList: DbColumn[] = [];
      for (const col of rawCols) {
        const mapped: DbColumn = {
          name: col.name,
          type: col.type || 'TEXT',
          nullable: col.notnull === 0 && col.pk === 0,
          defaultValue: col.dflt_value ?? undefined,
          identity: col.type?.toUpperCase() === 'INTEGER' && pkCols.length === 1 && col.pk === 1,
        };
        colMap[col.name] = mapped;
        colList.push(mapped);
      }

      // `to` is NULL for `REFERENCES parent` with no column list — SQLite means
      // "the parent's PK". groupForeignKeyRows drops those, so the shared
      // resolver fills them from the real parent PK instead of emitting nulls.
      const orderedFks = [...rawFkList].sort((a, b) => a.id - b.id || a.seq - b.seq);
      const fkList: DbForeignKey[] = groupForeignKeyRows(orderedFks, (fk) => ({
        key: String(fk.id),
        name: `fk_${t.name}_${fk.table}`,
        table: t.name,
        column: fk.from,
        referencedSchema: '',
        referencedTable: fk.table,
        referencedColumn: fk.to,
      })).map((g) => g.fk);

      const idxCandidates = rawIdxList.filter((ix) => ix.origin !== 'pk');
      const tableIdxs = await mapPool(idxCandidates, PRAGMA_CONCURRENCY, async (ix) => {
        const rawIdxCols = await exec<SqliteIdxColRaw>(`PRAGMA index_info(${qIdent(ix.name)})`);
        const ixCols = rawIdxCols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
        return { name: ix.name, uniqueRule: ix.unique ? 'U' : 'D', columns: ixCols } satisfies DbIndex;
      });

      return { name: t.name, colMap, colList, pkCols, fkList, tableIdxs };
    });

    for (const t of loadedTables) {
      tables[t.name] = {
        name: t.name,
        columns: t.colMap,
        primaryKey: t.pkCols,
        foreignKeys: t.fkList,
        uniqueConstraints: [],
        indexes: t.tableIdxs,
      };
      columns[t.name] = t.colList;
      primaryKeys[t.name] = [];
      foreignKeys[t.name] = t.fkList;
      indexes[t.name] = t.tableIdxs;
    }

    // Views — also batched
    const loadedViews = await mapPool(rawViews, PRAGMA_CONCURRENCY, async (vw) => {
      const rawVwCols = await exec<SqliteColRaw>(`PRAGMA table_info(${qIdent(vw.name)})`);
      const viewColumns: Record<string, DbColumn> = {};
      for (const col of rawVwCols) {
        viewColumns[col.name] = { name: col.name, type: col.type || 'TEXT', nullable: true, defaultValue: undefined };
      }
      return { name: vw.name, sql: vw.sql, viewColumns };
    });
    for (const vw of loadedViews) {
      (views[vw.name] ??= []).push({
        name: vw.name,
        schema: '',
        // sqlite_master.sql is the FULL "CREATE VIEW name AS <body>" text, but
        // `definition` holds only the query — see stripCreateViewHeader.
        definition: stripCreateViewHeader(vw.sql),
        columns: vw.viewColumns,
        indexes: [],
      });
    }

    // Triggers
    for (const trg of rawTriggers) {
      (triggers[trg.name] ??= []).push({ name: trg.name, schema: '', tableName: trg.tbl_name ?? '', event: '', timing: '', definition: trg.sql ?? '' });
    }

    return {
      tables, columns,
      functions: functions as Record<string, any[]>,
      procedures: procedures as Record<string, any[]>,
      triggers,
      sequences: sequences as Record<string, any[]>,
      userTypes: userTypes as Record<string, any[]>,
      primaryKeys: primaryKeys as Record<string, any[]>,
      foreignKeys,
      uniqueConstraints: uniqueConstraints as Record<string, any[]>,
      indexes,
      indexColumns: indexColumns as Record<string, any[]>,
      views,
    };
  }
}
