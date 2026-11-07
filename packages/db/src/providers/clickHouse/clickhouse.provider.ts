import { ConnectionFactory } from '../../cores/connection-factory.js';
import { dbSchemaToTableSchemas, errorMessage, parseClickHouseKeyList } from '@foxschema/sql';
import {
  type SchemaProvider,
  type ConnectionOptions,
  type DbSchema,
  type DbTable,
  type DbColumn,
  type DbView,
  type DbForeignKey,
  type DbPrimaryKey,
  type DbUniqueConstraint,
  type DbIndex,
  type DbIndexColumn,
  type TableSchema,
} from '@foxschema/sql';

interface ChTableRaw { name: string; engine: string; sorting_key: string; primary_key: string; }
interface ChViewRaw { name: string; definition: string; }
interface ChColumnRaw {
  table: string;
  name: string;
  position: number;
  type: string;
  is_in_primary_key: number | boolean;
  is_in_sorting_key: number | boolean;
  default_kind: string;
  default_expression: string;
}

/** Strip Nullable(...) and LowCardinality(...) wrappers, returning inner type + nullable flag. */
function unwrapChType(raw: string): { inner: string; nullable: boolean } {
  let t = raw.trim();
  let nullable = false;
  for (let i = 0; i < 3; i++) {
    if (t.startsWith('Nullable(') && t.endsWith(')')) { nullable = true; t = t.slice(9, -1).trim(); continue; }
    if (t.startsWith('LowCardinality(') && t.endsWith(')')) { t = t.slice(15, -1).trim(); continue; }
    break;
  }
  return { inner: t, nullable };
}

export class ClickHouseProvider implements SchemaProvider {
  readonly provider = 'clickhouse';

  async testConnection(options: ConnectionOptions): Promise<boolean> {
    try {
      await ConnectionFactory.executeQuery(this.provider, options, 'SELECT 1');
      return true;
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  }

  async listSchemas(options: ConnectionOptions): Promise<string[]> {
    const rows = await ConnectionFactory.executeQuery<{ name: string }>(
      this.provider,
      options,
      `SELECT name FROM system.databases
       WHERE name NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA', '_temporary_and_external_tables')
       ORDER BY name`
    );
    return rows.map((r) => r.name);
  }

  async getTables(options: ConnectionOptions, schema: string): Promise<TableSchema[]> {
    const dbSchema = await this.loadSchema(options, schema);
    return dbSchemaToTableSchemas(dbSchema);
  }

  async loadSchema(options: ConnectionOptions, schema: string): Promise<DbSchema> {
    const db = schema || options.schema || options.database || 'default';
    const exec = <T>(sql: string, params: readonly unknown[] = []) =>
      ConnectionFactory.executeQuery<T>(this.provider, options, sql, params);

    const [rawTables, rawViews, rawColumns] = await Promise.all([
      exec<ChTableRaw>(
        `SELECT name, engine, sorting_key, primary_key FROM system.tables
         WHERE database = $1 AND engine NOT IN ('View', 'MaterializedView', 'LiveView', 'Window', 'Merge', 'Distributed')
         ORDER BY name`,
        [db]
      ),
      exec<ChViewRaw>(
        `SELECT name, as_select AS definition FROM system.tables
         WHERE database = $1 AND engine IN ('View', 'MaterializedView')
         ORDER BY name`,
        [db]
      ),
      exec<ChColumnRaw>(
        `SELECT table, name, position, type, is_in_primary_key, is_in_sorting_key, default_kind, default_expression
         FROM system.columns WHERE database = $1
         ORDER BY table, position`,
        [db]
      ),
    ]);

    const tables: Record<string, DbTable> = {};
    const columns: Record<string, DbColumn[]> = {};
    const primaryKeys: Record<string, DbPrimaryKey[]> = {};
    const foreignKeys: Record<string, DbForeignKey[]> = {};
    const views: Record<string, DbView[]> = {};
    const uniqueConstraints: Record<string, DbUniqueConstraint[]> = {};
    const indexes: Record<string, DbIndex[]> = {};
    const indexColumns: Record<string, DbIndexColumn[]> = {};

    // Catalog sorting_key / primary_key win: expressions like cityHash64(id)
    // live only there. Column flags fill in when the catalog strings are empty.
    const catalogPk = new Set<string>();
    for (const t of rawTables) {
      const orderBy = parseClickHouseKeyList(t.sorting_key);
      const fromPk = parseClickHouseKeyList(t.primary_key);
      tables[t.name] = {
        name: t.name,
        columns: {},
        primaryKey: fromPk,
        foreignKeys: [],
        uniqueConstraints: [],
        indexes: [],
        ...(t.engine ? { engine: t.engine } : {}),
        // Marked as engine-rendered: sorting_key is ClickHouse's own output, so
        // its entries are already quoted and may be expressions. The column-flag
        // fallback below pushes bare names and deliberately leaves this unset.
        ...(orderBy.length ? { orderBy, orderByFromCatalog: true } : {}),
      };
      columns[t.name] = [];
      primaryKeys[t.name] = fromPk.map((column, i) => ({
        name: column,
        constName: 'PRIMARY_KEY',
        column,
        colSeq: i + 1,
      }));
      if (fromPk.length) catalogPk.add(t.name);
      foreignKeys[t.name] = [];
      uniqueConstraints[t.name] = [];
      indexes[t.name] = [];
    }

    // Columns — unwrap Nullable() and LowCardinality() wrappers
    for (const c of rawColumns) {
      const { inner, nullable } = unwrapChType(c.type);
      const isPk = !!c.is_in_primary_key;
      const col: DbColumn = {
        name: c.name,
        type: inner,
        nullable,
        defaultValue: c.default_kind === 'DEFAULT' ? c.default_expression || undefined : undefined,
        identity: false,
      };
      if (tables[c.table]) {
        tables[c.table].columns[c.name] = col;
        if (isPk && !catalogPk.has(c.table)) tables[c.table].primaryKey.push(c.name);
      }
      (columns[c.table] ??= []).push(col);
      if (isPk && !catalogPk.has(c.table)) {
        (primaryKeys[c.table] ??= []).push({ name: c.name, constName: 'PRIMARY_KEY', column: c.name, colSeq: c.position });
      }
      if (c.is_in_sorting_key && tables[c.table] && !tables[c.table].orderBy?.length) {
        (tables[c.table].orderBy ??= []).push(c.name);
      }
    }

    // Views
    for (const v of rawViews) {
      const viewCols: Record<string, DbColumn> = {};
      for (const c of columns[v.name] ?? []) viewCols[c.name] = c;
      (views[v.name] ??= []).push({ name: v.name, schema: db, definition: v.definition ?? '', columns: viewCols, indexes: [] });
    }

    // these objects dont exists in Click house
    const functions: Record<string, never[]> = {};
    const procedures: Record<string, never[]> = {};
    const triggers: Record<string, never[]> = {};
    const sequences: Record<string, never[]> = {};
    const userTypes: Record<string, never[]> = {};
    
    return { tables, columns, functions, procedures, triggers, sequences, userTypes, primaryKeys, foreignKeys, views, uniqueConstraints, indexes, indexColumns };
  }
}
