import { describe, expect, it } from 'vitest';
import {
  buildIndexDefragSql,
  indexMaintenanceVerb,
  buildIndexDropSql,
  buildIndexFragmentationCustomTemplate,
  buildIndexFragmentationQuery,
  buildIndexUsageQueries,
  dialectSupportsIndexFragmentation,
  fragmentationSeverity,
  isSafeIndexFragmentationCustomSql,
  mergeIndexUsageRows,
  normalizeIndexFragmentationRows,
  normalizeIndexLastUsed,
  splitSchemaTable,
} from './index-fragmentation.js';

describe('dialectSupportsIndexFragmentation', () => {
  it('marks SQL Server as physical with query + defrag', () => {
    expect(dialectSupportsIndexFragmentation('sqlserver')).toMatchObject({
      mode: 'physical',
      query: true,
      defrag: true,
    });
    expect(dialectSupportsIndexFragmentation('azuresql').mode).toBe('physical');
  });

  it('enables a probe for every registered dialect', () => {
    for (const d of [
      'sqlserver',
      'azuresql',
      'postgres',
      'cockroachdb',
      'yugabytedb',
      'mysql',
      'mariadb',
      'tidb',
      'db2',
      'oracle',
      'sqlite',
      'duckdb',
      'clickhouse',
      'redshift',
    ]) {
      const s = dialectSupportsIndexFragmentation(d);
      expect(s.query, d).toBe(true);
      expect(s.mode, d).not.toBe('unsupported');
      expect(s.customSqlHint, d).toMatch(/index_name/i);
      expect(s.customSqlHint, d).toMatch(/last_used/i);
    }
  });
});

describe('splitSchemaTable', () => {
  it('splits qualified names and applies default schema', () => {
    expect(splitSchemaTable('dbo.Orders')).toEqual({ schema: 'dbo', table: 'Orders' });
    expect(splitSchemaTable('"public"."users"')).toEqual({ schema: 'public', table: 'users' });
    expect(splitSchemaTable('users', 'public')).toEqual({ schema: 'public', table: 'users' });
  });
});

describe('buildIndexFragmentationQuery', () => {
  it('builds SQL Server OBJECT_ID probe', () => {
    const q = buildIndexFragmentationQuery({
      dialect: 'sqlserver',
      schema: 'dbo',
      table: 'Orders',
    });
    expect('error' in q).toBe(false);
    if ('error' in q) return;
    expect(q.mode).toBe('physical');
    expect(q.params).toEqual(['dbo.Orders']);
    expect(q.sql).toMatch(/dm_db_index_physical_stats/i);
    // `?` here was the bug: the mssql adapter binds named @pN, so the server
    // received a literal ? and rejected it.
    expect(q.sql).toMatch(/OBJECT_ID\(@p0\)/);
    expect(q.sql).toMatch(/dm_db_index_usage_stats/i);
    expect(q.sql).toMatch(/last_used/i);
    expect(q.sql).toMatch(/scan_count/i);
  });

  it('asks pgstatindex for leaf_fragmentation, not pgstattuple', () => {
    /**
     * The bug this pins, verified against PostgreSQL 17:
     *
     *   SELECT leaf_fragmentation FROM pgstattuple('i'::regclass::oid)
     *     ERROR: column "leaf_fragmentation" does not exist
     *   SELECT leaf_fragmentation FROM pgstatindex('i')
     *     0
     *
     * `pgstattuple` reports *table* statistics. Naming it here failed twice
     * over: without the extension Postgres says the function does not exist —
     * which is what users hit — and installing the extension, the obvious fix,
     * then failed on the missing column. The probe could never have worked.
     */
    const q = buildIndexFragmentationQuery({
      dialect: 'postgres',
      table: 'public.users',
    });
    expect('error' in q).toBe(false);
    if ('error' in q) return;
    expect(q.params).toEqual(['public', 'users']);
    expect(q.sql).toMatch(/pgstatindex\(/);
    expect(q.sql).not.toMatch(/FROM pgstattuple\(/);
    expect(q.sql).toMatch(/pg_stat_user_indexes/);
    expect(q.sql).toMatch(/idx_scan/);
    expect(q.sql).toMatch(/NULL::timestamptz AS last_used/);
  });

  it('does not let an unmeasured index reach the grid as NaN', () => {
    // pgstatindex returns NaN for an index with no leaf pages yet. That is
    // "nothing measured", not a number, and "NaN%" in a column reads as a bug.
    const q = buildIndexFragmentationQuery({ dialect: 'postgres', table: 'public.users' });
    if ('error' in q) throw new Error(q.error);
    expect(q.sql).toMatch(/NULLIF\(/);
    expect(q.sql).toMatch(/'NaN'::float8/);
  });

  it('builds probes for formerly unsupported dialects', () => {
    const sqlite = buildIndexFragmentationQuery({ dialect: 'sqlite', table: 'orders' });
    expect('error' in sqlite).toBe(false);
    if (!('error' in sqlite)) {
      expect(sqlite.mode).toBe('estimated');
      expect(sqlite.sql).toMatch(/sqlite_master/i);
      expect(sqlite.params).toEqual(['orders']);
    }

    const duck = buildIndexFragmentationQuery({
      dialect: 'duckdb',
      schema: 'main',
      table: 't',
    });
    expect('error' in duck).toBe(false);
    if (!('error' in duck)) {
      expect(duck.sql).toMatch(/duckdb_indexes/i);
      expect(duck.params).toEqual(['t', 'main']);
    }

    const ch = buildIndexFragmentationQuery({
      dialect: 'clickhouse',
      schema: 'default',
      table: 'events',
    });
    expect('error' in ch).toBe(false);
    if (!('error' in ch)) {
      expect(ch.sql).toMatch(/data_skipping_indices/i);
    }

    const rs = buildIndexFragmentationQuery({ dialect: 'redshift', table: 'fact' });
    expect('error' in rs).toBe(false);
    if (!('error' in rs)) {
      expect(rs.sql).toMatch(/WHERE 1 = 0/i);
    }
  });

  it('requires schema for MySQL and DB2', () => {
    expect(buildIndexFragmentationQuery({ dialect: 'mysql', table: 't' })).toEqual({
      error: 'MySQL-family fragmentation probe needs a schema (database) name.',
    });
    expect(buildIndexFragmentationQuery({ dialect: 'db2', table: 'T' })).toEqual({
      error: 'DB2 fragmentation probe needs a schema name.',
    });
  });

  it('includes LASTUSED on the DB2 probe', () => {
    const db2 = buildIndexFragmentationQuery({
      dialect: 'db2',
      schema: 'DB2INST1',
      table: 'ORDERS',
    });
    expect('error' in db2).toBe(false);
    if (!('error' in db2)) {
      expect(db2.sql).toMatch(/LASTUSED/);
      expect(db2.sql).toMatch(/last_used/i);
    }
  });
});

describe('buildIndexUsageQueries', () => {
  it('does not extra-query SQL Server or DB2 (usage is on the main probe)', () => {
    expect(
      buildIndexUsageQueries({ dialect: 'sqlserver', schema: 'dbo', table: 'Orders' })
    ).toEqual([]);
    expect(
      buildIndexUsageQueries({ dialect: 'db2', schema: 'DB2INST1', table: 'ORDERS' })
    ).toEqual([]);
    expect(buildIndexUsageQueries({ dialect: 'sqlite', table: 'orders' })).toEqual([]);
  });

  it('probes Oracle DBA_INDEX_USAGE then object-usage fallbacks', () => {
    const qs = buildIndexUsageQueries({
      dialect: 'oracle',
      schema: 'HR',
      table: 'EMPLOYEES',
    });
    expect(qs).toHaveLength(3);
    expect(qs[0]?.sql).toMatch(/DBA_INDEX_USAGE/);
    expect(qs[0]?.sql).toMatch(/LAST_USED/);
    expect(qs[0]?.sql).toMatch(/TOTAL_ACCESS_COUNT/);
    expect(qs[0]?.params).toEqual(['HR', 'EMPLOYEES']);
    expect(qs[1]?.sql).toMatch(/DBA_OBJECT_USAGE/);
    expect(qs[2]?.sql).toMatch(/V\$OBJECT_USAGE/);
  });

  it('probes MySQL performance_schema, MariaDB INDEX_STATISTICS, TiDB TIDB_INDEX_USAGE', () => {
    const mysql = buildIndexUsageQueries({ dialect: 'mysql', schema: 'app', table: 'users' });
    expect(mysql[0]?.sql).toMatch(/table_io_waits_summary_by_index_usage/i);
    expect(mysql[0]?.sql).toMatch(/COUNT_READ/);

    const maria = buildIndexUsageQueries({ dialect: 'mariadb', schema: 'app', table: 'users' });
    expect(maria.map((q) => q.sql).join('\n')).toMatch(/INDEX_STATISTICS/);

    const tidb = buildIndexUsageQueries({ dialect: 'tidb', schema: 'app', table: 'users' });
    expect(tidb[0]?.sql).toMatch(/CLUSTER_TIDB_INDEX_USAGE/);
    expect(tidb[1]?.sql).toMatch(/TIDB_INDEX_USAGE/);
    expect(tidb[1]?.sql).toMatch(/LAST_ACCESS_TIME/);
    expect(tidb[1]?.sql).toMatch(/QUERY_TOTAL/);
  });

  it('overlays last_idx_scan for the Postgres family', () => {
    const qs = buildIndexUsageQueries({
      dialect: 'postgres',
      schema: 'public',
      table: 'orders',
    });
    expect(qs[0]?.sql).toMatch(/last_idx_scan/);
    expect(qs[0]?.params).toEqual(['public', 'orders']);
  });
});

describe('mergeIndexUsageRows', () => {
  it('fills missing lastUsed / scanCount without clobbering existing values', () => {
    expect(
      mergeIndexUsageRows(
        [
          {
            indexName: 'IX_A',
            fragmentationPercent: 10,
            pageCount: 2,
            lastUsed: '2024-01-01T00:00:00.000Z',
            scanCount: 5,
          },
          {
            indexName: 'ix_b',
            fragmentationPercent: 1,
            pageCount: null,
            lastUsed: null,
            scanCount: null,
          },
        ],
        [
          {
            indexName: 'ix_a',
            fragmentationPercent: null,
            lastUsed: '2025-01-01T00:00:00.000Z',
            scanCount: 99,
          },
          {
            indexName: 'IX_B',
            fragmentationPercent: null,
            lastUsed: '2024-06-01T00:00:00.000Z',
            scanCount: 3,
          },
        ]
      )
    ).toEqual([
      {
        indexName: 'IX_A',
        fragmentationPercent: 10,
        pageCount: 2,
        lastUsed: '2024-01-01T00:00:00.000Z',
        scanCount: 5,
      },
      {
        indexName: 'ix_b',
        fragmentationPercent: 1,
        pageCount: null,
        lastUsed: '2024-06-01T00:00:00.000Z',
        scanCount: 3,
      },
    ]);
  });
});

describe('normalizeIndexFragmentationRows', () => {
  it('accepts mixed casings and clamps percents', () => {
    expect(
      normalizeIndexFragmentationRows([
        { INDEX_NAME: 'ix1', Fragmentation_Percent: 12.5, PAGE_COUNT: 9 },
        { index_name: 'ix2', avg_fragmentation_in_percent: 150 },
        { name: '', fragmentation_percent: 1 },
      ])
    ).toEqual([
      {
        indexName: 'ix1',
        fragmentationPercent: 12.5,
        pageCount: 9,
        lastUsed: null,
        scanCount: null,
      },
      {
        indexName: 'ix2',
        fragmentationPercent: 100,
        pageCount: null,
        lastUsed: null,
        scanCount: null,
      },
    ]);
  });

  it('normalizes last_used timestamps and scan_count (any casing)', () => {
    expect(
      normalizeIndexFragmentationRows([
        {
          index_name: 'ix_used',
          fragmentation_percent: 1,
          LAST_USED: '2024-06-15T12:00:00.000Z',
          Scan_Count: 42,
        },
        {
          index_name: 'ix_never',
          fragmentation_percent: 0,
          lastused: '0001-01-01',
          idx_scan: 0,
        },
      ])
    ).toEqual([
      {
        indexName: 'ix_used',
        fragmentationPercent: 1,
        pageCount: null,
        lastUsed: '2024-06-15T12:00:00.000Z',
        scanCount: 42,
      },
      {
        indexName: 'ix_never',
        fragmentationPercent: 0,
        pageCount: null,
        lastUsed: null,
        scanCount: 0,
      },
    ]);
  });

  it('accepts TiDB LAST_ACCESS_TIME / QUERY_TOTAL aliases', () => {
    expect(
      normalizeIndexFragmentationRows([
        {
          index_name: 'idx_tidb',
          LAST_ACCESS_TIME: '2024-07-01T00:00:00.000Z',
          QUERY_TOTAL: 7,
        },
      ])
    ).toEqual([
      {
        indexName: 'idx_tidb',
        fragmentationPercent: null,
        pageCount: null,
        lastUsed: '2024-07-01T00:00:00.000Z',
        scanCount: 7,
      },
    ]);
  });
});

describe('normalizeIndexLastUsed', () => {
  it('treats DB2 never-used dates as null', () => {
    expect(normalizeIndexLastUsed('0001-01-01')).toBeNull();
    expect(normalizeIndexLastUsed(new Date('0001-01-01T00:00:00Z'))).toBeNull();
    expect(normalizeIndexLastUsed(null)).toBeNull();
  });

  it('keeps real timestamps as ISO', () => {
    expect(normalizeIndexLastUsed('2024-03-01T08:30:00.000Z')).toBe('2024-03-01T08:30:00.000Z');
  });
});

describe('fragmentationSeverity / defrag SQL', () => {
  it('bands severity', () => {
    expect(fragmentationSeverity(null)).toBe('unknown');
    expect(fragmentationSeverity(5)).toBe('ok');
    expect(fragmentationSeverity(15)).toBe('warn');
    expect(fragmentationSeverity(40)).toBe('critical');
  });

  it('suggests REORGANIZE vs REBUILD on SQL Server', () => {
    expect(
      buildIndexDefragSql({
        dialect: 'sqlserver',
        schema: 'dbo',
        table: 'Orders',
        indexName: 'IX_A',
        fragmentationPercent: 12,
      })
    ).toEqual(['ALTER INDEX [IX_A] ON [dbo].[Orders] REORGANIZE;']);
    expect(
      buildIndexDefragSql({
        dialect: 'sqlserver',
        schema: 'dbo',
        table: 'Orders',
        indexName: 'IX_A',
        fragmentationPercent: 40,
      })
    ).toEqual(['ALTER INDEX [IX_A] ON [dbo].[Orders] REBUILD;']);
  });

  it('suggests OPTIMIZE TABLE on MySQL', () => {
    expect(
      buildIndexDefragSql({
        dialect: 'mysql',
        schema: 'app',
        table: 'users',
        indexName: 'ix_email',
      })
    ).toEqual(['OPTIMIZE TABLE `app`.`users`;']);
  });

  it('suggests REINDEX on SQLite and OPTIMIZE on ClickHouse', () => {
    expect(
      buildIndexDefragSql({
        dialect: 'sqlite',
        table: 'orders',
        indexName: 'ix_orders_customer',
      })
    ).toEqual(['REINDEX "ix_orders_customer";', '-- Or whole DB: VACUUM;']);
    expect(
      buildIndexDefragSql({
        dialect: 'clickhouse',
        schema: 'default',
        table: 'events',
        indexName: 'idx_ts',
      })
    ).toEqual(['OPTIMIZE TABLE `default`.`events` FINAL;']);
  });
});

describe('buildIndexDropSql', () => {
  it('quotes DROP INDEX per major dialect', () => {
    expect(
      buildIndexDropSql({
        dialect: 'postgres',
        schema: 'public',
        table: 'orders',
        indexName: 'ix_orders_customer',
      })
    ).toEqual(['DROP INDEX IF EXISTS "public"."ix_orders_customer";']);
    expect(
      buildIndexDropSql({
        dialect: 'mysql',
        schema: 'app',
        table: 'users',
        indexName: 'ix_email',
      })
    ).toEqual(['DROP INDEX `ix_email` ON `app`.`users`;']);
    expect(
      buildIndexDropSql({
        dialect: 'sqlserver',
        schema: 'dbo',
        table: 'Orders',
        indexName: 'IX_A',
      })
    ).toEqual(['DROP INDEX [IX_A] ON [dbo].[Orders];']);
    expect(
      buildIndexDropSql({
        dialect: 'db2',
        schema: 'DB2INST1',
        table: 'ORDERS',
        indexName: 'IX_CUSTOMER',
      })
    ).toEqual(['DROP INDEX "DB2INST1"."IX_CUSTOMER";']);
    expect(
      buildIndexDropSql({
        dialect: 'sqlite',
        table: 'orders',
        indexName: 'ix_orders_customer',
      })
    ).toEqual(['DROP INDEX IF EXISTS "ix_orders_customer";']);
    expect(
      buildIndexDropSql({
        dialect: 'oracle',
        schema: 'HR',
        table: 'EMPLOYEES',
        indexName: 'IX_EMP_EMAIL',
      })
    ).toEqual(['DROP INDEX "HR"."IX_EMP_EMAIL";']);
    expect(
      buildIndexDropSql({
        dialect: 'mariadb',
        schema: 'app',
        table: 'users',
        indexName: 'ix_email',
      })
    ).toEqual(['DROP INDEX `ix_email` ON `app`.`users`;']);
    expect(
      buildIndexDropSql({
        dialect: 'duckdb',
        schema: 'main',
        table: 't',
        indexName: 'ix_t',
      })
    ).toEqual(['DROP INDEX IF EXISTS "main"."ix_t";']);
    expect(
      buildIndexDropSql({
        dialect: 'clickhouse',
        schema: 'default',
        table: 'events',
        indexName: 'idx_ts',
      })
    ).toEqual(['ALTER TABLE `default`.`events` DROP INDEX `idx_ts`;']);
  });

  it('refuses constraint-backed indexes and Redshift', () => {
    expect(
      buildIndexDropSql({
        dialect: 'sqlserver',
        schema: 'dbo',
        table: 'Orders',
        indexName: 'PK_Orders',
        constraint: true,
      })
    ).toEqual([]);
    expect(
      buildIndexDropSql({
        dialect: 'redshift',
        schema: 'public',
        table: 'fact',
        indexName: 'ix_x',
      })
    ).toEqual([]);
  });
});

describe('custom SQL safety', () => {
  it('allows SELECT / WITH and rejects writes / multi-statements', () => {
    expect(isSafeIndexFragmentationCustomSql('SELECT 1 AS index_name, 0 AS fragmentation_percent')).toBe(
      true
    );
    expect(isSafeIndexFragmentationCustomSql('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isSafeIndexFragmentationCustomSql('DELETE FROM t')).toMatch(/SELECT/i);
    expect(
      isSafeIndexFragmentationCustomSql('SELECT 1; DROP TABLE t')
    ).toMatch(/single statement/i);
  });

  it('rejects data-modifying CTEs that still end in SELECT', () => {
    expect(
      isSafeIndexFragmentationCustomSql(
        `WITH wiped AS (
          DELETE FROM orders
          RETURNING 'idx'::text AS index_name, 0::float AS fragmentation_percent
        )
        SELECT * FROM wiped`
      )
    ).toMatch(/read-only/i);
  });

  it('reads a comment marker inside a string as text, so it cannot hide a write', () => {
    // The database ignores only the trailing `-- */`; it creates the table or
    // writes the file. Stripping `/* … */` before looking hid the INTO.
    expect(isSafeIndexFragmentationCustomSql("SELECT '/*', 1 INTO fox_probe FROM t -- */", 'postgres')).toMatch(
      /read-only/i
    );
    expect(
      isSafeIndexFragmentationCustomSql("SELECT '/*' AS a INTO OUTFILE '/tmp/fox' FROM t -- */", 'mysql')
    ).toMatch(/read-only/i);
    expect(isSafeIndexFragmentationCustomSql('SELECT 1 INTO fox_probe FROM t', 'sqlserver')).toMatch(/read-only/i);
  });

  it('runs what a fenced block hides: fence lines are only comments to the database', () => {
    expect(
      isSafeIndexFragmentationCustomSql('SELECT 1 AS index_name FROM t\n-- @node\nINTO fox_probe\n-- @end', 'postgres')
    ).toMatch(/read-only/i);
  });

  it('counts statements as the dialect splits them', () => {
    // A `;` inside a string is not a separator…
    expect(isSafeIndexFragmentationCustomSql("SELECT ';' AS index_name, 0 AS fragmentation_percent", 'postgres')).toBe(
      true
    );
    // …and a trailing one is not a second statement.
    expect(isSafeIndexFragmentationCustomSql('SELECT 1 AS index_name;', 'postgres')).toBe(true);
    // MySQL reads `\'` as an escaped quote, so the string ends later and the
    // `;` falls between two statements there.
    expect(isSafeIndexFragmentationCustomSql("SELECT 'a\\'; DELETE FROM t; -- '", 'mysql')).toMatch(
      /single statement/i
    );
  });

  it('accepts the template it offers for every dialect', () => {
    for (const d of ['sqlserver', 'azuresql', 'postgres', 'cockroachdb', 'yugabytedb', 'mysql', 'mariadb', 'tidb', 'db2', 'oracle', 'sqlite', 'duckdb', 'clickhouse', 'redshift']) {
      const template = buildIndexFragmentationCustomTemplate({ dialect: d, schema: 'public', table: 'orders' });
      expect(isSafeIndexFragmentationCustomSql(template, d), d).toBe(true);
    }
  });

  it('keeps the leading comment block the custom templates start with', () => {
    expect(
      isSafeIndexFragmentationCustomSql('-- Custom probe\n/* edit the WHERE */\nSELECT 1 AS index_name, 0 AS fragmentation_percent', 'postgres')
    ).toBe(true);
  });

  it('builds a non-empty custom template per major dialect', () => {
    for (const d of [
      'sqlserver',
      'postgres',
      'mysql',
      'db2',
      'oracle',
      'sqlite',
      'duckdb',
      'clickhouse',
      'redshift',
    ]) {
      expect(buildIndexFragmentationCustomTemplate({ dialect: d, schema: 's', table: 't' })).toMatch(
        /index_name/i
      );
    }
  });
});

describe('indexMaintenanceVerb', () => {
  /**
   * "Defragment" is SQL Server's word, and the button said it on every engine
   * while the SQL underneath was already dialect-correct. The label should be
   * the verb the reader would have typed themselves.
   */
  it.each([
    ['postgres', 'Reindex'],
    ['cockroachdb', 'Reindex'],
    ['yugabytedb', 'Reindex'],
    ['sqlite', 'Reindex'],
    ['mysql', 'Optimize'],
    ['mariadb', 'Optimize'],
    ['tidb', 'Optimize'],
    ['db2', 'Reorg'],
    ['sqlserver', 'Rebuild'],
    ['azuresql', 'Rebuild'],
    ['oracle', 'Rebuild'],
  ])('%s says %s', (dialect, verb) => {
    expect(indexMaintenanceVerb(dialect)).toBe(verb);
  });

  it('matches the statement the engine is actually sent', () => {
    // The label and the SQL must not drift apart — that is the whole point.
    const sqlFor = (dialect: string) =>
      buildIndexDefragSql({ dialect, schema: 'app', table: 'orders', indexName: 'idx_a' }).join(' ');
    expect(sqlFor('postgres')).toMatch(/REINDEX/i);
    expect(sqlFor('mysql')).toMatch(/OPTIMIZE/i);
    expect(sqlFor('db2')).toMatch(/REORG/i);
    expect(sqlFor('oracle')).toMatch(/REBUILD/i);
  });

  it('is case-insensitive and falls back rather than throwing', () => {
    expect(indexMaintenanceVerb('POSTGRES')).toBe('Reindex');
    expect(indexMaintenanceVerb('')).toBe('Rebuild');
    expect(indexMaintenanceVerb('something-new')).toBe('Rebuild');
  });
});

describe('placeholder style matches each driver', () => {
  /**
   * SQL Server shipped `OBJECT_ID(?)` while its adapter binds named `@p0`
   * parameters (`sqlserver.adapter.ts`), so the server received a literal `?`
   * and answered "Incorrect syntax near '?'". Index Management was dead on
   * SQL Server. Every dialect's placeholder has to match its own driver.
   */
  const built = (dialect: string, schema: string | undefined, table: string) => {
    const q = buildIndexFragmentationQuery({ dialect, schema, table });
    if ('error' in q) throw new Error(`${dialect}: ${q.error}`);
    return q;
  };

  it('sqlserver and azuresql use named @pN, never a bare ?', () => {
    for (const d of ['sqlserver', 'azuresql']) {
      const q = built(d, 'dbo', 'orders');
      expect(q.sql).toContain('OBJECT_ID(@p0)');
      // A stray ? would be sent verbatim and fail at parse time.
      expect(q.sql).not.toMatch(/\?/);
      expect(q.params).toEqual(['dbo.orders']);
    }
  });

  it('postgres family uses $1/$2', () => {
    for (const d of ['postgres', 'cockroachdb', 'yugabytedb']) {
      const q = built(d, 'app', 'orders');
      expect(q.sql).toContain('$1');
      expect(q.sql).toContain('$2');
      expect(q.sql).not.toMatch(/\?/);
      expect(q.params).toEqual(['app', 'orders']);
    }
  });

  it('oracle uses :1/:2', () => {
    const q = built('oracle', 'app', 'orders');
    expect(q.sql).toContain(':1');
    expect(q.sql).toContain(':2');
    expect(q.sql).not.toMatch(/\?/);
  });

  it('clickhouse uses $N — its adapter substitutes those, not ?', () => {
    // This test previously asserted `?` for ClickHouse, which was an
    // assumption, not a checked fact: the adapter replaces $1/$2 and a bare
    // `?` reaches the server unbound ("Syntax error ... failed at position").
    const q = built('clickhouse', 'app', 'orders');
    expect(q.sql).toContain('$1');
    expect(q.sql).toContain('$2');
    expect(q.sql).not.toMatch(/\?/);
  });

  it('drivers that take positional ? get exactly one per param', () => {
    for (const [d, schema, table] of [
      ['mysql', 'app', 'orders'],
      ['mariadb', 'app', 'orders'],
      ['db2', 'app', 'orders'],
      ['sqlite', undefined, 'orders'],
    ] as const) {
      const q = built(d, schema, table);
      expect(q.sql.match(/\?/g) ?? []).toHaveLength(q.params.length);
      // and none of the named/numbered styles leaked in
      expect(q.sql).not.toMatch(/@p\d|\$\d|:\d/);
    }
  });
});

describe('postgres fallback when pgstattuple is missing', () => {
  /**
   * `pgstatindex` lives in the pgstattuple extension, which most servers do
   * not install — the probe then fails outright and the panel shows nothing.
   * Index list, size, and usage need only the core catalogs, so a second probe
   * keeps the panel useful instead of dead.
   */
  const pg = (dialect: string) => {
    const q = buildIndexFragmentationQuery({ dialect, schema: 'app', table: 'orders' });
    if ('error' in q) throw new Error(q.error);
    return q;
  };

  it('postgres carries a fallback — it is the only one that tries pgstatindex', () => {
    const q = pg('postgres');
    expect(q.fallback).toBeDefined();
    expect(q.fallback!.sql).not.toMatch(/pgstatindex|pgstattuple/i);
    expect(q.fallback!.params).toEqual(q.params);
    expect(q.fallback!.mode).toBe('estimated');
    expect(q.fallback!.warning).toMatch(/pgstattuple/i);
  });

  it.each(['cockroachdb', 'yugabytedb'])(
    '%s needs no fallback: its primary probe already avoids the extension',
    (d) => {
      const q = pg(d);
      expect(q.fallback).toBeUndefined();
      expect(q.sql).not.toMatch(/pgstatindex/);
    }
  );

  it('the primary probe is still the one that uses pgstatindex', () => {
    expect(pg('postgres').sql).toMatch(/pgstatindex/);
  });

  it('the fallback returns the same column set, so normalisation is unchanged', () => {
    const cols = ['index_name', 'fragmentation_percent', 'page_count', 'last_used', 'scan_count'];
    for (const c of cols) expect(pg('postgres').fallback!.sql).toContain(c);
  });

  it('the fallback reports no fragmentation rather than a made-up number', () => {
    expect(pg('postgres').fallback!.sql).toMatch(/NULL::float8 AS fragmentation_percent/);
  });

  it('dialects with no optional-extension problem carry no fallback', () => {
    for (const d of ['sqlserver', 'mysql', 'oracle', 'db2', 'sqlite']) {
      const q = buildIndexFragmentationQuery({ dialect: d, schema: 'app', table: 'orders' });
      if ('error' in q) continue;
      expect(q.fallback).toBeUndefined();
    }
  });
});

describe('defrag statements the engines actually accept', () => {
  /**
   * Every case below was run against a live server; the comments record what
   * the engine said when the previous statement was wrong. Generation being
   * plausible is not the same as the engine accepting it — none of these
   * failures were visible from unit tests alone.
   */
  const defrag = (dialect: string, schema: string | undefined, table: string, index: string) =>
    buildIndexDefragSql({ dialect, schema, table, indexName: index, fragmentationPercent: 42 });

  it('Db2 goes through ADMIN_CMD and reorgs the whole table', () => {
    // `REORG INDEX <name>` → SQL0270N "Function not supported (Reason code 89)":
    // Db2 has no single-index REORG. And REORG is a command, not SQL, so over a
    // driver connection it must be wrapped in SYSPROC.ADMIN_CMD (otherwise
    // SQL0104N, "expected tokens may include: JOIN").
    const [stmt, stats, note] = defrag('db2', 'DEMO_A', 'ORDERS', 'IDX_ORDERS_CUST');
    expect(stmt).toBe(
      `CALL SYSPROC.ADMIN_CMD('REORG INDEXES ALL FOR TABLE "DEMO_A"."ORDERS"');`
    );
    // The % on screen is SYSCAT.INDEXES. REORG leaves it stale; RUNSTATS is
    // what makes a refresh show the result.
    expect(stats).toBe(
      `CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE "DEMO_A"."ORDERS" AND INDEXES ALL');`
    );
    // The reader has to know one index was not the unit of work.
    expect(note).toMatch(/no single-index REORG/i);
  });

  it('Db2 folds a typed schema to the uppercase name the catalog stores', () => {
    // Live server: quoting the typed case (`"demo_a"."ORDERS"`, `"App"."ORDERS"`)
    // returns SQL2211N. The probe had already found the table as DEMO_A / APP.
    const [lower] = defrag('db2', 'demo_a', 'orders', 'IDX');
    expect(lower).toBe(
      `CALL SYSPROC.ADMIN_CMD('REORG INDEXES ALL FOR TABLE "DEMO_A"."ORDERS"');`
    );
    const [mixedSchema] = defrag('db2', 'App', 'ORDERS', 'IDX');
    expect(mixedSchema).toBe(
      `CALL SYSPROC.ADMIN_CMD('REORG INDEXES ALL FOR TABLE "APP"."ORDERS"');`
    );
    // A mixed-case table name is a delimited identifier from SYSCAT.
    const [mixed] = defrag('db2', 'DEMO_A', 'MyTable', 'IDX');
    expect(mixed).toContain('"DEMO_A"."MyTable"');
  });

  it('Db2 doubles a quote inside the ADMIN_CMD literal', () => {
    // The table name sits inside a string literal; an unescaped quote would
    // end it early and change the command.
    const [stmt] = defrag('db2', `IT'S`, 'ORDERS', 'IDX');
    const literal = stmt.slice(stmt.indexOf("('") + 2, stmt.lastIndexOf("')"));
    expect(literal).not.toMatch(/(^|[^'])'([^']|$)/);
  });

  it('TiDB analyses instead of optimising', () => {
    // "OPTIMIZE TABLE is not supported" — TiDB compacts storage itself.
    expect(defrag('tidb', 'demo_a', 'orders', 'idx')).toEqual([
      'ANALYZE TABLE `demo_a`.`orders`;',
    ]);
    // MySQL/MariaDB keep OPTIMIZE, which they do accept.
    expect(defrag('mysql', 'demo_a', 'orders', 'idx')).toEqual([
      'OPTIMIZE TABLE `demo_a`.`orders`;',
    ]);
  });

  it.each([
    // CockroachDB: "unimplemented: this syntax" + "does not require reindexing".
    'cockroachdb',
    // YugabyteDB: "REINDEX not supported yet", in every form.
    'yugabytedb',
  ])('%s offers nothing rather than SQL that always errors', (dialect) => {
    expect(defrag(dialect, 'demo_a', 'orders', 'idx')).toEqual([]);
    expect(dialectSupportsIndexFragmentation(dialect).defrag).toBe(false);
    // …but they can still list indexes, which is why query stays on.
    expect(dialectSupportsIndexFragmentation(dialect).query).toBe(true);
  });

  it('the Postgres family probe survives a non-public search_path', () => {
    // The connection sets search_path to the schema under inspection, so an
    // unqualified pgstatindex resolved for nobody except users in public.
    const q = buildIndexFragmentationQuery({ dialect: 'postgres', schema: 'app', table: 'orders' });
    if ('error' in q) throw new Error(q.error);
    expect(q.sql).toContain('public.pgstatindex');
  });

  it.each(['cockroachdb', 'yugabytedb'])(
    '%s never calls pgstatindex — it cannot answer it',
    (dialect) => {
      const q = buildIndexFragmentationQuery({ dialect, schema: 'app', table: 'orders' });
      if ('error' in q) throw new Error(q.error);
      // Cockroach has no pgstattuple; Yugabyte's indexes are LSM, so the call
      // dies with "is not a btree index" — which does not name the function,
      // so the missing-extension fallback would not have caught it either.
      expect(q.sql).not.toMatch(/pgstatindex/);
      expect(q.sql).toContain('relpages');
    }
  );

  it('ClickHouse casts through Nullable so the probe can return unknowns', () => {
    // "Cannot convert NULL to a non-nullable type" — ClickHouse types are
    // non-nullable by default.
    const q = buildIndexFragmentationQuery({ dialect: 'clickhouse', schema: 'demo_a', table: 'orders' });
    if ('error' in q) throw new Error(q.error);
    expect(q.sql).toMatch(/Nullable\(Float64\)/);
    expect(q.sql).not.toMatch(/CAST\(NULL AS (Float64|UInt64|DateTime)\)/);
  });
});
