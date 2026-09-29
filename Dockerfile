# syntax=docker/dockerfile:1
#
# Fox Schema — self-host / cloud image. Single container that serves the built
# web UI AND the /api on one configurable port (apps/web/src/serve.ts).
#
# One image (includes IBM Db2 via ibm_db). ibm_db has no linux/arm64 build, so
# this image targets linux/amd64:
#   docker build --platform=linux/amd64 -t foxschema .
#
# See docs/DEPLOYMENT.md and docker-compose.app.yml.

# ─────────────────────────── build stage ───────────────────────────
FROM node:24-slim AS build

# Kept for local overrides; default is true (single image with Db2).
ARG WITH_DB2=true

# Native modules (better-sqlite3, ibm_db, oracledb) need a C/C++ toolchain,
# plus curl/ca-certificates for ibm_db's driver download.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the repo (heavy/irrelevant workspaces excluded via .dockerignore).
COPY . .

# Only drop ibm_db when explicitly building WITHOUT Db2 (local lean builds).
RUN if [ "$WITH_DB2" = "true" ]; then \
      echo '>> building with Db2 (ibm_db) — use linux/amd64'; \
    else \
      echo '>> building without Db2 (WITH_DB2=false)'; \
      node -e "const fs=require('fs');for(const f of ['apps/web/package.json','packages/db/package.json']){const p=JSON.parse(fs.readFileSync(f));if(p.optionalDependencies){delete p.optionalDependencies.ibm_db;}fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n');}"; \
    fi

# `npm install`, not `npm ci`, and deliberately so — this is the one place the
# committed lockfile is not used:
#   - the WITH_DB2=false path above rewrites package.json to drop ibm_db, and
#     `npm ci` fails by design when package.json and the lockfile disagree;
#   - .dockerignore excludes package-lock.json from the build context anyway.
# Everywhere else (CI, local) installs the locked tree. See docs/DEPENDENCY_POLICY.md.
RUN npm install

# Produce the frontend bundle at apps/web/dist (root build -> @foxschema/web).
RUN npm run build

# ─────────────────────────── runtime stage ─────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app

# Run as a non-root user.
RUN useradd --system --create-home --uid 10001 fox

# Only what the web server needs: installed deps, the core engine source
# (imported as TS via tsx at runtime), and the web app (src + built dist).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/web ./apps/web
COPY --from=build /app/package.json ./package.json
# The licences of the packages baked into this image travel with it — MIT,
# BSD and ISC all require their notice to accompany the code.
COPY --from=build /app/LICENSE /app/NOTICE /app/THIRD-PARTY-NOTICES.md ./

# Persistent volume for the SQLite metadata store (saved connections, history)
# and the auto-generated encryption key (/data/.app_encryption_key).
COPY docker-entrypoint.sh /entrypoint.sh
RUN mkdir -p /data \
    && chown -R fox:fox /data /app \
    && chmod +x /entrypoint.sh
USER fox

ENV NODE_ENV=production \
    API_PORT=3210 \
    STATIC_DIR=/app/apps/web/dist \
    APP_DB_ENGINE=sqlite \
    APP_DB_PATH=/data/foxschema.db \
    APP_KEY_SCHEME=v1 \
    LOCAL_SINGLE_USER=true
# APP_ENCRYPTION_KEY is optional for pull-and-run: entrypoint generates one into
# /data/.app_encryption_key on first boot. Set -e APP_ENCRYPTION_KEY=… to override.

EXPOSE 3210
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3210)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx is present in node_modules (a devDependency, kept because we run TS at
# runtime). node:sqlite is flag-free on Node 24.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node_modules/.bin/tsx", "apps/web/src/serve.ts"]
