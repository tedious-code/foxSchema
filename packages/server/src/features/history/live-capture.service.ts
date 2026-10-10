/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Capture a database's whole live schema as a history version. Migrate
 * captures before and after it runs, revert after it applies; both must go
 * through the same store, whose per-database lock keeps two captures from
 * forking the history.
 */
import type { ConnectionOptions } from '@foxschema/db';
import type { WorkspaceScope } from '../../platform/http/scope';
import type { ConnectionResolver } from '../../platform/connections/resolve';
import type { LokeeWeaveStore } from './lokee-weave.service';
import { LOKEE_FULL_SCOPE } from './lokee-scope';

export type CaptureSource = 'manual' | 'migrate' | 'revert' | 'force-migrate';

export type CaptureLiveSchema = (
  scope: WorkspaceScope,
  resolved: { dialect: string; option: ConnectionOptions; schema: string },
  source: CaptureSource,
  extra?: {
    migrationRunId?: string;
    revert?: { fromVersionId: string; toVersionId: string };
    appliedFrom?: { databaseId: string; versionId: string };
  }
) => ReturnType<LokeeWeaveStore['capture']>;

/**
 * Capture reads the *whole* schema regardless of the compare scope in use: a
 * version covering only the objects someone happened to compare would be a
 * snapshot you cannot safely revert to.
 */
export function makeCaptureLiveSchema(
  lokee: LokeeWeaveStore,
  loadScopedTables: ConnectionResolver['loadScopedTables']
): CaptureLiveSchema {
  return async (scope, resolved, source, extra) => {
    const { tables } = await loadScopedTables(resolved.dialect, resolved.option, resolved.schema ?? '', LOKEE_FULL_SCOPE);
    return lokee.capture(scope, {
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
  };
}
