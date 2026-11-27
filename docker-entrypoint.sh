#!/bin/sh
# Docker entrypoint — make `docker pull && docker run` work with no env setup.
#
# APP_ENCRYPTION_KEY encrypts saved DB passwords. Resolution order:
#   1. Already set in the environment (operator-provided secret) — use as-is.
#   2. File on the data volume (/data/.app_encryption_key) — load it.
#   3. Neither — generate a new key, persist it on the volume, then use it.
#
# Mount a named volume on /data so the key (and foxschema.db) survive restarts.

set -eu

KEY_FILE="${APP_ENCRYPTION_KEY_FILE:-/data/.app_encryption_key}"

ensure_data_dir() {
  if [ ! -d /data ]; then
    mkdir -p /data 2>/dev/null || true
  fi
}

if [ -z "${APP_ENCRYPTION_KEY:-}" ]; then
  ensure_data_dir
  if [ -f "$KEY_FILE" ]; then
    APP_ENCRYPTION_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
    export APP_ENCRYPTION_KEY
    echo "[fox] Loaded APP_ENCRYPTION_KEY from $KEY_FILE"
  else
    # Prefer openssl (present on node slim via... actually may not be). Use node.
    APP_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    export APP_ENCRYPTION_KEY
    if printf '%s\n' "$APP_ENCRYPTION_KEY" > "$KEY_FILE" 2>/dev/null; then
      chmod 600 "$KEY_FILE" 2>/dev/null || true
      echo "[fox] Generated APP_ENCRYPTION_KEY and saved to $KEY_FILE"
      echo "[fox] Tip: mount a volume on /data so this key persists across restarts."
    else
      echo "[fox] WARNING: could not write $KEY_FILE — key is ephemeral this run."
      echo "[fox] Mount -v foxschema_data:/data (or set APP_ENCRYPTION_KEY) for persistence."
    fi
  fi
fi

# Share the install encryption key with the in-process workflow engine when
# FOXFLOW_ENCRYPTION_KEY is not set separately, so a fresh install needs one key.
if [ -z "${FOXFLOW_ENCRYPTION_KEY:-}" ] && [ -n "${APP_ENCRYPTION_KEY:-}" ]; then
  FOXFLOW_ENCRYPTION_KEY="$APP_ENCRYPTION_KEY"
  export FOXFLOW_ENCRYPTION_KEY
fi

exec "$@"
