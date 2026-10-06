import { SqlGeneratorModule } from '@/shared/lib/sql-generator';
import { formatSql, loadSqlFormatter } from '@/shared/utils/formatSql';
import type { DbObjectType, TableSchema } from '@/shared/lib/types';

/** Objects that open their source script in the editor (no edit form in this version). */
export const SCRIPTABLE_OBJECT_TYPES = new Set<DbObjectType>(['VIEW', 'PROCEDURE', 'FUNCTION']);

const ddlGenerator = new SqlGeneratorModule();
const FORMAT_SQL_MAX = 50_000;

export function isScriptableObject(type: DbObjectType): boolean {
  return SCRIPTABLE_OBJECT_TYPES.has(type);
}

/**
 * Source script for VIEW / PROCEDURE / FUNCTION — view-only (no edit form).
 * Formatted when sql-formatter loads; the raw definition if it cannot.
 */
export async function objectSourceScript(table: TableSchema, dialect: string): Promise<string> {
  let ddl = ddlGenerator.generateObjectDdl(table, dialect).trim();
  if (!ddl) {
    return `-- No definition available for ${table.objectType} ${table.name}\n`;
  }
  if (ddl.length <= FORMAT_SQL_MAX) {
    try {
      await loadSqlFormatter();
      ddl = formatSql(ddl, dialect).trim() || ddl;
    } catch {
      /* keep raw definition */
    }
  }
  return ddl.endsWith(';') ? `${ddl}\n` : `${ddl};\n`;
}
