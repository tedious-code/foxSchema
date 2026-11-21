import { ConnectionFactory } from '@foxschema/db';
import { type ConnectionOptions, type SchemaProvider, errorMessage } from '@foxschema/sql';

import {
  type DbProcedure,
  type DbSchema,
  type DbSequence,
  type DbTrigger,
  type DbTable,
  type DbColumn,
  type DbPrimaryKey,
  type DbForeignKey,
  type DbUniqueConstraint,
  type DbIndex,
  type DbIndexColumn,
  type DbView,
  type DbUserType,
  type TableSchema,
  type RoutineParameter,
  type RoutineParameterMode,
  type DbRole,
} from '@foxschema/sql';
import {
  type Db2TableRaw,
  type Db2ColumnRaw,
  type Db2PrimaryKeyRaw,
  type Db2ForeignKeyRaw,
  type Db2UniqueConstraintRaw,
  type Db2IndexRaw,
  type Db2IndexColumnRaw,
  type Db2ViewRaw,
  type Db2TriggerRaw,
  type Db2ProcedureRaw,
  type Db2RoutineParmRaw,
  type Db2RoleRaw,
  type Db2RoleAuthRaw,
  type Db2SequenceRaw,
  type Db2UserTypeRaw,
  type Db2AttributeRaw
} from "./db2.interface.js";
import { resolveFkReferencedColumns } from '@foxschema/sql';

export class Db2Provider implements SchemaProvider {
  readonly provider = 'db2';

  async testConnection(options: ConnectionOptions): Promise<boolean> {
    let connection: any;

    try {
      connection = await ConnectionFactory.create(this.provider, options);
      const sql = `SELECT 1 FROM SYSIBM.SYSDUMMY1;`;

      await new Promise<void>((resolve, reject) => {
        connection.query(sql, [], (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      return true;
    } catch (error) {
      const message = errorMessage(error);
      console.error('Error testing DB2 connection:', error);
      throw new Error(message);
    } finally {
      await ConnectionFactory.close(this.provider, connection);
    }
  }

  async detectVersion(options: ConnectionOptions): Promise<string> {
    try {
      const rows = await ConnectionFactory.executeQuery<{ SERVICE_LEVEL: string }>(
        this.provider,
        options,
        `SELECT SERVICE_LEVEL FROM SYSIBMADM.ENV_INST_INFO`
      );
      const level = rows[0]?.SERVICE_LEVEL ?? '';
      // "DB2 v11.5.7.0" → "11.5.7.0"
      const m = level.match(/v(\d+[\d.]*)/);
      return m ? m[1] : level;
    } catch {
      return '';
    }
  }

  async listSchemas(options: ConnectionOptions): Promise<string[]> {
    const rows = await ConnectionFactory.executeQuery<{ SCHEMANAME: string }>(
      this.provider,
      options,
      `SELECT TRIM(SCHEMANAME) AS SCHEMANAME
       FROM SYSCAT.SCHEMATA
       WHERE SCHEMANAME NOT LIKE 'SYS%' AND SCHEMANAME NOT IN ('NULLID', 'SQLJ')
       ORDER BY SCHEMANAME`
    );
    return rows.map((r) => r.SCHEMANAME);
  }

  async getTables(options: ConnectionOptions, schema: string): Promise<TableSchema[]> {
    const dbSchema = await this.loadSchema(options, schema);
    const result: TableSchema[] = [];

    // Triggers belong to their table; group them by owning table name
    const triggersByTable = new Map<string, { name: string; timing?: string; event?: string; definition?: string }[]>();
    for (const list of Object.values(dbSchema.triggers)) {
      for (const t of list) {
        const owned = triggersByTable.get(t.tableName) ?? [];
        owned.push({ name: t.name, timing: t.timing, event: t.event, definition: t.definition });
        triggersByTable.set(t.tableName, owned);
      }
    }

    // PK columns from the constraint catalog, falling back to the 'P' index that
    // always backs a primary key (covers composite keys and TABCONST visibility gaps)
    const pkColumnsOf = (table?: DbTable): string[] => {
      if (!table) return [];
      if (table.primaryKey.length > 0) return table.primaryKey;
      return table.indexes.find((i) => i.uniqueRule === 'P')?.columns ?? [];
    };

    for (const table of Object.values(dbSchema.tables)) {
      const pkColumns = pkColumnsOf(table);
      const pkSet = new Set(pkColumns);
      result.push({
        name: table.name,
        objectType: table.isMqt ? 'MQT' : 'TABLE',
        tablespace: table.tablespace,
        triggers: triggersByTable.get(table.name) ?? [],
        primaryKey: pkColumns.length > 0
          // Drop DB2's system-generated PK constraint name (SQL<timestamp>): the
          // generator would emit it as `CONSTRAINT SQL... PRIMARY KEY`, which
          // both re-uses a non-portable name and can collide with a unique
          // index's system name on the target. Leaving it undefined makes the
          // generator emit a bare `PRIMARY KEY (cols)` and DB2 auto-names it.
          ? { name: this.normalizeSystemName(dbSchema.primaryKeys[table.name]?.[0]?.constName), columns: pkColumns }
          : undefined,
        columns: Object.values(table.columns).map((c) => ({
          name: c.name,
          type: this.formatType(c),
          nullable: c.nullable,
          defaultValue: c.defaultValue,
          primaryKey: pkSet.has(c.name),
          identity: c.identity,
          identityGeneration: c.identityGeneration,
        })),
        // The 'P' index backs the primary key constraint — not a standalone index
        indices: table.indexes
          .filter((i) => i.uniqueRule !== 'P')
          .map((i) => ({ name: i.name, columns: i.columns, unique: i.uniqueRule !== 'D' })),
        foreignKeys: table.foreignKeys.map((fk) => {
          const schema = typeof fk.referencedSchema === 'string' ? fk.referencedSchema.trim() : '';
          return {
            name: fk.name,
            columns: fk.columns,
            referencedTable: fk.referencedTable,
            ...(schema ? { referencedSchema: schema } : {}),
            referencedColumns: resolveFkReferencedColumns(
              fk.columns,
              fk.referencedColumns,
              pkColumnsOf(dbSchema.tables[fk.referencedTable])
            ),
          };
        }),
      });
    }

    for (const viewList of Object.values(dbSchema.views)) {
      for (const v of viewList) {
        result.push({
          name: v.name,
          objectType: 'VIEW',
          definition: v.definition,
          columns: Object.values(v.columns).map((c) => ({
            name: c.name,
            type: this.formatType(c),
            nullable: c.nullable,
            defaultValue: c.defaultValue,
            primaryKey: false,
            identity: c.identity,
            identityGeneration: c.identityGeneration,
          })),
          indices: [],
          foreignKeys: [],
        });
      }
    }
    for (const list of Object.values(dbSchema.functions)) {
      for (const f of list) {
        result.push({
          name: f.name,
          objectType: 'FUNCTION',
          definition: f.definition,
          columns: [],
          indices: [],
          foreignKeys: [],
          parameters: f.parameters ?? [],
          functionKind: f.functionType === 'T' ? 'table' : 'scalar',
        });
      }
    }
    for (const list of Object.values(dbSchema.procedures)) {
      for (const p of list) {
        result.push({
          name: p.name,
          objectType: 'PROCEDURE',
          definition: p.definition,
          columns: [],
          indices: [],
          foreignKeys: [],
          parameters: p.parameters ?? [],
        });
      }
    }
    for (const list of Object.values(dbSchema.sequences)) {
      for (const s of list) {
        result.push({
          name: s.name,
          objectType: 'SEQUENCE',
          columns: [], indices: [], foreignKeys: [],
          sequence: {
            dataType: s.dataType,
            start: s.startValue,
            increment: s.increment,
            minValue: s.minValue,
            maxValue: s.maxValue,
            cycle: s.cycle,
            cache: s.cache,
          },
        });
      }
    }
    for (const list of Object.values(dbSchema.userTypes)) {
      for (const u of list) {
        result.push({
          name: u.name,
          objectType: 'TYPE',
          columns: [], indices: [], foreignKeys: [],
          userType: { sourceType: u.sourceType, metaType: u.metaType, attributes: u.attributes },
        });
      }
    }
    // Only triggers whose table is outside this schema remain standalone objects
    for (const list of Object.values(dbSchema.triggers)) {
      for (const t of list) {
        if (!dbSchema.tables[t.tableName]) {
          result.push({ name: t.name, objectType: 'TRIGGER', definition: t.definition, columns: [], indices: [], foreignKeys: [] });
        }
      }
    }

    // Roles: members are modeled as "columns" (name = grantee, type = USER/
    // GROUP/ROLE) so they flow through the column compare and blueprint, and a
    // member add/remove shows the role as MODIFIED.
    for (const role of dbSchema.roles ?? []) {
      result.push({
        name: role.name,
        objectType: 'ROLE',
        columns: role.members.map((m) => ({ name: m.grantee, type: m.granteeType, nullable: true, primaryKey: false })),
        indices: [],
        foreignKeys: [],
      });
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * DB2 auto-generates constraint/index names as "SQL<17-digit-timestamp>" for
   * unnamed PK/UNIQUE constraints. Those are non-portable (target generates its
   * own) and can collide across object types on the target. Return undefined so
   * the generator omits the name and lets DB2 assign a fresh one.
   */
  private normalizeSystemName(name: string | undefined): string | undefined {
    return name && /^SQL\d+$/i.test(name.trim()) ? undefined : name;
  }

  private formatType(c: { type: string; length?: number; scale?: number }): string {
    const type = c.type.trim().toUpperCase();
    if ((type === 'DECIMAL' || type === 'NUMERIC') && c.length) {
      return `${type}(${c.length},${c.scale ?? 0})`;
    }
    if (['CHARACTER', 'CHAR', 'VARCHAR', 'GRAPHIC', 'VARGRAPHIC', 'CLOB', 'BLOB', 'DBCLOB', 'BINARY', 'VARBINARY'].includes(type) && c.length) {
      return `${type}(${c.length})`;
    }
    return type;
  }

  async loadSchema(options: ConnectionOptions, schema: string): Promise<DbSchema> {
    const schemaName = schema.toUpperCase();
    const conn = await ConnectionFactory.create(this.provider, options);

    try {
      const [
        rawTables,
        rawColumns,
        rawPrimaryKeys,
        rawForeignKeys,
        rawUniqueConstraints,
        rawIndexes,
        rawIndexColumns,
        rawViews,
        rawTriggers,
        rawProcedures,
        rawSequences,
        rawUserTypes,
        rawAttributes,
        rawRoutineParms,
        rawRoles,
        rawRoleAuths
      ] = await Promise.all([
        ConnectionFactory.executeOnConnection<Db2TableRaw>(
          this.provider, conn,
          // TYPE 'T' = base table, 'S' = materialized query table (MQT)
          `SELECT TABSCHEMA, TABNAME, TYPE, TBSPACE FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TYPE IN ('T', 'S') ORDER BY TABNAME`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2ColumnRaw>(
          this.provider, conn,
          `SELECT TABNAME, COLNAME, COLNO, TYPENAME, LENGTH, SCALE, NULLS, DEFAULT, IDENTITY, GENERATED FROM SYSCAT.COLUMNS WHERE TABSCHEMA = ? ORDER BY TABNAME, COLNO`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2PrimaryKeyRaw>(
          this.provider, conn,
          `SELECT TC.TABNAME, TC.CONSTNAME, K.COLNAME, K.COLSEQ
           FROM SYSCAT.TABCONST TC
           JOIN SYSCAT.KEYCOLUSE K ON TC.CONSTNAME = K.CONSTNAME AND TC.TABSCHEMA = K.TABSCHEMA AND TC.TABNAME = K.TABNAME
           WHERE TC.TYPE = 'P' AND TC.TABSCHEMA = ?
           ORDER BY TC.TABNAME, K.COLSEQ`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2ForeignKeyRaw>(
          this.provider, conn,
          `SELECT R.TABNAME, R.CONSTNAME, K.COLNAME, RK.COLNAME AS REFCOLNAME,
                  R.REFTABSCHEMA, R.REFTABNAME
           FROM SYSCAT.REFERENCES R
           JOIN SYSCAT.KEYCOLUSE K
             ON R.CONSTNAME = K.CONSTNAME AND R.TABSCHEMA = K.TABSCHEMA
           JOIN SYSCAT.KEYCOLUSE RK
             ON R.REFKEYNAME = RK.CONSTNAME AND R.REFTABSCHEMA = RK.TABSCHEMA
            AND K.COLSEQ = RK.COLSEQ
           WHERE R.TABSCHEMA = ?
           ORDER BY R.TABNAME, R.CONSTNAME, K.COLSEQ`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2UniqueConstraintRaw>(
          this.provider, conn,
          `SELECT TABNAME, CONSTNAME FROM SYSCAT.TABCONST WHERE TYPE = 'U' AND TABSCHEMA = ?`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2IndexRaw>(
          this.provider, conn,
          // 'P' rows (PK-backing indexes) are kept here so pkColumnsOf can fall
          // back to them, but schema-to-tables filters them out of the emitted
          // index list. Unique ('U') system-named indexes are re-emitted (they
          // carry a table's UNIQUE constraint) but get a deterministic name
          // below so they don't collide with the PK's system name (SQL0601N).
          `SELECT INDSCHEMA, INDNAME, TABNAME, UNIQUERULE FROM SYSCAT.INDEXES WHERE TABSCHEMA = ? ORDER BY TABNAME`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2IndexColumnRaw>(
          this.provider, conn,
          `SELECT IC.INDNAME, IC.COLNAME, IC.COLORDER, IC.COLSEQ 
           FROM SYSCAT.INDEXCOLUSE IC
           JOIN SYSCAT.INDEXES I ON IC.INDNAME = I.INDNAME AND IC.INDSCHEMA = I.INDSCHEMA
           WHERE I.TABSCHEMA = ? 
           ORDER BY IC.INDNAME, IC.COLSEQ`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2ViewRaw>(
          this.provider, conn,
          `SELECT VIEWSCHEMA, VIEWNAME, TEXT FROM SYSCAT.VIEWS WHERE VIEWSCHEMA = ?`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2TriggerRaw>(
          this.provider, conn,
          `SELECT TRIGSCHEMA, TRIGNAME, TABNAME, TRIGTIME, TRIGEVENT, TEXT FROM SYSCAT.TRIGGERS WHERE TABSCHEMA = ? ORDER BY TABNAME, TRIGNAME`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2ProcedureRaw>(
          this.provider, conn,
          // ORIGIN 'E'/'Q' = user external / SQL routines; excludes system-generated,
          // sourced (the <, =, cast functions DB2 creates for user-defined types), and built-ins
          `SELECT ROUTINESCHEMA, ROUTINENAME, ROUTINETYPE, FUNCTIONTYPE, TEXT FROM SYSCAT.ROUTINES WHERE ROUTINESCHEMA = ? AND ORIGIN IN ('E', 'Q')`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2SequenceRaw>(
          this.provider, conn,
          `SELECT S.SEQSCHEMA, S.SEQNAME, D.TYPENAME, S.START, S.INCREMENT, S.MINVALUE, S.MAXVALUE, S.CYCLE, S.CACHE
           FROM SYSCAT.SEQUENCES S
           LEFT JOIN SYSCAT.DATATYPES D ON S.DATATYPEID = D.TYPEID
           WHERE S.SEQSCHEMA = ? AND S.SEQTYPE = 'S'
           ORDER BY S.SEQNAME`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2UserTypeRaw>(
          this.provider, conn,
          `SELECT TYPESCHEMA, TYPENAME, SOURCENAME, METATYPE, LENGTH, SCALE
           FROM SYSCAT.DATATYPES
           WHERE TYPESCHEMA = ? AND METATYPE IN ('T', 'R', 'S')
           ORDER BY TYPENAME`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2AttributeRaw>(
          this.provider, conn,
          `SELECT TYPESCHEMA, TYPENAME, ATTR_NAME, ATTR_TYPENAME, LENGTH, SCALE, ORDINAL
           FROM SYSCAT.ATTRIBUTES
           WHERE TYPESCHEMA = ?
           ORDER BY TYPENAME, ORDINAL`,
          [schemaName]
        ),
        ConnectionFactory.executeOnConnection<Db2RoutineParmRaw>(
          this.provider, conn,
          // Parameters (and the table-function result columns, ROWTYPE='C') of
          // user routines, ordered for a faithful signature.
          `SELECT ROUTINENAME, PARMNAME, TYPENAME, LENGTH, SCALE, ROWTYPE, ORDINAL
           FROM SYSCAT.ROUTINEPARMS
           WHERE ROUTINESCHEMA = ?
           ORDER BY ROUTINENAME, ORDINAL`,
          [schemaName]
        ),
        // Roles are database-global (not schema-scoped).
        //
        // `SYS%` is excluded because those are DB2's own built-in roles
        // (SYSDEBUG, SYSTS_ADM, SYSGEOADM, …). They exist in every database,
        // belong to nobody, and cannot be recreated — DB2 reserves the SYS
        // prefix and answers `CREATE ROLE SYSDEBUG` with SQL0707N. Reporting
        // them put six phantom objects in every DB2 comparison and put eleven
        // statements that can never succeed into the migration.
        ConnectionFactory.executeOnConnection<Db2RoleRaw>(
          this.provider, conn,
          `SELECT ROLENAME FROM SYSCAT.ROLES WHERE ROLENAME NOT LIKE 'SYS%' ORDER BY ROLENAME`,
          []
        ),
        ConnectionFactory.executeOnConnection<Db2RoleAuthRaw>(
          this.provider, conn,
          `SELECT ROLENAME, GRANTEE, GRANTEETYPE FROM SYSCAT.ROLEAUTH
           WHERE ROLENAME NOT LIKE 'SYS%' ORDER BY ROLENAME, GRANTEE`,
          []
        )
      ]);

      // Initialize the target schema properties as arrays matching Record<string, T[]>
      const tables: Record<string, DbTable> = {};
      const columns: Record<string, DbColumn[]> = {};
      const functions: Record<string, DbProcedure[]> = {};
      const procedures: Record<string, DbProcedure[]> = {};
      const triggers: Record<string, DbTrigger[]> = {};
      const sequences: Record<string, DbSequence[]> = {};
      const primaryKeys: Record<string, DbPrimaryKey[]> = {};
      const foreignKeys: Record<string, DbForeignKey[]> = {};
      const uniqueConstraints: Record<string, DbUniqueConstraint[]> = {};
      const indexes: Record<string, DbIndex[]> = {};
      const indexColumns: Record<string, DbIndexColumn[]> = {};
      const views: Record<string, DbView[]> = {};
      // 1. Initialize Tables Map
      for (const t of rawTables) {
        tables[t.TABNAME] = {
          name: t.TABNAME,
          columns: {},
          primaryKey: [],
          foreignKeys: [],
          uniqueConstraints: [],
          indexes: [],
          tablespace: t.TBSPACE?.trim() || undefined,
          isMqt: t.TYPE === 'S'
        };
        // Setup initial container keys for the root lists
        columns[t.TABNAME] = [];
        primaryKeys[t.TABNAME] = [];
        foreignKeys[t.TABNAME] = [];
        uniqueConstraints[t.TABNAME] = [];
        indexes[t.TABNAME] = [];
      }

      // 2. Process Columns
      for (const col of rawColumns) {
        const mappedColumn: DbColumn = {
          name: col.COLNAME,
          type: col.TYPENAME,
          length: col.LENGTH,
          scale: col.SCALE,
          nullable: col.NULLS === 'Y',
          defaultValue: col.DEFAULT ?? undefined,
          identity: col.IDENTITY === 'Y',
          // GENERATED: 'A' = ALWAYS, 'D' = BY DEFAULT
          identityGeneration: col.IDENTITY === 'Y' ? (col.GENERATED === 'D' ? 'BY DEFAULT' : 'ALWAYS') : undefined
        };

        if (tables[col.TABNAME]) {
          tables[col.TABNAME].columns[col.COLNAME] = mappedColumn;
        }
        if (!columns[col.TABNAME]) columns[col.TABNAME] = [];
        columns[col.TABNAME].push(mappedColumn);
      }

      // 3. Process Primary Keys
      for (const pk of rawPrimaryKeys) {
        const mappedPk: DbPrimaryKey = {
          name: pk.COLNAME,
          constName: pk.CONSTNAME,
          column: pk.COLNAME,
          colSeq: pk.COLSEQ
        };

        if (tables[pk.TABNAME]) {
          tables[pk.TABNAME].primaryKey.push(pk.COLNAME);
        }
        if (!primaryKeys[pk.TABNAME]) primaryKeys[pk.TABNAME] = [];
        primaryKeys[pk.TABNAME].push(mappedPk);
      }

      // 4. Process Foreign Keys
      const tempFkGroups = new Map<
        string,
        { table: string; cols: string[]; refCols: string[]; rSchema: string; rTable: string }
      >();
      for (const fk of rawForeignKeys) {
        if (!tempFkGroups.has(fk.CONSTNAME)) {
          tempFkGroups.set(fk.CONSTNAME, {
            table: fk.TABNAME,
            cols: [],
            refCols: [],
            rSchema: fk.REFTABSCHEMA,
            rTable: fk.REFTABNAME,
          });
        }
        const g = tempFkGroups.get(fk.CONSTNAME)!;
        g.cols.push(fk.COLNAME);
        g.refCols.push(fk.REFCOLNAME);
      }

      for (const [constName, info] of tempFkGroups.entries()) {
        const mappedFk: DbForeignKey = {
          name: constName,
          columns: info.cols,
          referencedSchema: info.rSchema,
          referencedTable: info.rTable,
          referencedColumns: info.refCols,
        };

        if (tables[info.table]) {
          tables[info.table].foreignKeys.push(mappedFk);
        }
        if (!foreignKeys[info.table]) foreignKeys[info.table] = [];
        foreignKeys[info.table].push(mappedFk);
      }

      // 5. Process Unique Constraints
      for (const uc of rawUniqueConstraints) {
        const mappedUc: DbUniqueConstraint = {
          name: uc.CONSTNAME,
          columns: []
        };

        if (tables[uc.TABNAME]) {
          tables[uc.TABNAME].uniqueConstraints.push(mappedUc);
        }
        if (!uniqueConstraints[uc.TABNAME]) uniqueConstraints[uc.TABNAME] = [];
        uniqueConstraints[uc.TABNAME].push(mappedUc);
      }

      // 6. Process Index Columns
      for (const col of rawIndexColumns) {
        if (!indexColumns[col.INDNAME]) indexColumns[col.INDNAME] = [];
        indexColumns[col.INDNAME].push({
          name: col.INDNAME,
          colName: col.COLNAME,
          colOrder: col.COLORDER,
          colSeq: col.COLSEQ
        });
      }

      // 7. Process Indexes
      for (const idx of rawIndexes) {
        const relatedCols = indexColumns[idx.INDNAME]?.map(c => c.colName) || [];
        // DB2 names the index backing a UNIQUE constraint with a system-generated
        // "SQL<timestamp>" — non-portable and, worse, it can equal the PK's own
        // system name, so re-emitting `CREATE UNIQUE INDEX SQL... ` collides with
        // the PK backing index on the target (SQL0601N). Give it a deterministic,
        // per-(table,columns) name instead.
        const name = /^SQL\d+$/i.test(idx.INDNAME)
          ? `${idx.TABNAME}_${relatedCols.join('_')}_IDX`.toUpperCase()
          : idx.INDNAME;
        const mappedIdx: DbIndex = {
          name,
          uniqueRule: idx.UNIQUERULE,
          columns: relatedCols
        };

        if (tables[idx.TABNAME]) {
          tables[idx.TABNAME].indexes.push(mappedIdx);
        }
        if (!indexes[idx.TABNAME]) indexes[idx.TABNAME] = [];
        indexes[idx.TABNAME].push(mappedIdx);
      }
      for (const vw of rawViews) {
        // View columns come through SYSCAT.COLUMNS (collected in `columns` above).
        const viewColumns: Record<string, DbColumn> = {};
        for (const c of columns[vw.VIEWNAME] ?? []) viewColumns[c.name] = c;
        // SYSCAT.VIEWS.TEXT is the full "CREATE VIEW <schema>.<name> AS SELECT ..."
        // statement. Store only the SELECT body so the generator can re-emit it via
        // CREATE OR REPLACE VIEW with the target schema — otherwise the wrapped
        // result is "CREATE OR REPLACE VIEW n AS CREATE VIEW ..." (SQL0104N).
        // Identifiers may be bare (UPPER) or quoted; a leading comment can precede CREATE.
        // eslint-disable-next-line security/detect-unsafe-regex -- anchored at ^; bounded comment/whitespace runs and identifier alternatives
        const VIEW_CREATE_RE = /^(?:\s*--[^\n]*\n)*\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:(?:"[^"]*"|\w+)\s*\.\s*)?(?:"[^"]*"|\w+)\s+AS\s+/i;
        const mappedView: DbView = {
          name: vw.VIEWNAME,
          schema: vw.VIEWSCHEMA,
          definition: String(vw.TEXT ?? '').replace(VIEW_CREATE_RE, '').trim(),
          columns: viewColumns,
          indexes: []
        };
        if (!views[vw.VIEWNAME]) views[vw.VIEWNAME] = [];
        views[vw.VIEWNAME].push(mappedView);
      }

      // 8. Process Triggers
      const trigTimings: Record<string, string> = { B: 'BEFORE', A: 'AFTER', I: 'INSTEAD OF' };
      const trigEvents: Record<string, string> = { I: 'INSERT', U: 'UPDATE', D: 'DELETE', M: 'MULTIPLE' };
      for (const trg of rawTriggers) {
        const mappedTrigger: DbTrigger = {
          name: trg.TRIGNAME,
          schema: trg.TRIGSCHEMA,
          tableName: trg.TABNAME,
          event: trigEvents[trg.TRIGEVENT] ?? trg.TRIGEVENT,
          timing: trigTimings[trg.TRIGTIME] ?? trg.TRIGTIME,
          definition: trg.TEXT
        };
        if (!triggers[trg.TRIGNAME]) triggers[trg.TRIGNAME] = [];
        triggers[trg.TRIGNAME].push(mappedTrigger);
      }

      // 9. Process Procedures & Functions
      // Group routine parameters (and table-function result columns) by name.
      const parmMode = (rt: string): RoutineParameterMode =>
        rt === 'O' ? 'OUT' : rt === 'B' ? 'INOUT' : rt === 'C' ? 'RESULT' : rt === 'R' ? 'RETURN' : 'IN';
      const routineParms: Record<string, RoutineParameter[]> = {};
      for (const p of rawRoutineParms) {
        (routineParms[p.ROUTINENAME] ??= []).push({
          name: p.PARMNAME ?? '',
          type: this.formatType({ type: p.TYPENAME, length: p.LENGTH, scale: p.SCALE }),
          mode: parmMode(p.ROWTYPE),
          ordinal: p.ORDINAL,
        });
      }
      // Stable signature order: input/output params first (by position), then
      // table-function result columns, then the scalar return. Same-named params
      // with different modes are kept (e.g. a table function's input + result col).
      const parmRank = (m: RoutineParameterMode) => (m === 'RESULT' ? 1 : m === 'RETURN' ? 2 : 0);
      for (const list of Object.values(routineParms)) {
        list.sort((a, b) => parmRank(a.mode) - parmRank(b.mode) || (a.ordinal ?? 0) - (b.ordinal ?? 0));
      }

      for (const proc of rawProcedures) {
        const mappedRoutine: DbProcedure = {
          name: proc.ROUTINENAME,
          schema: proc.ROUTINESCHEMA,
          routineType: proc.ROUTINETYPE === 'P' ? 'PROCEDURE' : 'FUNCTION',
          definition: proc.TEXT ?? undefined,
          functionType: proc.FUNCTIONTYPE ?? undefined,
          parameters: routineParms[proc.ROUTINENAME] ?? [],
        };

        if (proc.ROUTINETYPE === 'P') {
          if (!procedures[proc.ROUTINENAME]) procedures[proc.ROUTINENAME] = [];
          procedures[proc.ROUTINENAME].push(mappedRoutine);
        } else {
          if (!functions[proc.ROUTINENAME]) functions[proc.ROUTINENAME] = [];
          functions[proc.ROUTINENAME].push(mappedRoutine);
        }
      }

      // 10. Process Sequences
      const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v).trim());
      for (const seq of rawSequences) {
        const mappedSeq: DbSequence = {
          name: seq.SEQNAME,
          schema: seq.SEQSCHEMA,
          dataType: seq.TYPENAME?.trim(),
          startValue: str(seq.START),
          increment: str(seq.INCREMENT),
          minValue: str(seq.MINVALUE),
          maxValue: str(seq.MAXVALUE),
          cycle: seq.CYCLE === 'Y',
          cache: seq.CACHE
        };

        if (!sequences[seq.SEQNAME]) sequences[seq.SEQNAME] = [];
        sequences[seq.SEQNAME].push(mappedSeq);
      }

      // 11. Process User-Defined Types and their attributes (structured types)
      const attrsByType = new Map<string, { name: string; type: string }[]>();
      for (const a of rawAttributes) {
        const len = a.LENGTH && a.LENGTH > 0 ? `(${a.LENGTH}${a.SCALE ? `,${a.SCALE}` : ''})` : '';
        const list = attrsByType.get(a.TYPENAME) ?? [];
        list.push({ name: a.ATTR_NAME, type: `${a.ATTR_TYPENAME?.trim()}${len}` });
        attrsByType.set(a.TYPENAME, list);
      }

      const userTypes: Record<string, DbUserType[]> = {};
      for (const ut of rawUserTypes) {
        const mappedType: DbUserType = {
          name: ut.TYPENAME,
          schema: ut.TYPESCHEMA,
          sourceType: ut.SOURCENAME?.trim(),
          metaType: ut.METATYPE?.trim(),
          attributes: attrsByType.get(ut.TYPENAME)
        };
        if (!userTypes[ut.TYPENAME]) userTypes[ut.TYPENAME] = [];
        userTypes[ut.TYPENAME].push(mappedType);
      }

      // Roles + their grantees (members). Database-global, not schema-scoped.
      const granteeTypeLabel = (gt: string) =>
        gt === 'U' ? 'USER' : gt === 'G' ? 'GROUP' : gt === 'R' ? 'ROLE' : gt;
      const roleMembers: Record<string, { grantee: string; granteeType: string }[]> = {};
      for (const ra of rawRoleAuths) {
        (roleMembers[ra.ROLENAME] ??= []).push({ grantee: ra.GRANTEE.trim(), granteeType: granteeTypeLabel(ra.GRANTEETYPE) });
      }
      const roles: DbRole[] = rawRoles.map((r) => ({ name: r.ROLENAME.trim(), members: roleMembers[r.ROLENAME] ?? [] }));

      return {
        tables,
        columns,
        functions,
        procedures,
        triggers,
        sequences,
        userTypes,
        primaryKeys,
        foreignKeys,
        uniqueConstraints,
        indexes,
        indexColumns,
        views,
        roles
      };

    } finally {
      await ConnectionFactory.close(this.provider, conn);
    }
  }
}