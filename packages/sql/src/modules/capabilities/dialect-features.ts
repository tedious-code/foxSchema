/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which of Fox Schema's features an engine actually supports.
 *
 * The answer already existed, four times, in four shapes: `supportsAccessBuilder`
 * returned a bare boolean, `userManagementSupport` a record with a reason,
 * command mode a registry lookup, and row editing a `Set` of dialect names in
 * the frontend. Each answered its own screen, none answered "can this engine do
 * this at all", and the screen with no gate offered itself to everything.
 *
 * Schema Compare was that screen, and it failed silently rather than awkwardly:
 * `resolveDialect` falls back to Db2 for a name it does not know, so a Redis or
 * MongoDB connection reaching the compare pipeline generated **Db2 DDL**.
 * Nothing errored.
 *
 * ## Derived, not declared
 *
 * The first version of this file lived in `modules/dialect`, a foundation
 * domain that `architecture.test.ts` forbids from importing `access` or
 * `command-mode` — so it re-declared all four answers by hand and needed a
 * consistency test to catch the inevitable drift. That constraint was
 * self-inflicted: the rule is one-directional, and a domain that nothing
 * imports back may depend on all three. Moving the file here lets it *ask* the
 * features instead of copying them, which deletes the drift and the test that
 * policed it. You cannot disagree with yourself.
 *
 * What stays declared is only what nothing else owns: `rowEditing`, and the
 * short sentences explaining a missing control.
 *
 * The engine roster comes from `PROVIDER_SETTINGS`, whose own comment promises
 * "register a new dialect by adding its settings here — nothing else changes".
 * A second hand-maintained list here would have broken that promise silently:
 * a new engine would have fallen through as unknown and lost every feature
 * with no test failing.
 */
import { supportsAccessBuilder } from '../access/intent.js';
import { userManagementSupport } from '../access/user-sql.js';
import { nonSqlPermissionsReason } from '../access/non-sql-engines.js';
import { supportsCommandMode } from '../command-mode/cli.registry.js';
import { PROVIDER_SETTINGS } from '../../providers/provider-settings.js';
import { fallbackReason, isKnownEngine, unknownEngineReason } from './feature-reasons.js';
import { schemaCompareSupport } from './schema-compare.js';

export { schemaCompareBlocker } from './schema-compare.js';

/** A top-level feature, one per control the app can offer for a connection. */
export type DialectFeature =
  /** Compare two schemas and generate the migration DDL. */
  | 'schemaCompare'
  /** Build GRANT/REVOKE statements. */
  | 'dbAccess'
  /** Create, alter and drop accounts. */
  | 'userManagement'
  /** Wrap a statement in the engine's own client for a terminal. */
  | 'commandMode'
  /** Edit result rows in the grid, and apply a data comparison. */
  | 'rowEditing';

export const DIALECT_FEATURES: readonly DialectFeature[] = [
  'schemaCompare',
  'dbAccess',
  'userManagement',
  'commandMode',
  'rowEditing',
];

/**
 * Whether one feature is available, and why not when it is not.
 *
 * A union rather than `{ supported: boolean; reason?: string }`, because the
 * reason is never actually optional: every refusal carries one. Typing it as
 * optional pushed a dead fallback onto callers for a branch that cannot
 * happen, and let one of them render an empty notice box.
 *
 * Deliberately shorter than the message a feature gives when it refuses an
 * action: this explains a missing control, that explains a refused request.
 */
export type FeatureSupport =
  | { supported: true; reason?: undefined }
  | { supported: false; reason: string };

export type DialectFeatureSupport = Record<DialectFeature, FeatureSupport>;

/**
 * Reasons no other module owns.
 *
 * Everything absent here is derived below, and its reason comes from whichever
 * module already answers that question — `userManagementSupport` most of all,
 * which has carried a per-engine reason since long before this file.
 */
const DECLARED: Record<string, Partial<Record<DialectFeature, string>>> = {
  // Three different reasons an engine has no permission builder, and they must
  // not be collapsed. Deriving the flag but guessing one sentence for all of
  // them told SQLite users that Fox Schema was missing a feature, which implies
  // one could be built — the same inversion this table exists to prevent, just
  // pointing the other way.
  clickhouse: {
    // ClickHouse really does have GRANT: `GRANT SELECT ON default.* TO user`
    // was accepted by a live server. Fox Schema is the gap here.
    dbAccess: 'Fox Schema has no permission builder for ClickHouse yet.',
    // The SQL Editor adapter is deliberately read-write for SQLite but not for
    // ClickHouse — see the acquire() comments in each adapter.
    rowEditing: 'The SQL Editor adapter rejects writes for ClickHouse.',
  },
  // These two have no grants at all; the file's permissions are the access
  // control. Nothing to build, so the engine is the honest answer.
  sqlite: {
    dbAccess: 'SQLite has no grants — the file’s permissions are the access control.',
  },
  duckdb: {
    dbAccess: 'DuckDB has no grants — the file’s permissions are the access control.',
  },
  // Their schemaCompare reasons live with that check, in schema-compare.ts.
  redis: {
    commandMode: 'Redis does not take SQL, so there is nothing to hand to a client.',
  },
  mongodb: {
    commandMode: 'MongoDB does not take SQL, so there is nothing to hand to a client.',
  },
};

function support(supported: boolean, reason: () => string | undefined): FeatureSupport {
  if (supported) return { supported: true };
  return { supported: false, reason: reason() ?? '' };
}

function buildFeatures(key: string): DialectFeatureSupport {
  const declared = DECLARED[key] ?? {};
  const say = (feature: DialectFeature, otherwise?: string) =>
    declared[feature] ?? otherwise ?? fallbackReason(key, feature);

  return Object.freeze({
    // Exactly the engines with a SQL dialect. The light check the Compare
    // button uses, so the button and this table give one answer.
    schemaCompare: schemaCompareSupport(key),
    // Redis and MongoDB have permissions that are simply not SQL, and the
    // access module already words that — including the tool to use. Everything
    // else says so above, because who is at fault differs per engine and a
    // guess gets it wrong for someone.
    dbAccess: support(supportsAccessBuilder(key), () =>
      say('dbAccess', nonSqlPermissionsReason(key))
    ),
    // This one already carries its own per-engine wording.
    userManagement: support(userManagementSupport(key).supported, () =>
      say('userManagement', userManagementSupport(key).reason)
    ),
    commandMode: support(supportsCommandMode(key), () => say('commandMode')),
    // Nothing else owns this, so it is declared here and read from here.
    rowEditing: support(!declared.rowEditing, () => declared.rowEditing),
  });
}

/**
 * Built once per engine and shared, because the answer is static and one
 * caller sits in a component that re-renders on every checkbox. Frozen so the
 * sharing is safe by construction rather than by everyone happening to read.
 *
 * Only known engines are cached: an unknown one puts its own name in the
 * reason, so its record cannot be shared, and caching would grow without
 * bound on arbitrary input.
 */
const CACHE = new Map<string, DialectFeatureSupport>();

function unknownFeatures(dialect: string): DialectFeatureSupport {
  const out = {} as DialectFeatureSupport;
  for (const feature of DIALECT_FEATURES) {
    out[feature] = { supported: false, reason: unknownEngineReason(dialect, feature) };
  }
  return Object.freeze(out);
}

/** Every feature answer for one engine. Unknown engines support nothing. */
export function dialectFeatures(dialect: string): DialectFeatureSupport {
  const key = (dialect || '').toLowerCase();
  if (!isKnownEngine(key)) return unknownFeatures(dialect);
  const cached = CACHE.get(key);
  if (cached) return cached;
  const built = buildFeatures(key);
  CACHE.set(key, built);
  return built;
}

/** Whether one feature is available, for a caller that needs only the flag. */
export function supportsDialectFeature(dialect: string, feature: DialectFeature): boolean {
  return dialectFeatures(dialect)[feature].supported;
}

/** Why a feature is unavailable, or undefined when it is available. */
export function dialectFeatureReason(
  dialect: string,
  feature: DialectFeature
): string | undefined {
  return dialectFeatures(dialect)[feature].reason;
}

/** Engines this answers for, which is every engine a connection can use. */
export function knownDialects(): string[] {
  return Object.keys(PROVIDER_SETTINGS).sort();
}
