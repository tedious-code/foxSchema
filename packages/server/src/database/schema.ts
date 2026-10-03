import type { Dialect, MetadataStore } from './stores/types';

/**
 * Dialect-aware schema. The DDL is rendered per engine (column types differ:
 * MySQL needs bounded VARCHAR for keys/timestamps, TEXT can't be a PK/UNIQUE).
 * Reserved identifiers (`schema`, `key`, `value`) are double-quoted; each
 * provider maps the quotes to its dialect.
 *
 * **Append-only:** never edit a shipped migration; add a new one.
 */

function types(d: Dialect) {
  return {
    id: d === 'mysql' ? 'VARCHAR(64)' : 'TEXT', //   PK / FK / indexed key text
    str: d === 'mysql' ? 'VARCHAR(255)' : 'TEXT', // names, emails, short values
    big: d === 'mysql' ? 'LONGTEXT' : 'TEXT', //      large non-indexed text
    ts: d === 'mysql' ? 'VARCHAR(40)' : 'TEXT', //    ISO-8601 timestamp string
    int: 'INTEGER',
  };
}

interface Migration {
  id: number;
  name: string;
  statements: (d: Dialect) => string[];
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'init_users_connections',
    statements: (d) => {
      const t = types(d);
      return [
        `CREATE TABLE IF NOT EXISTS users (
           id ${t.id} PRIMARY KEY,
           email ${t.str} UNIQUE NOT NULL,
           password_hash ${t.str} NOT NULL,
           email_verified ${t.int} NOT NULL DEFAULT 0,
           onboarding_completed ${t.int} NOT NULL DEFAULT 0,
           created_at ${t.ts} NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS user_preferences (
           user_id ${t.id} PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
           role ${t.str},
           primary_database ${t.str},
           primary_goal ${t.str},
           theme ${t.str},
           updated_at ${t.ts} NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS connections (
           id ${t.id} PRIMARY KEY,
           user_id ${t.id} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           name ${t.str},
           dialect ${t.str} NOT NULL,
           "schema" ${t.str},
           encrypted_config ${t.big} NOT NULL,
           created_at ${t.ts} NOT NULL
         )`,
        `CREATE INDEX idx_connections_user ON connections(user_id)`,
        `CREATE TABLE IF NOT EXISTS sessions (
           token ${t.id} PRIMARY KEY,
           user_id ${t.id} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           created_at ${t.ts} NOT NULL,
           expires_at ${t.ts} NOT NULL
         )`,
        `CREATE INDEX idx_sessions_user ON sessions(user_id)`,
      ];
    },
  },
  {
    id: 2,
    name: 'migration_runs',
    statements: (d) => {
      const t = types(d);
      return [
        `CREATE TABLE IF NOT EXISTS migration_runs (
           id ${t.id} PRIMARY KEY,
           user_id ${t.id} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           status ${t.str} NOT NULL,
           dialect ${t.str} NOT NULL,
           target_host ${t.str},
           database_name ${t.str},
           "schema" ${t.str},
           object_count ${t.int} NOT NULL DEFAULT 0,
           script ${t.big},
           snapshot_ddl ${t.big},
           results_json ${t.big},
           error ${t.big},
           started_at ${t.ts} NOT NULL,
           finished_at ${t.ts}
         )`,
        `CREATE INDEX idx_migration_runs_user ON migration_runs(user_id, started_at DESC)`,
      ];
    },
  },
  {
    id: 3,
    name: 'app_settings',
    statements: (d) => {
      const t = types(d);
      return [
        `CREATE TABLE IF NOT EXISTS app_settings (
           "key" ${t.id} PRIMARY KEY,
           "value" ${t.big},
           updated_at ${t.ts} NOT NULL
         )`,
      ];
    },
  },
  {
    id: 4,
    name: 'app_secrets',
    statements: (d) => {
      const t = types(d);
      return [
        `CREATE TABLE IF NOT EXISTS app_secrets (
           id ${t.id} PRIMARY KEY,
           user_id ${t.id} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           name ${t.str} NOT NULL,
           source ${t.str} NOT NULL,
           encrypted_value ${t.big},
           cloud_ref ${t.big},
           updated_at ${t.ts} NOT NULL
         )`,
        `CREATE UNIQUE INDEX idx_app_secrets_user_name ON app_secrets(user_id, name)`,
        `CREATE INDEX idx_app_secrets_user ON app_secrets(user_id)`,
      ];
    },
  },
  {
    id: 5,
    name: 'cloud_provider_credentials',
    statements: (d) => {
      const t = types(d);
      return [
        `CREATE TABLE IF NOT EXISTS cloud_provider_credentials (
           id ${t.id} PRIMARY KEY,
           user_id ${t.id} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           provider ${t.str} NOT NULL,
           encrypted_config ${t.big} NOT NULL,
           updated_at ${t.ts} NOT NULL
         )`,
        `CREATE UNIQUE INDEX idx_cloud_provider_creds_user ON cloud_provider_credentials(user_id, provider)`,
      ];
    },
  },
  {
    id: 6,
    name: 'cloud_provider_credentials_named',
    statements: (d) => {
      const t = types(d);
      const dropIndex =
        d === 'mysql'
          ? 'DROP INDEX idx_cloud_provider_creds_user ON cloud_provider_credentials'
          : 'DROP INDEX IF EXISTS idx_cloud_provider_creds_user';
      return [
        `ALTER TABLE cloud_provider_credentials ADD COLUMN name ${t.str}`,
        // Backfill: one row per provider historically → use provider id as display name
        `UPDATE cloud_provider_credentials SET name = provider WHERE name IS NULL OR name = ''`,
        dropIndex,
        `CREATE UNIQUE INDEX idx_cloud_provider_creds_user_name ON cloud_provider_credentials(user_id, name)`,
      ];
    },
  },
  {
    id: 7,
    name: 'rbac_app_roles',
    statements: (d) => {
      const t = types(d);
      return [
        // App RBAC role (admin | editor | viewer). Distinct from onboarding user_preferences.role.
        `ALTER TABLE users ADD COLUMN app_role ${t.str}`,
        `UPDATE users SET app_role = 'admin' WHERE app_role IS NULL OR app_role = ''`,
        `CREATE TABLE IF NOT EXISTS role_permissions (
           role ${t.str} NOT NULL,
           permission ${t.str} NOT NULL,
           PRIMARY KEY (role, permission)
         )`,
      ];
    },
  },
  {
    // No DDL — runMigrations uses this id as the hook point to suppress the
    // first-open email wizard on installs that already have Fox data (covers
    // upgrades that already applied migration 7 before the suppress logic landed).
    id: 8,
    name: 'suppress_signup_wizard_on_used_install',
    statements: () => [],
  },
  {
    id: 9,
    name: 'users_active_flag',
    statements: (d) => {
      const t = types(d);
      return [
        // Soft-disable accounts from Access control without deleting history.
        `ALTER TABLE users ADD COLUMN active ${t.int} NOT NULL DEFAULT 1`,
      ];
    },
  },
  {
    id: 10,
    name: 'data_migrate_runs',
    statements: (d) => {
      const t = types(d);
      return [
        `CREATE TABLE IF NOT EXISTS data_migrate_runs (
           id ${t.id} PRIMARY KEY,
           user_id ${t.id} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           status ${t.str} NOT NULL,
           dialect ${t.str} NOT NULL,
           source_host ${t.str},
           target_host ${t.str},
           database_name ${t.str},
           "schema" ${t.str},
           table_name ${t.str},
           row_count ${t.int} NOT NULL DEFAULT 0,
           ops_json ${t.big},
           include_identity ${t.int} NOT NULL DEFAULT 0,
           key_columns_json ${t.big},
           script ${t.big},
           snapshot_json ${t.big},
           results_json ${t.big},
           error ${t.big},
           started_at ${t.ts} NOT NULL,
           finished_at ${t.ts}
         )`,
        `CREATE INDEX idx_data_migrate_runs_user ON data_migrate_runs(user_id, started_at DESC)`,
      ];
    },
  },
  {
    id: 11,
    name: 'lokee_weave_schema_versions',
    statements: (d) => {
      const t = types(d);
      return [
        // A database, not a saved connection: two connections pointing at the
        // same database share one history, and rotating a password keeps it.
        // `fingerprint` is the content hash from databaseIdentity(); the row
        // also keeps the components in the clear so the UI can label it.
        `CREATE TABLE IF NOT EXISTS lokee_databases (
           id ${t.id} PRIMARY KEY,
           user_id ${t.id} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           fingerprint ${t.id} NOT NULL,
           dialect ${t.str} NOT NULL,
           host ${t.str},
           port ${t.int},
           database_name ${t.str},
           "schema" ${t.str},
           created_at ${t.ts} NOT NULL,
           last_seen_at ${t.ts} NOT NULL
         )`,
        `CREATE UNIQUE INDEX idx_lokee_databases_user_fp ON lokee_databases(user_id, fingerprint)`,

        // One row per *change* to the schema. Re-capturing an unchanged schema
        // bumps observation_count instead of inserting, which is what keeps a
        // scheduled scan from minting 175k rows a year.
        //
        // migration_run_id carries the attribution ("who migrated, when") for
        // free — migration_runs already stores user_id and started_at.
        `CREATE TABLE IF NOT EXISTS lokee_versions (
           id ${t.id} PRIMARY KEY,
           database_id ${t.id} NOT NULL REFERENCES lokee_databases(id) ON DELETE CASCADE,
           version_number ${t.int} NOT NULL,
           root_hash ${t.id} NOT NULL,
           parent_version_id ${t.id},
           migration_run_id ${t.id},
           author_user_id ${t.id},
           source ${t.str} NOT NULL,
           object_count ${t.int} NOT NULL DEFAULT 0,
           change_count ${t.int} NOT NULL DEFAULT 0,
           observation_count ${t.int} NOT NULL DEFAULT 1,
           created_at ${t.ts} NOT NULL,
           last_observed_at ${t.ts} NOT NULL
         )`,
        // Also the concurrency guard: two simultaneous captures both computing
        // version N means the second INSERT fails rather than forking history.
        `CREATE UNIQUE INDEX idx_lokee_versions_db_number ON lokee_versions(database_id, version_number)`,
        `CREATE INDEX idx_lokee_versions_db_created ON lokee_versions(database_id, created_at DESC)`,

        // Content-addressed bodies, shared across every version and database
        // that ever held an identical object. This is the storage optimisation:
        // 200 versions of an unchanged table store one row, not 200.
        `CREATE TABLE IF NOT EXISTS lokee_objects (
           hash ${t.id} PRIMARY KEY,
           object_key ${t.str} NOT NULL,
           object_type ${t.str} NOT NULL,
           name ${t.str},
           body_json ${t.big} NOT NULL,
           created_at ${t.ts} NOT NULL
         )`,

        // The delta: only objects that changed in this version. A 20,000-object
        // schema where 3 changed writes 3 rows.
        `CREATE TABLE IF NOT EXISTS lokee_version_objects (
           version_id ${t.id} NOT NULL REFERENCES lokee_versions(id) ON DELETE CASCADE,
           object_key ${t.str} NOT NULL,
           operation ${t.str} NOT NULL,
           object_hash ${t.id},
           previous_hash ${t.id},
           object_type ${t.str},
           PRIMARY KEY (version_id, object_key)
         )`,
        `CREATE INDEX idx_lokee_version_objects_key ON lokee_version_objects(object_key)`,

        // Latest-state index: the current hash of every live object, so a
        // capture diffs against one batched read instead of replaying history.
        // Older states are reconstructed by walking deltas backwards from here.
        `CREATE TABLE IF NOT EXISTS lokee_latest_objects (
           database_id ${t.id} NOT NULL REFERENCES lokee_databases(id) ON DELETE CASCADE,
           object_key ${t.str} NOT NULL,
           object_hash ${t.id} NOT NULL,
           object_type ${t.str},
           PRIMARY KEY (database_id, object_key)
         )`,
      ];
    },
  },
  {
    id: 12,
    name: 'lokee_version_display_meta',
    statements: (d) => {
      const t = types(d);
      return [
        // Optional label shown instead of "Version N"; null keeps the default.
        `ALTER TABLE lokee_versions ADD COLUMN display_name ${t.str}`,
        `ALTER TABLE lokee_versions ADD COLUMN description ${t.big}`,
      ];
    },
  },
  {
    id: 13,
    name: 'lokee_object_source_lines',
    statements: (d) => {
      const t = types(d);
      return [
        // Original routine/view/trigger text and its line count. Not part of
        // the content hash — identical SQL with different whitespace still
        // shares one body row (pointer), while the inspector can show lines.
        `ALTER TABLE lokee_objects ADD COLUMN line_count ${t.int}`,
        `ALTER TABLE lokee_objects ADD COLUMN source_text ${t.big}`,
      ];
    },
  },
  {
    id: 14,
    name: 'lokee_shape_dedup',
    statements: (d) => {
      const t = types(d);
      return [
        // Reusable half of an object body. An object body carries its own name
        // and table, so `int not null` in forty tables was forty near-identical
        // rows; the declaration is now stored once and pointed at.
        //
        // The object hash is unchanged — it is still computed over the whole
        // body. This is a storage layout, not a change of identity, or every
        // recorded version would need rehashing.
        `CREATE TABLE IF NOT EXISTS lokee_shapes (
           shape_hash ${t.id} PRIMARY KEY,
           shape_json ${t.big} NOT NULL,
           created_at ${t.ts} NOT NULL
         )`,
        // Null for rows written before this migration and for any body that
        // does not round-trip; those keep their whole body in body_json.
        `ALTER TABLE lokee_objects ADD COLUMN shape_hash ${t.id}`,
        // The history read path filters children by key prefix (LIKE
        // 'column:OWNER.%'), which scans without this.
        `CREATE INDEX idx_lokee_objects_key ON lokee_objects(object_key)`,
        // Graph reconstruction walks deltas newest-first per version.
        `CREATE INDEX idx_lokee_version_objects_hash ON lokee_version_objects(object_hash)`,
      ];
    },
  },
  {
    id: 15,
    name: 'lokee_version_revert_provenance',
    statements: (d) => {
      const t = types(d);
      return [
        // Where a revert came from and where it went. A version recorded by a
        // revert carried `source = 'revert'` and nothing else, so history could
        // say a revert happened but never which version was restored — the one
        // question you ask when reading back an undo.
        //
        // Nullable: every version captured before this, and every non-revert
        // capture, legitimately has neither.
        `ALTER TABLE lokee_versions ADD COLUMN revert_from_version_id ${t.id}`,
        `ALTER TABLE lokee_versions ADD COLUMN revert_to_version_id ${t.id}`,
      ];
    },
  },
  {
    id: 16,
    name: 'lokee_version_force_migrate_provenance',
    statements: (d) => {
      const t = types(d);
      return [
        // Where a force-migrated schema came from.
        //
        // A force-migrate applies a version captured against one database to a
        // different one. The receiving database gets its own capture, and
        // without these it would record only that its schema changed — losing
        // the one fact worth keeping: which history, and which version of it,
        // this shape was taken from.
        //
        // Deliberately two columns rather than reusing `revert_*`: a revert
        // moves a database within its own history, and collapsing the two would
        // make "reverted to v7" and "given v7 from another database"
        // indistinguishable when reading a version back.
        //
        // Nullable: every version captured before this, and every capture that
        // is not a force-migrate, legitimately has neither.
        `ALTER TABLE lokee_versions ADD COLUMN applied_from_database_id ${t.id}`,
        `ALTER TABLE lokee_versions ADD COLUMN applied_from_version_id ${t.id}`,
      ];
    },
  },
  {
    id: 17,
    name: 'workspace_and_workflow_settings',
    statements: (d) => {
      const t = types(d);
      return [
        // Community installs use workspace_id = 'local'. Enterprise may attach
        // connections to real workspaces later without another connections DDL.
        `ALTER TABLE connections ADD COLUMN workspace_id ${t.str} DEFAULT 'local'`,
        // Optional per-workspace JSON for FoxWorkflow (control plane may also
        // use app_settings key workflow.engine_config for the local default).
        `CREATE TABLE IF NOT EXISTS workflow_settings (
           workspace_id ${t.id} PRIMARY KEY,
           config_json ${t.big},
           updated_at ${t.ts} NOT NULL
         )`,
      ];
    },
  },
  {
    id: 18,
    name: 'workflow_connection_grants',
    statements: (d) => {
      const t = types(d);
      return [
        // A saved connection its owner lets workflows use. The engine resolves
        // it as that owner; deleting the row revokes it from the next run on.
        `CREATE TABLE IF NOT EXISTS workflow_connection_grants (
           connection_id ${t.id} PRIMARY KEY,
           user_id ${t.id} NOT NULL,
           created_at ${t.ts} NOT NULL
         )`,
      ];
    },
  },
  {
    id: 19,
    name: 'users_password_set',
    statements: (d) => {
      const t = types(d);
      return [
        // Whether someone chose this account's password. Sign-in is now
        // required everywhere; an install that ran without it holds one local
        // account whose password nobody knows, and first-run setup lets its
        // owner claim it. Existing rows start at 0 and become 1 on the first
        // successful sign-in, so nothing here decides who may sign in.
        `ALTER TABLE users ADD COLUMN password_set ${t.int} NOT NULL DEFAULT 0`,
      ];
    },
  },
  {
    id: 20,
    name: 'auth_codes_and_hashed_sessions',
    statements: (d) => {
      const t = types(d);
      return [
        // One-time password-reset and invite codes. Only a code's SHA-256 is
        // kept, so reading this table gives nobody a code that works.
        `CREATE TABLE IF NOT EXISTS auth_codes (
           code_hash ${t.id} PRIMARY KEY,
           user_id ${t.id} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           purpose ${t.str} NOT NULL,
           created_at ${t.ts} NOT NULL,
           expires_at ${t.ts} NOT NULL,
           used_at ${t.ts}
         )`,
        `CREATE INDEX idx_auth_codes_user ON auth_codes(user_id)`,
        // Session tokens are stored hashed from here on. The rows written
        // before hold raw tokens, which no longer match anything: drop them,
        // and everyone signs in once more.
        `DELETE FROM sessions`,
      ];
    },
  },
  {
    id: 21,
    name: 'git_repos_and_migration_commits',
    statements: (d) => {
      const t = types(d);
      return [
        // A Git repository migrations are committed to. The access token is
        // encrypted with the install key and never returned by the API.
        `CREATE TABLE IF NOT EXISTS git_repos (
           id ${t.id} PRIMARY KEY,
           name ${t.str} NOT NULL,
           remote_url ${t.big} NOT NULL,
           default_branch ${t.str} NOT NULL,
           folder ${t.str} NOT NULL,
           auth_username ${t.str},
           encrypted_token ${t.big},
           require_commit ${t.int} NOT NULL DEFAULT 0,
           created_by ${t.id},
           created_at ${t.ts} NOT NULL,
           updated_at ${t.ts} NOT NULL
         )`,
        // Which commit a migration run applied, when it came from Git.
        `ALTER TABLE migration_runs ADD COLUMN git_repo_id ${t.id}`,
        `ALTER TABLE migration_runs ADD COLUMN git_branch ${t.str}`,
        `ALTER TABLE migration_runs ADD COLUMN git_commit ${t.str}`,
        `ALTER TABLE migration_runs ADD COLUMN git_path ${t.big}`,
      ];
    },
  },
  {
    id: 22,
    name: 'git_applied',
    statements: (d) => {
      const t = types(d);
      return [
        // Which committed migration ran against which database. Separate from
        // migration_runs, which keeps only each user's recent runs: if this
        // were pruned, an old migration would look unapplied and be offered
        // to run again.
        `CREATE TABLE IF NOT EXISTS git_applied (
           id ${t.id} PRIMARY KEY,
           repo_id ${t.id} NOT NULL,
           path ${t.str} NOT NULL,
           commit_oid ${t.str} NOT NULL,
           target_key ${t.str} NOT NULL,
           status ${t.str} NOT NULL,
           run_id ${t.id},
           applied_by ${t.id},
           applied_at ${t.ts} NOT NULL
         )`,
        `CREATE INDEX idx_git_applied_target ON git_applied(repo_id, target_key)`,
      ];
    },
  },
  {
    id: 23,
    name: 'git_activity',
    statements: (d) => {
      const t = types(d);
      return [
        // Who changed a Git repository or moved its branches. Push and pull
        // use the repository's one token, so the remote sees one identity
        // for everyone; this is the record of who acted. Never pruned.
        `CREATE TABLE IF NOT EXISTS git_activity (
           id ${t.id} PRIMARY KEY,
           repo_id ${t.id} NOT NULL,
           action ${t.str} NOT NULL,
           detail ${t.big},
           user_id ${t.id},
           at ${t.ts} NOT NULL
         )`,
        `CREATE INDEX idx_git_activity_repo ON git_activity(repo_id, at)`,
      ];
    },
  },
];

const SIGNUP_WIZARD_SHOWN_KEY = 'signup.wizard_shown';

/** True when the metadata DB already has user-created data (not a greenfield boot). */
async function installLooksUsed(store: MetadataStore): Promise<boolean> {
  const connections = await store.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM connections'
  );
  if (Number(connections?.n) > 0) return true;
  const runs = await store.get<{ n: number }>('SELECT COUNT(*) AS n FROM migration_runs');
  if (Number(runs?.n) > 0) return true;
  const settings = await store.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM app_settings WHERE "key" != ?`,
    [SIGNUP_WIZARD_SHOWN_KEY]
  );
  return Number(settings?.n) > 0;
}

/**
 * Existing installs upgrading into the first-open email wizard should not be
 * prompted — only brand-new metadata DBs (all migrations applied in one go)
 * show it. Called when migration 7 lands on a DB that already had earlier
 * migrations applied.
 */
async function suppressSignupWizardForExistingInstall(store: MetadataStore): Promise<void> {
  const row = await store.get<{ value: string | null }>(
    'SELECT "value" FROM app_settings WHERE "key" = ?',
    [SIGNUP_WIZARD_SHOWN_KEY]
  );
  if (row?.value === 'true') return;
  await store.upsert(
    'app_settings',
    ['key'],
    {
      key: SIGNUP_WIZARD_SHOWN_KEY,
      value: 'true',
      updated_at: new Date().toISOString(),
    },
    ['value', 'updated_at']
  );
}

/**
 * Apply pending migrations. Idempotent: tables use IF NOT EXISTS and applied ids
 * are tracked in schema_migrations; a re-created index error on retry is ignored
 * (no portable CREATE INDEX IF NOT EXISTS across all three engines).
 */
export async function runMigrations(store: MetadataStore): Promise<void> {
  const t = types(store.dialect);
  await store.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id ${t.int} PRIMARY KEY,
       name ${t.str} NOT NULL,
       applied_at ${t.ts} NOT NULL
     )`
  );

  const appliedRows = await store.all<{ id: number }>('SELECT id FROM schema_migrations');
  const applied = new Set(appliedRows.map((r) => Number(r.id)));
  // Any prior migration means this is an upgrade of an existing install, not a
  // greenfield first boot (where every migration runs in a single pass).
  const upgradingExistingInstall = applied.size > 0;

  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    for (const stmt of m.statements(store.dialect)) {
      try {
        await store.exec(stmt);
      } catch (err) {
        // Tolerate re-create on retry / partial apply (indexes + additive columns).
        // Matched against a whitespace-normalised head rather than a regex with
        // optional repeated groups, which is both clearer and not a ReDoS shape.
        //
        // UNIQUE has to be covered: migrations 4, 6 and 11 all create unique
        // indexes, and without it a partially-applied migration could never be
        // re-run — it would throw on the index it had already created.
        const head = stmt.trim().slice(0, 40).replace(/\s+/g, ' ').toUpperCase();
        if (head.startsWith('CREATE INDEX') || head.startsWith('CREATE UNIQUE INDEX')) continue;
        if (head.startsWith('ALTER TABLE ') && /duplicate column|already exists/i.test(String(err))) {
          continue;
        }
        if (head.startsWith('DROP INDEX ')) continue;
        throw err;
      }
    }
    await store.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
      m.id,
      m.name,
      new Date().toISOString(),
    ]);
    // Migration 7 ships with the first-open email wizard. Suppress that wizard
    // for installs that already had Fox data before this upgrade.
    if (m.id === 7 && upgradingExistingInstall) {
      await suppressSignupWizardForExistingInstall(store);
    }
    // Migration 8: same suppress for used installs that already had migration 7
    // (e.g. mid-stream upgrades) without re-prompting greenfield first boots.
    if (m.id === 8 && (await installLooksUsed(store))) {
      await suppressSignupWizardForExistingInstall(store);
    }
  }
}
