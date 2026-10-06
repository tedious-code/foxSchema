#!/usr/bin/env bash
# FoxSchema — manually re-seed demo data into running containers.
# Useful after a schema change without doing a full volume reset.
#
# Normal workflow: docker compose down -v && docker compose up -d
# (init scripts in docker/init/ auto-seed on first start)
#
# This script is for re-seeding without a volume wipe.
# Usage: bash scripts/seed/seed-all.sh [postgres|mysql|mariadb|sqlserver|oracle|db2|sqlite]

set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
INIT="$REPO/docker/init"

SL_DIR=/tmp/foxschema-sqlite

# `set -e` does not apply inside a function called on the left of `||`, which is
# exactly how the `all` target invokes these. A failing docker exec therefore
# did not abort the seeder: it ran on to the unconditional "✓ done" and returned
# 0, so a dialect whose container was not even running still reported success.
# Every step now goes through `step`, which returns non-zero on the first
# failure, and each seeder starts by proving its container exists.
step() {
  "$@" || return 1
}

require_container() {
  if ! docker inspect "$1" >/dev/null 2>&1; then
    echo "  ✗ container $1 is not running"
    return 1
  fi
}

seed_postgres() {
  echo "▶ PostgreSQL …"
  require_container foxschema-postgres || return 1
  step docker exec -i foxschema-postgres psql -U foxuser -d foxdb \
    < "$INIT/postgres/01_seed.sql" || return 1
  echo "  ✓ done"
}

seed_mysql() {
  echo "▶ MySQL …"
  require_container foxschema-mysql || return 1
  step docker exec -i foxschema-mysql mysql -uroot -pfoxrootpass \
    < "$INIT/mysql/01_seed.sql" || return 1
  echo "  ✓ done"
}

seed_mariadb() {
  echo "▶ MariaDB …"
  require_container foxschema-mariadb || return 1
  step docker exec -i foxschema-mariadb mariadb -uroot -pfoxrootpass \
    < "$INIT/mariadb/01_seed.sql" || return 1
  echo "  ✓ done"
}

seed_sqlserver() {
  echo "▶ SQL Server …"
  # Prefer /tmp — bind-mounted /docker-init is empty when the Docker daemon
  # cannot see the agent workspace filesystem (common in remote DOCKER_HOST).
  require_container foxschema-sqlserver || return 1
  step docker cp "$INIT/sqlserver/01_seed.sql" foxschema-sqlserver:/tmp/01_seed.sql || return 1
  step docker exec -i foxschema-sqlserver \
    /opt/mssql-tools18/bin/sqlcmd -S localhost -U SA -P 'FoxPass123!' \
    -i /tmp/01_seed.sql -No -C || return 1
  echo "  ✓ done"
}

seed_oracle() {
  echo "▶ Oracle …"
  require_container foxschema-oracle || return 1
  step docker exec -i foxschema-oracle \
    sqlplus -S "system/FoxPass123@//localhost:1521/FREEPDB1" \
    < "$INIT/oracle/02_seed.sql" || return 1
  # The V_$ grants need SYSDBA — `system` cannot grant on SYS views (ORA-01031),
  # and sqlplus walks past that silently, which is how they went missing.
  step docker exec -i foxschema-oracle \
    sqlplus -S "/ as sysdba" \
    < "$INIT/oracle/03_vviews_sysdba.sql" || return 1
  echo "  ✓ done"
}

seed_db2() {
  echo "▶ DB2 …"
  # docker cp into /tmp — bind mounts under /var/custom* are empty when the
  # Docker daemon cannot see the agent workspace filesystem.
  # db2's CLP -f flag needs an actual filesystem path, not stdin.
  require_container foxschema-db2 || return 1
  step docker cp "$INIT/db2/01_seed.sql" foxschema-db2:/tmp/01_seed.sql || return 1
  # Not a bare `connect && -tvf`: bash execs the last command of -c, so the
  # second db2 got a new CLP back end with no connection (SQL1024N on every
  # statement). Anything after it keeps one back end. CLP exits 1-2 for
  # "no rows" and warnings, 4+ for errors.
  step docker exec foxschema-db2 \
    su - db2inst1 -c "db2 connect to foxdb && db2 -tvf /tmp/01_seed.sql -z /tmp/foxschema_seed.log; rc=\$?; db2 terminate >/dev/null; [ \$rc -lt 4 ]" || return 1
  echo "  ✓ done"
}

seed_sqlite() {
  echo "▶ SQLite …"
  mkdir -p "$SL_DIR" || return 1
  rm -f "$SL_DIR/demo_a.db" "$SL_DIR/demo_b.db"
  # The sqlite3 CLI is not always installed; better-sqlite3 always is (it is a
  # dependency of the app), so fall back to it rather than fail the seed.
  if command -v sqlite3 >/dev/null 2>&1; then
    step sqlite3 "$SL_DIR/demo_a.db" < "$INIT/sqlite/demo_a.sql" || return 1
    step sqlite3 "$SL_DIR/demo_b.db" < "$INIT/sqlite/demo_b.sql" || return 1
  else
    step node -e '
      const Database = require(require.resolve("better-sqlite3", { paths: [process.argv[1]] }));
      const fs = require("fs");
      for (const [db, sql] of [[process.argv[2], process.argv[3]], [process.argv[4], process.argv[5]]]) {
        const conn = new Database(db);
        conn.exec(fs.readFileSync(sql, "utf8"));
        conn.close();
      }' "$REPO/packages/db" \
      "$SL_DIR/demo_a.db" "$INIT/sqlite/demo_a.sql" \
      "$SL_DIR/demo_b.db" "$INIT/sqlite/demo_b.sql" || return 1
  fi
  echo "  ✓ done  →  $SL_DIR/demo_a.db  |  demo_b.db"
}

seed_cockroachdb() {
  echo "▶ CockroachDB …"
  # No auto-init; exec `cockroach sql`. Uses the trigger-free seed variant.
  require_container foxschema-cockroachdb || return 1
  step docker exec foxschema-cockroachdb cockroach sql --insecure \
    -e "CREATE DATABASE IF NOT EXISTS foxdb" || return 1
  step docker exec -i foxschema-cockroachdb cockroach sql --insecure --database=foxdb \
    < "$INIT/cockroachdb/01_seed.sql" || return 1
  echo "  ✓ done"
}

seed_yugabytedb() {
  echo "▶ YugabyteDB …"
  # YSQL binds the node address, so connect via the container's own IP. Reuses
  # the Postgres seed (YSQL is Postgres-compatible, triggers included).
  require_container foxschema-yugabytedb || return 1
  local ip
  ip=$(docker exec foxschema-yugabytedb hostname -i | awk '{print $1}') || return 1
  docker exec foxschema-yugabytedb bin/ysqlsh -h "$ip" -p 5433 -U yugabyte \
    -c "CREATE DATABASE foxdb" 2>/dev/null || true
  step docker exec -i foxschema-yugabytedb bin/ysqlsh -h "$ip" -p 5433 -U yugabyte -d foxdb \
    < "$INIT/postgres/01_seed.sql" || return 1
  echo "  ✓ done"
}

seed_clickhouse() {
  echo "▶ ClickHouse …"
  require_container foxschema-clickhouse || return 1
  step docker exec -i foxschema-clickhouse \
    clickhouse-client --user default --password foxpass --multiquery \
    < "$INIT/clickhouse/01_seed.sql" || return 1
  echo "  ✓ done"
}

seed_tidb() {
  echo "▶ TiDB …"
  require_container foxschema-tidb || return 1
  # TiDB image has no mysql client — use a one-shot mysql:8 client on host net.
  if command -v mysql >/dev/null 2>&1; then
    step mysql -h127.0.0.1 -P4000 -uroot --protocol=TCP \
      < "$INIT/tidb/01_seed.sql" || return 1
  else
    step docker run --rm -i --network host mysql:8 \
      mysql -h127.0.0.1 -P4000 -uroot --protocol=TCP \
      < "$INIT/tidb/01_seed.sql" || return 1
  fi
  echo "  ✓ done"
}

seed_redshift() {
  echo "▶ Redshift (local Postgres stand-in) …"
  require_container foxschema-redshift || return 1
  step docker exec -i foxschema-redshift psql -U foxuser -d foxdb \
    < "$INIT/postgres/01_seed.sql" || return 1
  echo "  ✓ done"
}

seed_duckdb() {
  echo "▶ DuckDB …"
  step node "$REPO/scripts/seed/seed-duckdb.mjs" || return 1
}

TARGET="${1:-all}"
case "$TARGET" in
  postgres)    seed_postgres ;;
  mysql)       seed_mysql ;;
  mariadb)     seed_mariadb ;;
  sqlserver)   seed_sqlserver ;;
  oracle)      seed_oracle ;;
  db2)         seed_db2 ;;
  sqlite)      seed_sqlite ;;
  cockroachdb) seed_cockroachdb ;;
  yugabytedb)  seed_yugabytedb ;;
  clickhouse)  seed_clickhouse ;;
  tidb)        seed_tidb ;;
  redshift)    seed_redshift ;;
  duckdb)      seed_duckdb ;;
  all)
    # Continue past a failing dialect on purpose — not every machine runs all
    # containers — but keep a list, because a wall of output makes a single "✗"
    # easy to miss and reseeding is the control that stops stale data producing
    # convincing-but-fake E2E failures.
    FAILED=()
    seed_postgres    || FAILED+=("PostgreSQL")
    seed_mysql       || FAILED+=("MySQL")
    seed_mariadb     || FAILED+=("MariaDB")
    seed_sqlserver   || FAILED+=("SQL Server")
    seed_oracle      || FAILED+=("Oracle")
    seed_db2         || FAILED+=("DB2")
    seed_sqlite      || FAILED+=("SQLite")
    seed_cockroachdb || FAILED+=("CockroachDB")
    seed_yugabytedb  || FAILED+=("YugabyteDB")
    seed_clickhouse  || FAILED+=("ClickHouse")
    seed_tidb        || FAILED+=("TiDB")
    seed_redshift    || FAILED+=("Redshift")
    seed_duckdb      || FAILED+=("DuckDB")
    echo ""
    if [ ${#FAILED[@]} -eq 0 ]; then
      echo "  ✓ all dialects seeded"
    else
      echo "  ✗ NOT seeded (${#FAILED[@]}): ${FAILED[*]}"
      echo "    Compare/migrate against these will run on stale or missing data."
    fi
    ;;
  *)
    echo "Unknown target: $TARGET"
    echo "Usage: $0 [postgres|mysql|mariadb|sqlserver|oracle|db2|sqlite|cockroachdb|yugabytedb|clickhouse|tidb|redshift|duckdb|all]"
    exit 1
    ;;
esac

DD_DIR=/tmp/foxschema-duckdb
echo ""
echo "Connection reference:"
echo "  PostgreSQL  localhost:5432  foxuser/foxpass      db=foxdb     schema=demo_a vs demo_b"
echo "  MySQL       localhost:3306  foxuser/foxpass      db=demo_a vs demo_b"
echo "  MariaDB     localhost:3307  foxuser/foxpass      db=demo_a vs demo_b"
echo "  SQL Server  localhost:1433  SA/FoxPass123!       db=foxdb     schema=demo_a vs demo_b"
echo "  Oracle      localhost:1521  demo_a/foxpass       service=FREEPDB1 vs user=demo_b/foxpass"
echo "  DB2         localhost:50000 db2inst1/foxpass     db=foxdb     schema=DEMO_A vs DEMO_B"
echo "  SQLite      $SL_DIR/demo_a.db  vs  demo_b.db"
echo "  CockroachDB localhost:26257 root (insecure)      db=foxdb     schema=demo_a vs demo_b"
echo "  YugabyteDB  localhost:5433  yugabyte (no pass)   db=foxdb     schema=demo_a vs demo_b"
echo "  ClickHouse  localhost:8123  default/foxpass      db=demo_a vs demo_b"
echo "  TiDB        localhost:4000  foxuser/foxpass       db=demo_a vs demo_b"
echo "  Redshift*   localhost:5439  foxuser/foxpass      db=foxdb     schema=demo_a vs demo_b"
echo "  DuckDB      $DD_DIR/demo_a.duckdb  vs  demo_b.duckdb"
echo "  * Redshift service is a local Postgres stand-in for e2e (not Amazon Redshift)."
