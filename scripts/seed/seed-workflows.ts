#!/usr/bin/env node
/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Seed all built-in workflow samples directly into workflow-engine.sqlite.
 * Usage: npm run seed:workflows [-- --force]
 */
import { resolveDatabasePath } from '../../packages/workflow-engine/src/storage/database-path.js';
import { openSqliteStores } from '../../packages/workflow-engine/src/storage/index.js';
import { keyFromEnv, parseWorkflowInput } from '../../packages/workflow-engine/src/index.js';
import { WORKFLOW_SAMPLES } from '../../apps/web/src/frontend/features/workflow/lib/workflowSamples.js';

async function seed() {
  const dbPath = resolveDatabasePath();
  const force = process.argv.includes('--force');
  console.log(`▶ Seeding ${WORKFLOW_SAMPLES.length} workflow samples into ${dbPath} (force: ${force}) …`);
  const stores = openSqliteStores(dbPath, keyFromEnv());

  const existingSummaries = await stores.workflows.summaries();
  const existingIds = new Set(existingSummaries.map((s) => s.id));

  for (const sample of WORKFLOW_SAMPLES) {
    if (existingIds.has(sample.id) && !force) {
      console.log(`  - ${sample.id} (already exists, skipping; use --force to overwrite)`);
      continue;
    }
    const def = parseWorkflowInput(sample.document);
    await stores.workflows.put(def);
    console.log(`  ✓ ${def.id} ("${def.name}")`);
  }

  const summaries = await stores.workflows.summaries();
  console.log(`\n✓ Done! ${summaries.length} workflows now stored in ${dbPath}.\n`);
  stores.close();
}

seed().catch((error) => {
  console.error('Failed to seed workflow samples:', error);
  process.exit(1);
});
