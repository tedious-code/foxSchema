/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * How a schema migration run ended, as run history stores it and the app,
 * the CLI and the server read it. One definition: the server and the web app
 * each kept their own copy of this union.
 */
export const MIGRATION_RUN_STATUSES = ['RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'ROLLED_BACK'] as const;

/** PARTIAL_SUCCESS: committed, but continueOnError skipped one or more failed objects. */
export type MigrationRunStatus = (typeof MIGRATION_RUN_STATUSES)[number];
