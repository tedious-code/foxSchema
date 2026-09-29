import { defaultExclude, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const aliases = [
  { find: /^@\//, replacement: pkg('./apps/web/src/frontend/') },
  { find: '@foxschema/sql', replacement: pkg('./packages/sql/src/index.ts') },
  { find: '@foxschema/db/mail', replacement: pkg('./packages/db/src/mail/smtp.ts') },
  { find: /^@foxschema\/db$/, replacement: pkg('./packages/db/src/index.ts') },
  { find: '@foxschema/shared', replacement: pkg('./packages/shared/src/index.ts') },
  { find: '@foxschema/server', replacement: pkg('./packages/server/src/index.ts') },
  {
    find: '@foxschema/workflow-contract',
    replacement: pkg('./packages/workflow-contract/src/index.ts'),
  },
  {
    find: '@foxschema/workflow-engine/definitions',
    replacement: pkg('./packages/workflow-engine/src/definitions.ts'),
  },
  {
    find: /^@foxschema\/workflow-engine$/,
    replacement: pkg('./packages/workflow-engine/src/index.ts'),
  },
];

// Root test runner for the whole workspace. CLI Ink TUI screens are isolated in
// their own project with fileParallelism off — under full-suite parallel load,
// ink-text-input / SelectInput stdin races flake even when the same tests pass
// in isolation (see apps/cli/src/tui/__tests__/README.md).
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: [
      {
        resolve: { alias: aliases },
        test: {
          name: 'unit',
          include: [
            'packages/**/*.test.ts',
            'apps/web/**/*.test.ts',
            'apps/workflow-server/**/*.test.ts',
            'apps/cli/src/**/*.test.ts',
            // The browser suites need a running app; their pure helpers do not.
            'apps/e2e/src/helpers/**/*.test.ts',
            'scripts/security/**/*.test.mjs',
          ],
          // `exclude` REPLACES vitest's defaults, it does not add to them — so
          // listing the TUI here silently dropped `**/node_modules/**` too.
          // That went unnoticed only because zod happened to hoist to the root,
          // outside these include globs. The moment the lockfile was
          // regenerated and npm nested each workspace's pinned zod under
          // `apps/web/node_modules` and friends, this project started
          // collecting zod's own test suite: 407 test files became 912, and
          // nine of them failed.
          exclude: [...defaultExclude, 'apps/cli/src/tui/**'],
          // Workflow file pipes are confined to FOXFLOW_FILES_DIR. The suites
          // build their fixtures under the OS temp dir, so that is the root
          // here; the confinement itself is tested with its own roots.
          //
          // `tmpdir()` as the suites spell it, not its real path. On macOS it
          // is `/var/folders/…`, a symlink to `/private/var/folders/…`; with the
          // resolved spelling as the root, every fixture path failed the
          // lexical half of the containment check and 41 workflow tests failed
          // on every Mac (CI runs Linux, where /tmp is not a link). The real-path
          // half resolves both sides itself.
          env: { FOXFLOW_FILES_DIR: tmpdir() },
          testTimeout: 15_000,
        },
      },
      {
        // React components, in jsdom. Kept as its own project so the default
        // `unit` run stays a pure-node suite — component tests need a DOM,
        // which is an order of magnitude slower to spin up per file.
        //
        // **Do not set `pool: 'vmThreads'` here.** Vitest suggests it on every
        // run of this project, and it does what it says — 17.49s -> 5.98s, by
        // building jsdom once per worker instead of once per file. It also
        // makes the suite flaky: `SqlPipeEditor.test.tsx` failed on roughly one
        // run in three under it, and passed 4/4 without. These files mock
        // heavily with `vi.mock`, and vmThreads shares the module registry
        // across files in a worker, so the mocks bleed between them.
        //
        // The eleven seconds are not worth a suite people learn to re-run.
        // Making it work means auditing mock isolation across all 41 files,
        // which is its own piece of work.
        resolve: { alias: aliases },
        test: {
          name: 'web-ui',
          include: ['apps/web/src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./apps/web/src/frontend/test/setup.ts'],
          testTimeout: 15_000,
        },
      },
      {
        resolve: { alias: aliases },
        test: {
          name: 'cli-tui',
          include: ['apps/cli/src/tui/**/*.test.{ts,tsx}'],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
