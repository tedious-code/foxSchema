#!/usr/bin/env bash
# FoxSchema — full reset: bring up every dialect container, wait for them to
# actually be healthy, restart the local dev server (releases pooled DB
# connections that can block Oracle/DB2 DROP USER on reseed), then truncate +
# reseed every dialect via seed-all.sh.
#
# This exists because running `bash scripts/seed/seed-all.sh all` against a
# container that's still starting, or while the dev server holds a pooled
# connection open, produces confusing partial failures that look like app
# bugs but are actually environment races — burned real debugging time on
# both of these more than once. See "False leads" in
# docs/plans/2026-07-01-migration-ordering-bugs.md.
#
# Usage:
#   bash scripts/seed/reset-all.sh                  # full reset (default)
#   bash scripts/seed/reset-all.sh --no-restart-dev  # skip the dev-server bounce
#   bash scripts/seed/reset-all.sh --no-up           # don't touch docker compose,
#                                                     # just wait+reseed what's running
#
# Safe to re-run any time — every step here is idempotent (docker compose up
# is a no-op for already-running containers; each dialect's seed script does
# its own DROP+CREATE before reseeding).

set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEV_LOG="/tmp/foxschema-dev-server.log"

RESTART_DEV=1
DO_UP=1
for arg in "$@"; do
  case "$arg" in
    --no-restart-dev) RESTART_DEV=0 ;;
    --no-up) DO_UP=0 ;;
    *) echo "Unknown flag: $arg"; echo "Usage: $0 [--no-restart-dev] [--no-up]"; exit 1 ;;
  esac
done

bar() { printf -- '─%.0s' $(seq 1 60); echo; }

# ── 1. Bring up containers ───────────────────────────────────────────────────
if [ "$DO_UP" = "1" ]; then
  bar
  echo "  docker compose up -d"
  bar
  cd "$REPO" && docker compose up -d
fi

# ── 2. Wait for every dialect container to report healthy ───────────────────
# Names must match container_name: in docker-compose.yml.
CONTAINERS="foxschema-postgres foxschema-mysql foxschema-mariadb foxschema-sqlserver foxschema-oracle foxschema-db2 foxschema-cockroachdb foxschema-yugabytedb foxschema-clickhouse foxschema-tidb foxschema-redshift foxschema-redis foxschema-mongodb"
TIMEOUT_SECS=600
ELAPSED=0

bar
echo "  Waiting for containers to become healthy (timeout ${TIMEOUT_SECS}s)"
bar

while true; do
  ALL_HEALTHY=1
  STATUS_LINE=""
  for c in $CONTAINERS; do
    if ! docker inspect "$c" >/dev/null 2>&1; then
      STATUS_LINE="$STATUS_LINE $c=absent"
      ALL_HEALTHY=0
      continue
    fi
    s=$(docker inspect --format '{{.State.Health.Status}}' "$c" 2>/dev/null || echo "no-healthcheck")
    STATUS_LINE="$STATUS_LINE $c=$s"
    if [ "$s" != "healthy" ]; then ALL_HEALTHY=0; fi
  done
  echo "  [${ELAPSED}s]$STATUS_LINE"
  if [ "$ALL_HEALTHY" = "1" ]; then
    echo "  ✓ all containers healthy"
    break
  fi
  if [ "$ELAPSED" -ge "$TIMEOUT_SECS" ]; then
    echo "  ✗ timed out waiting for containers — continuing anyway; seed-all.sh"
    echo "    will report per-dialect failures for anything still unhealthy."
    break
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
done

# ── 3. Restart the local dev server ──────────────────────────────────────────
# A long-lived backend holds pooled connections open. Oracle's DROP USER
# CASCADE (and DB2's equivalent) silently no-ops on "user has an active
# session" — the seed script proceeds straight into CREATE USER against a
# schema that was never actually dropped. Bouncing the backend releases those
# pools before we reseed.
if [ "$RESTART_DEV" = "1" ]; then
  bar
  echo "  Restarting dev server (releases pooled DB connections)"
  bar

  # Matches apps/web/package.json's dev:all: `concurrently -n api,web ... "npm run dev:api" "npm run dev"`.
  EXISTING_PID=$(pgrep -f "concurrently.*api,web" 2>/dev/null | head -1 || true)
  if [ -n "${EXISTING_PID:-}" ]; then
    echo "  Stopping existing dev server (pid $EXISTING_PID) ..."
    kill "$EXISTING_PID" 2>/dev/null || true
    sleep 2
  fi

  echo "  Starting dev server ..."
  cd "$REPO"
  nohup npm run dev > "$DEV_LOG" 2>&1 &
  DEV_PID=$!
  disown "$DEV_PID" 2>/dev/null || true

  DEV_TIMEOUT=60
  DEV_ELAPSED=0
  while true; do
    if grep -q "FoxSchema API listening" "$DEV_LOG" 2>/dev/null && grep -qi "ready in" "$DEV_LOG" 2>/dev/null; then
      echo "  ✓ dev server ready (log: $DEV_LOG)"
      break
    fi
    if [ "$DEV_ELAPSED" -ge "$DEV_TIMEOUT" ]; then
      echo "  ✗ dev server didn't report ready within ${DEV_TIMEOUT}s — check $DEV_LOG"
      break
    fi
    sleep 2
    DEV_ELAPSED=$((DEV_ELAPSED + 2))
  done
else
  echo "  (skipping dev server restart — --no-restart-dev)"
fi

# ── 4. Truncate + reseed every dialect ───────────────────────────────────────
bar
echo "  Reseeding all dialects"
bar
bash "$REPO/scripts/seed/seed-all.sh" all

echo ""
echo "Done. Run the E2E suite with:"
echo "  cd apps/e2e && node scripts/run-all.mjs"
