import { describe, it, expect } from 'vitest';
import {
  dialectSupportsIndexFragmentation,
  buildIndexDefragSql,
  indexMaintenanceVerb,
} from './index-fragmentation';

/**
 * The Index Management panel must not offer a maintenance button an engine
 * cannot honour.
 *
 * CockroachDB rejects REINDEX ("unimplemented: this syntax", and its own hint
 * says it does not require reindexing); YugabyteDB answers "REINDEX not
 * supported yet". With `defrag` off but the button still rendered, clicking it
 * failed with "No defragment SQL available for the selection" — which reads as
 * the feature being broken rather than as the engine having nothing to run.
 *
 * `defrag` is the single flag the UI gates on, so these two have to agree:
 * a dialect that advertises defrag must produce a statement, and one that does
 * not must produce none.
 */
const ALL = [
  'postgres', 'mysql', 'mariadb', 'sqlserver', 'azuresql', 'oracle', 'db2',
  'sqlite', 'duckdb', 'clickhouse', 'tidb', 'redshift', 'cockroachdb', 'yugabytedb',
] as const;

describe('index maintenance availability', () => {
  it.each(ALL)('%s: the defrag flag and the generated SQL agree', (dialect) => {
    const supported = dialectSupportsIndexFragmentation(dialect).defrag;
    const stmts = buildIndexDefragSql({
      dialect,
      schema: 'demo_a',
      table: 'orders',
      indexName: 'idx_orders_customer',
      fragmentationPercent: 42,
    }).filter((s) => !s.trim().startsWith('--'));

    // Either it promises maintenance and produces some, or it promises none.
    expect(stmts.length > 0).toBe(supported);
  });

  it.each(['cockroachdb', 'yugabytedb'])('%s advertises no maintenance', (dialect) => {
    expect(dialectSupportsIndexFragmentation(dialect).defrag).toBe(false);
    // …while still listing indexes, which is why the panel stays useful.
    expect(dialectSupportsIndexFragmentation(dialect).query).toBe(true);
  });

  it('every dialect that does offer maintenance names it in the engine’s own word', () => {
    for (const dialect of ALL) {
      if (!dialectSupportsIndexFragmentation(dialect).defrag) continue;
      const verb = indexMaintenanceVerb(dialect);
      expect(verb).toMatch(/^(Reindex|Optimize|Reorg|Rebuild)$/);
    }
  });
});
