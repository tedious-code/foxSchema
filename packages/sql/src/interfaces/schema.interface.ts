export type DbObjectType = 'TABLE' | 'MQT' | 'VIEW' | 'FUNCTION' | 'PROCEDURE' | 'TRIGGER' | 'SEQUENCE' | 'TYPE' | 'ROLE';

export interface SequenceInfo {
  dataType?: string;
  start?: string;
  increment?: string;
  minValue?: string;
  maxValue?: string;
  cycle?: boolean;
  cache?: number;
}

export interface TypeAttributeInfo {
  name: string;
  type: string;
}

export interface UserTypeInfo {
  /** Underlying built-in type a DISTINCT/user-defined type maps to. */
  sourceType?: string;
  metaType?: string;
  attributes?: TypeAttributeInfo[];
}

export interface PrimaryKeyInfo {
  name?: string;
  columns: string[];
}

export interface TriggerInfo {
  name: string;
  timing?: string;
  event?: string;
  definition?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
  primaryKey: boolean;
  identity?: boolean;
  identityGeneration?: string;
  /**
   * Explicit column-level collation, only for collatable (character) types and
   * only when the provider's catalog exposes one. Left undefined for
   * non-character types, and for dialects with no true per-column collation
   * (DB2) or when the value is the dialect's own "no explicit collation, use
   * the session/database default" placeholder (e.g. Oracle's USING_NLS_COMP).
   */
  collation?: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  /**
   * True when this index backs a UNIQUE constraint rather than being a standalone
   * index. SQL Server forbids DROP INDEX / CREATE INDEX on these — they must be
   * dropped/created via ALTER TABLE DROP/ADD CONSTRAINT. Set by providers that can
   * tell the two apart (e.g. SQL Server `sys.indexes.is_unique_constraint`).
   */
  constraint?: boolean;
  /**
   * Partial / filtered index predicate without the WHERE keyword (when known).
   * Not all providers populate this yet.
   */
  filter?: string;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedTable: string;
  /**
   * Parent schema / owner / database when the catalog reports one.
   * Cross-schema FKs must keep this — Data Peek / result FK drill build
   * `SELECT … FROM schema.table`, and dropping it resolves a bare name in the
   * connection schema (wrong table when the same name exists there).
   */
  referencedSchema?: string;
  /** Parent key columns in constraint order. Always present after normalizeTableSchemas. */
  referencedColumns: string[];
}

export type RoutineParameterMode = 'IN' | 'OUT' | 'INOUT' | 'RETURN' | 'RESULT';

export interface RoutineParameter {
  name: string;
  type: string;
  mode: RoutineParameterMode;
  ordinal?: number;
}

export interface TableSchema {
  name: string;
  objectType: DbObjectType;
  definition?: string;
  columns: ColumnInfo[];
  indices: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  primaryKey?: PrimaryKeyInfo;
  triggers?: TriggerInfo[];
  sequence?: SequenceInfo;
  userType?: UserTypeInfo;
  /** Present when objectType === 'FUNCTION' | 'PROCEDURE'. */
  parameters?: RoutineParameter[];
  /** Present when objectType === 'FUNCTION': scalar vs table-valued. */
  functionKind?: 'scalar' | 'table'; 
  /** Storage tablespace (tables/MQTs). */
  tablespace?: string;
  /**
   * What a non-SQL store keeps behind this "table" — for Redis `hash`, `json`,
   * `string`, `mixed`, `list`, `set`, `zset` or `stream`. Shown as a badge;
   * absent for SQL engines.
   */
  storeType?: string;
}

export interface DbRoleMember { grantee: string; granteeType: string; }
export interface DbRole { name: string; members: DbRoleMember[]; }

export interface DbSchema {
  tables: Record<string, DbTable>;
  roles?: DbRole[];
  columns: Record<string, DbColumn[]>;
  functions: Record<string, DbProcedure[]>; 
  procedures: Record<string, DbProcedure[]>;
  triggers: Record<string, DbTrigger[]>;
  sequences: Record<string, DbSequence[]>;
  userTypes: Record<string, DbUserType[]>;
  primaryKeys: Record<string, DbPrimaryKey[]>;
  foreignKeys: Record<string, DbForeignKey[]>;
  views: Record<string, DbView[]>;
  uniqueConstraints: Record<string, DbUniqueConstraint[]>;
  indexes: Record<string, DbIndex[]>;
  indexColumns: Record<string, DbIndexColumn[]>;
}

export interface DbTable {
  name: string;
  columns: Record<string, DbColumn>;
  primaryKey: string[];
  foreignKeys: DbForeignKey[];
  uniqueConstraints: DbUniqueConstraint[];
  indexes: DbIndex[];
  tablespace?: string;
  isMqt?: boolean;
  /** Materialized view's backing query (Postgres matviews). Undefined for plain tables and for dialects that don't expose it (e.g. DB2 MQTs). */
  definition?: string;
  /** See `TableSchema.storeType`. */
  storeType?: string;
}

export interface DbColumn { name: string; type: string; length?: number; scale?: number; nullable: boolean; defaultValue?: string; identity?: boolean; identityGeneration?: string; collation?: string; }
export interface DbForeignKey {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  /**
   * Parent key columns in constraint order (1:1 with `columns`).
   * Optional for upgrade compat: older catalog loads / serialized shapes may omit it;
   * `resolveFkReferencedColumns` / `normalizeTableSchemas` fill from the parent PK.
   */
  referencedColumns?: string[];
}
export interface DbPrimaryKey { name: string; constName: string; column: string; colSeq: number; }
export interface DbUniqueConstraint { name: string; columns: string[]; }
export interface DbIndex { name: string; uniqueRule: string; columns: string[]; constraint?: boolean; }
export interface DbIndexColumn { name: string; colName: string; colOrder: 'A' | 'D'; colSeq: number; }
export interface DbView { name: string; schema: string; definition: string; columns: Record<string, DbColumn>; indexes: DbIndex[]; }
export interface DbTrigger { name: string; schema: string; tableName: string; event: string; timing: string; definition: string; }
export interface DbProcedure { name: string; schema: string; routineType: string; specificName?: string; definition?: string; functionType?: string; parameters?: RoutineParameter[]; }
export interface DbSequence { name: string; schema: string; dataType?: string; startValue?: string; increment?: string; minValue?: string; maxValue?: string; cycle?: boolean; cache?: number; }
export interface DbUserType { name: string; schema: string; sourceType?: string; metaType?: string; attributes?: { name: string; type: string }[]; }