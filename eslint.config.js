import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // ── A suppression that suppresses nothing is a lie about the code ───────────
  // Five had accumulated, three of them for rules that were never installed —
  // so they read as "this line is known-unsafe, deliberately" while ESLint was
  // silently ignoring them. This makes a stale one an error the moment the code
  // under it stops needing it.
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },

  // ── Global ignores ──────────────────────────────────────────────────────────
  {
    ignores: [
      '**/dist/**',
      '**/dist-bin/**',
      '**/node_modules/**',
      // Build outputs under other names (bundles for npm and the CLI's UI copy).
      // CI never has them, so they only slowed a local `npm run lint`: apps/cli
      // alone took 35 s instead of 1 s, and the full run seemed to hang.
      '**/npm-pack/**',
      '**/ui-dist/**',
      '**/.turbo/**',
      // Agent worktrees are whole checkouts of this repo (gitignored). Linting
      // them reports every finding twice, against code that may be days old.
      '.claude/**',
    ],
  },

  // ── Security-focused rules for all TypeScript source ────────────────────────
  // We intentionally use only the TypeScript parser (for syntax support) but do
  // NOT enable tseslint.configs.recommended — those 200+ quality rules generate
  // hundreds of pre-existing false positives (no-explicit-any, no-unused-vars)
  // that drown out real security findings. Quality rules can be added separately
  // once the codebase has been incrementally cleaned up.
  {
    // `.mjs`/`.mts` are in scope too. They were not, which meant the publish
    // scripts and the node_modules security scanner — the one file in the repo
    // whose whole job is reading untrusted third-party source — were never
    // linted at all, and a dead `verify-providers.mts` importing a package
    // deleted months ago sat at the repo root without anything noticing.
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.mjs'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      security,
    },
    rules: {
      // Execution of child processes with non-literal arguments — command injection risk.
      'security/detect-child-process': 'error',

      // eval() or Function() called with an expression — arbitrary code execution.
      'security/detect-eval-with-expression': 'error',

      // Regex patterns vulnerable to catastrophic backtracking (ReDoS).
      'security/detect-unsafe-regex': 'error',

      // fs functions called with a variable path — the path-traversal rule.
      //
      // This is an 'error' now. It used to be a 'warn' with a note saying to
      // promote it "once all sites have been reviewed", which never happened:
      // it sat at 208 warnings, which meant `npm run lint:security`
      // (--max-warnings 0) could not pass and CI ran plain `eslint .` instead.
      // A gate nobody can pass is not a gate.
      //
      // The 208 were reviewed. Every remaining production site carries an
      // inline disable naming why its path is not attacker-controlled, in the
      // form `-- <reason>`; the blocks below switch the rule off where it
      // cannot mean anything. What is left is real: a new fs call on a path the
      // caller influences now fails the build.
      'security/detect-non-literal-fs-filename': 'error',

      // detect-object-injection deliberately omitted: fires on every obj[key] access,
      // which is ubiquitous in the dialect registry and diff iteration code.
    },
  },

  // ── Where the fs-path rule cannot mean anything ─────────────────────────────
  // The rule exists to catch a path an attacker can steer. These three groups
  // have no such caller, and suppressing ~139 sites one by one would bury the
  // ~30 justifications that do carry information.
  {
    // Tests build paths from fixtures and temp dirs they just created. 133 of
    // the original 208 warnings were here.
    files: [
      '**/*.test.{ts,tsx,mts,mjs}',
      '**/*.spec.{ts,tsx,mts,mjs}',
      '**/__tests__/**',
      '**/test/**',
      'apps/e2e/**',
    ],
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },
  {
    // Build, release and verification tooling, run by a maintainer on their own
    // machine against paths they passed in. `**/scripts/**` catches the
    // per-package publish scripts (`packages/*/scripts/prepare-publish.mjs`).
    files: ['scripts/**', '**/scripts/**', '**/*.mts'],
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },
  {
    // The CLI's whole job is acting on paths the person running it typed:
    // snapshot targets, driver install locations, desktop shortcut paths. There
    // is no privilege boundary between the caller and the filesystem — it is
    // their shell and their files. Flagging that is flagging the product.
    //
    // This is *not* true of packages/server, which takes paths over HTTP. That
    // stays enforced.
    files: ['apps/cli/**'],
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },

  // ── React hooks ─────────────────────────────────────────────────────────────
  // Two files carried `eslint-disable-next-line react-hooks/exhaustive-deps`
  // comments for a rule that was never installed, so ESLint errored on the
  // disable comment itself — and hooks were never actually linted. A
  // rules-of-hooks violation has crashed this app before (see CLAUDE.md), so
  // that one is an error; exhaustive-deps stays a warning because blindly
  // satisfying it can change behaviour and each site needs a human decision.
  {
    files: ['apps/web/src/frontend/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
