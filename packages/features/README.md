# @foxschema/features

Fox Schema's product features, built on the [`@foxschema/sql`](../sql) dialect engine:

| Module | What it covers |
| --- | --- |
| `access` | Permission intent, effective access, GRANT/REVOKE and account DDL |
| `utilities` | DBA queries, index fragmentation, backup/restore commands, SQL Tracer, safe column change |
| `lokee-weave` | Content-addressed schema versioning and revert |
| `sql-editor` | FoxScript parsing, code cells, SELECT aliasing, column origins |
| `command-mode` | Per-engine CLI command builders |
| `capabilities` | Which feature each engine supports, and why not |

Per-dialect SQL for these features lives in `src/providers/<dialect>/<dialect>.<concern>.ts`
(`user-sql`, `access-sql`, `column-change`, `dba-utilities`, `backup`, …).
The dialect definitions themselves (`*.sql-dialect.ts`, `*.settings.ts`) stay in `@foxschema/sql`.

Like `@foxschema/sql` it is pure: no Node built-ins, no drivers, and its only
dependency is `@foxschema/sql` (`src/purity.test.ts`). Import `@foxschema/sql`
by its barrel only, never a deep path.

The package is private for now and built to be publishable later.
