import type { FastifyReply } from 'fastify';
import type { WorkspaceScope } from '../platform/http/scope';
import { scopeOf } from '../platform/http/scope';
import type { AppRequest } from '../platform/http/types';
import { Router } from '../platform/http/router';
import {
  ConnectionModule,
  CompareModule,
  MigrationModule,
  SqlGeneratorModule,
  DriverDetector,
  IBM_DB_VERSION,
  normalizeTableSchemas,
  type ConnectionOptions,
} from '@foxschema/db';
import { ConnectionStore } from '../features/connections/connection-store.service';
import { MigrationHistoryStore } from '../features/migration/migration-history.service';
import { DataMigrateHistoryStore } from '../features/data-migrate/data-migrate-history.service';
import { AppSettingsStore } from '../features/admin/app-settings.service';
import { LokeeWeaveStore } from '../features/history/lokee-weave.service';
import { rateLimit } from '../platform/guards/rate-limit';
import { targetLocks } from '../platform/guards/target-lock';
import { idempotency } from '../platform/guards/idempotency';
import { browseDirectory, browseErrorMessage, resolveBrowsePath } from './file-browse';
import {
  isRunnableStatement,
  MAX_STATEMENTS,
  MAX_STATEMENT_LENGTH,
} from '../features/sql-editor/sql-execute.service';
import { getMetadataDbConfig, SUPPORTED_ENGINES, type DbEngine } from '../database/config';
import { createMetadataStore } from '../database/stores/registry';
import type { AuthedRequest } from '../features/auth/auth.routes';
import { requirePermissions } from '../features/authorization/rbac.guard';
import { isLocalSingleUser } from './deployment';
import { makeConnectionResolver, type ConnectionRef } from '../platform/db/resolve';
import { makeCompareService } from '../features/compare/compare.service';
import { createCompareRoutes } from '../features/compare/compare.routes';
import { createAccessRoutes } from '../features/access/access.routes';
import { createHistoryRoutes } from '../features/history/history.routes';
import { gitServices } from '../features/git/git-migrations.service';
import { LOKEE_FULL_SCOPE } from '../features/history/lokee-scope';
import { createEditorRoutes } from '../features/sql-editor/editor.routes';
import { createMigrationRoutes } from '../features/migration/migration.routes';
import { createSchemaRoutes } from '../features/schema/schema.routes';
import { createDataMigrateRoutes } from '../features/data-migrate/data-migrate.routes';
import {
  applyNpmGlobalUpdate,
  canSelfUpdate,
  checkForUpdate,
  clearUpdateCache,
  MANUAL_UPDATE_COMMAND,
  resolveAppVersion,
  scheduleUiRelaunch,
} from '../internal/updates.service';
import { sendError, sendThrown } from '../platform/http/respond';
import { keySchemeInfo } from '../platform/crypto/crypto';

// ConnectionRef and its resolution moved to platform/db/resolve.ts so
// services can share them; re-exported here because other modules import it
// from this file.
export type { ConnectionRef };

export function createApiRoutes(connectionModule: ConnectionModule, connectionStore: ConnectionStore): Router {
  const router = Router();
  const compareModule = new CompareModule();
  const migrationModule = new MigrationModule();
  const sqlGenerator = new SqlGeneratorModule();
  const migrationHistory = new MigrationHistoryStore();
  const dataMigrateHistory = new DataMigrateHistoryStore();
  const appSettings = new AppSettingsStore();
  const lokeeWeave = new LokeeWeaveStore();

  // Feature services. These own the business logic and its permission checks;
  // the handlers below are meant to shrink into translation as more move over.
  const resolver = makeConnectionResolver(connectionModule, connectionStore);
  const compareService = makeCompareService({ resolver, compareModule });

  // Single implementation, shared with the feature services. Destructured so the
  // handlers below keep their existing call sites unchanged.
  const { resolveRef, loadScopedTables } = resolver;

  // Feature modules, each owning its own routes/handler/controller/service.
  // routes.ts shrinks by one feature every time another moves across.
  router.use(createCompareRoutes({ compareService }));
  router.use(createAccessRoutes({ resolveRef, connectionModule }));
  router.use(createSchemaRoutes({ resolveRef, connectionModule, loadScopedTables }));
  router.use(createDataMigrateRoutes({ resolveRef, dataMigrateHistory }));
  router.use(createMigrationRoutes({ resolveRef, migrationModule, migrationHistory, connectionModule, sqlGenerator, captureLiveSchema, normalizeTableSchemas }));
  router.use(
    createEditorRoutes({
      resolveRef,
      MAX_STATEMENTS,
      MAX_STATEMENT_LENGTH,
      isRunnableStatement,
      testConnection: (dialect, option) =>
        connectionModule.testConnection(dialect, option as ConnectionOptions),
    })
  );
  router.use(
    createHistoryRoutes({
      lokee: lokeeWeave,
      captureLiveSchema,
      resolveRef,
      migrationModule,
      loadScopedTables,
      commitRequired: () => gitServices().migrations.commitRequired(),
    })
  );

  async function captureLiveSchema(
    scope: WorkspaceScope,
    resolved: { dialect: string; option: ConnectionOptions; schema: string },
    source: 'manual' | 'migrate' | 'revert' | 'force-migrate',
    extra?: {
      migrationRunId?: string;
      revert?: { fromVersionId: string; toVersionId: string };
      appliedFrom?: { databaseId: string; versionId: string };
    }
  ) {
    const { tables } = await loadScopedTables(
      resolved.dialect,
      resolved.option,
      resolved.schema ?? '',
      LOKEE_FULL_SCOPE
    );
    return lokeeWeave.capture(scope, {
      dialect: resolved.dialect,
      host: resolved.option.host ?? null,
      port: resolved.option.port ?? null,
      database: resolved.option.database ?? null,
      schema: resolved.schema ?? null,
      tables,
      source,
      migrationRunId: extra?.migrationRunId,
      revert: extra?.revert,
      appliedFrom: extra?.appliedFrom,
    });
  }


  // /health is registered on the public app in server.ts (before auth) and
  // already includes `version` for stale-process detection — do not re-add here.

  // In-app update check — compares the running version against npm (default).
  router.get('/updates/check', async (_req: AppRequest, res: FastifyReply) => {
    res.send(await checkForUpdate());
  });

  // One-click self-update for local npm CLI installs (`foxschema open`).
  // Runs `npm install -g foxschema@latest`, then relaunches the UI server.
  router.post('/updates/apply', async (_req: AppRequest, res: FastifyReply) => {
    if (!canSelfUpdate()) {
      sendError(
        res,
        'forbidden',
        'Automatic update is only available for local CLI installs. ' +
          `Run in a terminal: ${MANUAL_UPDATE_COMMAND}`,
        { extra: { upgradeCommand: MANUAL_UPDATE_COMMAND } }
      );
      return;
    }
    const result = await applyNpmGlobalUpdate();
    if (!result.ok) {
      res.status(500).send(result);
      return;
    }
    clearUpdateCache();
    res.send(result);
    // Respond first, then exit + relaunch so the client can start polling.
    scheduleUiRelaunch();
  });

  // First-open email subscriber wizard lives on public /api/signup/* (see
  // signup.routes.ts) so it works before sign-in.

  // Non-secret info about where the app's metadata DB lives and how the
  // credential-encryption key is bound — for the "Database & Security" settings
  // section. Never exposes the key itself.
  router.get('/app-info', async (_req: AppRequest, res: FastifyReply) => {
    const cfg = getMetadataDbConfig();
    const key = keySchemeInfo();
    // Persist a durable record of the active config (useful for later tooling).
    try {
      await appSettings.set('db.engine', cfg.engine);
      if (cfg.path) await appSettings.set('db.path', cfg.path);
      if (key.boundEmail) await appSettings.set('key.boundEmail', key.boundEmail);
      await appSettings.set('key.scheme', key.scheme);
    } catch {
      /* best-effort; never block the response */
    }
    res.send({
      version: resolveAppVersion(),
      features: { fileQuery: true },
      db: { engine: cfg.engine, location: cfg.engine === 'sqlite' ? cfg.path ?? '(default)' : cfg.url ?? '' },
      security: { keyScheme: key.scheme, emailBound: key.emailBound, boundEmail: key.boundEmail },
    });
  });

  // Validate a candidate metadata-DB engine/URL before the user switches to it.
  // Opens a throwaway connection (no migrations, no effect on the live store).
  // Restricted to the local/community edition — on multi-user web the metadata
  // DB is ops-managed, and a connection probe would be an SSRF vector.
  router.post('/db/test', async (req: AppRequest, res: FastifyReply) => {
    // The restriction above was documented but never implemented. On a
    // multi-user deployment this handler dials any host:port the caller names
    // and reports, through the error text, whether something answered — an
    // SSRF and internal port-scan primitive, on a route that carries no
    // permission check. Local single-user is the only place it belongs.
    if (!isLocalSingleUser()) {
      sendError(res, 'forbidden', 'Changing the metadata database is not available on this deployment.');
      return;
    }
    const { engine, url, path } = req.body as { engine?: string; url?: string; path?: string };
    if (!engine || !SUPPORTED_ENGINES.includes(engine as DbEngine)) {
      sendError(res, 'invalid_input', `Unsupported engine. Supported: ${SUPPORTED_ENGINES.join(', ')}.`);
      return;
    }
    if ((engine === 'postgres' || engine === 'mysql') && !url) {
      sendError(res, 'invalid_input', 'A connection string is required.');
      return;
    }
    let store;
    try {
      store = createMetadataStore({ engine: engine as DbEngine, url, path });
      await store.init();
      res.send({ ok: true });
    } catch (error: unknown) {
      res.send({ ok: false, error: error instanceof Error ? error.message : 'Connection failed' });
    } finally {
      try {
        await store?.close();
      } catch {
        /* ignore */
      }
    }
  });

  router.get('/driver/check', (req: AppRequest, res: FastifyReply) => {
    const dialect = String(req.query.dialect ?? '');
    try {
      const driver = connectionModule.checkDriver(dialect);
      res.send(driver);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Invalid dialect';
      sendError(res, 'invalid_input', message);
    }
  });

  router.post('/driver/install', async (req: AppRequest, res: FastifyReply) => {
    const { dialect } = (req.body ?? {}) as { dialect?: unknown };
    // Without this, a missing dialect reached DriverDetector and came back as a
    // 500 — the caller's malformed request reported as a server fault.
    if (typeof dialect !== 'string' || !dialect.trim()) {
      sendError(res, 'invalid_input', 'A dialect is required to install a driver.', {
        extra: { success: false },
      });
      return;
    }

    try {
      const packageName = DriverDetector.getPackageName(dialect);
      const versionPin = packageName === 'ibm_db' ? IBM_DB_VERSION : undefined;

      // Resolve monorepo vs packaged cwd (bundled ui-server used to install into `/`).
      // ibm_db must run install scripts so clidriver downloads + native binding builds.
      const {
        installAndVerifyDriver,
        driverInstallHints,
      } = await import('../internal/driver-install');

      const result = await installAndVerifyDriver(packageName, versionPin);

      if (result.code === null) {
        // npm never started (not on PATH, blocked by policy). The spawn error
        // is the only useful detail; without this it was reported as "install
        // finished but the driver failed to load", which sends the user off
        // debugging the driver instead of their PATH.
        const detail = (result.stderr || result.stdout).trim().slice(-2000);
        sendError(res, 'failed',            `Could not run npm for ${packageName}${detail ? `: ${detail}` : ''}. ` +
            `Try it yourself: ${result.manualCommand}. ${driverInstallHints(packageName)}`, {
          extra: { success: false, stderr: result.stderr, cwd: result.cwd },
        });
        return;
      }

      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim().slice(-2000);
        sendError(res, 'failed',            `npm install ${packageName} failed (exit ${result.code})${detail ? `: ${detail}` : ''}. ` +
            `Try: ${result.manualCommand}. ${driverInstallHints(packageName)}`, {
          extra: { success: false, stderr: result.stderr, cwd: result.cwd },
        });
        return;
      }

      if (!result.ok) {
        // npm exited 0 but driver still does not load (scripts skipped / wrong arch).
        sendError(res, 'failed',            `Install finished but ${packageName} still failed to load` +
            (result.error ? `: ${result.error}` : '') +
            `. Try: ${result.manualCommand}. ${driverInstallHints(packageName)}` +
            ` Then restart Fox Schema (\`foxschema stop && foxschema\`).`, {
          extra: { success: false, stderr: result.stderr, cwd: result.cwd },
        });
        return;
      }

      res.send({
        success: true,
        stdout: result.stdout,
        cwd: result.cwd,
        hint: 'If the driver still shows missing, restart Fox Schema so the process reloads native bindings.',
      });
    } catch (error: unknown) {
      sendThrown(res, error, 'Installation failed', { extra: { success: false } });
    }
  });

  router.post('/connection/test', async (req: AppRequest, res: FastifyReply) => {
    try {
      const { dialect, option } = await resolveRef(scopeOf(req as AuthedRequest), req.body as ConnectionRef);
      const { success, version } = await connectionModule.testConnection(dialect, option);
      res.send({ success, version, error: success ? undefined : 'Connection test returned false' });
    } catch (error: unknown) {
      sendThrown(res, error, 'Connection failed', { extra: { success: false } });
    }
  });


  // Load a single schema's scoped objects (no comparison) — for the browse/search
  // mode. Uses resolveRef so saved connections work, and applies the object-type
  // scope just like /compare does for each side.

  /**
   * Index fragmentation % for Edit Table (DBA guidance).
   * Tries the dialect default probe first; on failure accepts `customSql`
   * (single SELECT returning index_name + fragmentation_percent).
   */

  /**
   * Batch index fragmentation for Utilities → Index Management.
   * Probes many tables (capped) with bounded concurrency on one connection ref.
   */

  /**
   * DBA utilities: connection pool, user sessions, system info, object sizes.
   * One connection ref + kind; dialect probes live in @foxschema/db.
   */

  /**
   * Database users, roles/groups, and object privileges for Access control /
   * Utilities → Database Access. GRANT/REVOKE still go through /sql/execute
   * (editor.grant).
   */

  // SQL Editor: run ad-hoc statements against ONE credential and return shaped
  // row results. The frontend fans out across selected credentials with one
  // request each. The client splits the buffer (same trust model as
  // /migration/execute's pre-split statements); the server validates shape and
  // caps only. Rate-limited: each call can hold a DB connection for a while.
  const sqlExecuteLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
  /**
   * One instance across the mutating routes: a retry carrying the same key must
   * be recognised wherever it lands, and the key is bound to route + body so
   * two different requests cannot collide.
   */
  const writeIdempotency = idempotency();


  // SQL Editor Node code cells (`-- @node` / `-- @nodets`). No DB connection;
  // runs allowlisted JS/TS with fetch in a worker_threads sandbox.
  const codeCellLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

  // requirePermissions stays for the 401/403 shape the client already expects;
  // the service re-checks so a non-REST caller cannot bypass it.

  /**
   * What long-running work is in flight, for the UI's activity indicator.
   * Cheap and read-only — safe to poll.
   */
  router.get('/activity', (_req: AppRequest, res: FastifyReply) => {
    const running = targetLocks.active();
    res.send({
      count: running.length,
      tasks: running.map((t) => ({
        operation: t.operation,
        label: t.label,
        startedAt: t.startedAt,
        // The key names host/database/schema, never a credential.
        target: t.key,
      })),
    });
  });

  // --- Migration history (per user) ----------------------------------------

  // Bulk delete selected runs. Registered before '/migrations/:id' so the
  // literal path isn't captured as an :id.

  // Clear the entire history for the user.



  // --- Lokee Weave: schema versioning (Compare Schema history) -------------
  //
  // Capture reads the *whole* schema regardless of the compare scope in use.
  // A version that only covered the objects someone happened to be comparing
  // would be a snapshot you cannot safely revert to.
  const lokeeCaptureLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });


  // Directory listing for the SQLite / DuckDB file picker. Read-only and
  // name-only: it never returns file contents, and only names files a database
  // driver could open. `schema.browse` because picking a database file is the
  // first step of browsing one.
  const fileBrowseLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

  router.get(
    '/files/browse',
    fileBrowseLimiter,
    requirePermissions('schema.browse'),
    async (req: AppRequest, res: FastifyReply) => {
      const requested = typeof req.query.path === 'string' ? req.query.path : undefined;
      try {
        res.send(await browseDirectory(requested));
      } catch (error: unknown) {
        // The path is echoed back resolved, so the message names the directory
        // the server actually tried rather than the raw query string.
        sendError(res, 'invalid_input', browseErrorMessage(error, resolveBrowsePath(requested)));
      }
    }
  );






  // Version-to-version diff, served from the object store — no connection to
  // the compared database is needed or opened.



  // --- Data migrate apply (transaction / continue-on-error) ----------------

  // --- Data migrate history (SQL Editor side-by-side row ops) ---------------





  return router;
}


