/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — turn two hydrated snapshots into reverse DDL.
 *
 * Classification (`planReversal`) decides whether a revert is safe to offer.
 * This module is the next step: Compare treats the *target version* as the
 * desired schema and the *current head* as the live database, then the SQL
 * generator emits the DROP / ALTER / CREATE statements that close the gap.
 */
import type { TableSchema } from '@foxschema/sql';
import type { SchemaCompareResult } from '@foxschema/sql';
import { CompareModule } from '@foxschema/sql';
import {
  SqlGeneratorModule,
  type MigrationStep,
  type SchemaMapping,
} from '@foxschema/sql';

export interface RevertMigration {
  steps: MigrationStep[];
  statements: string[];
}

/**
 * Turn an already-computed comparison into migration steps.
 *
 * Split out so a caller holding a `SchemaCompareResult` — the Lokee revert
 * planner does, having just compared two stored versions — does not run the
 * comparison a second time just to reach the generator.
 */
export function migrationFromCompare(
  result: SchemaCompareResult,
  dialect: string,
  mapping?: SchemaMapping
): RevertMigration {
  const gen = new SqlGeneratorModule();
  const diffs = result.tables.filter((t) => t.status !== 'UNCHANGED');
  const steps = gen.generateMigrationPlan(diffs, dialect, mapping, result.tables);
  return { steps, statements: steps.flatMap((step) => (step.skipped ? [] : step.statements)) };
}

/**
 * Build the migration that moves `currentTables` (live / head) back to
 * `targetTables` (the version the user picked).
 */
export async function buildRevertMigration(
  currentTables: TableSchema[],
  targetTables: TableSchema[],
  dialect: string,
  mapping?: SchemaMapping
): Promise<RevertMigration> {
  const compare = new CompareModule();
  const schema = mapping?.targetSchema ?? mapping?.sourceSchema;
  const result = await compare.compare(
    targetTables,
    currentTables,
    { source: dialect, target: dialect },
    schema ? { source: schema, target: schema } : undefined
  );
  return migrationFromCompare(result, dialect, mapping);
}
