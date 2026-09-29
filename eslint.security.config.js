/**
 * Security-only lint pass. `npm run lint:security`.
 *
 * The main config (`eslint.config.js`) carries the security rules *and* code
 * quality rules, and quality findings are warnings — a deliberate choice, since
 * blindly satisfying `react-hooks/exhaustive-deps` can change behaviour and each
 * site needs a human. That left `lint:security` (`eslint . --max-warnings 0`)
 * unable to pass: it counted those advisories too, sat at 230 warnings, and CI
 * quietly ran plain `eslint .` instead. `docs/security/security-process.md` has
 * described it as "zero warnings (same as CI)" the whole time. None of that was
 * true.
 *
 * This config exists so the claim can be. It runs the security rules and
 * nothing else, at zero tolerance, over the same files. A finding here is a
 * security finding, and the run is green or it is not.
 *
 * The rules are intentionally duplicated from `eslint.config.js` rather than
 * imported from it: that file's shape (parser blocks, per-area overrides) is
 * about quality as much as security, and coupling the two means a quality
 * refactor can silently change what the security gate covers.
 * `security-config-parity.test.ts` checks the two lists have not drifted.
 */
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import reactHooks from 'eslint-plugin-react-hooks';

/** The security rules, and the severity each runs at. Keep in sync with eslint.config.js. */
export const SECURITY_RULES = {
  'security/detect-child-process': 'error',
  'security/detect-eval-with-expression': 'error',
  'security/detect-unsafe-regex': 'error',
  'security/detect-non-literal-fs-filename': 'error',
};

export default tseslint.config(
  // Deliberately NOT `reportUnusedDisableDirectives` here, unlike the main
  // config. This pass runs a subset of the rules, so every legitimate
  // `eslint-disable-next-line react-hooks/exhaustive-deps` in the tree would be
  // reported as unused — 21 false errors, all of them about a rule this config
  // does not run. Dead directives are the main config's job.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },

  // `.claude/**`: agent worktrees are whole checkouts of this repo (gitignored).
  { ignores: ['**/dist/**', '**/dist-bin/**', '**/node_modules/**', '.claude/**'] },

  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.mjs'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin, security },
    rules: SECURITY_RULES,
  },

  // The same three groups the main config exempts from the fs-path rule, for
  // the same reason: none of them has a caller on the other side of a trust
  // boundary. See eslint.config.js for the full rationale.
  {
    files: [
      '**/*.test.{ts,tsx,mts,mjs}',
      '**/*.spec.{ts,tsx,mts,mjs}',
      '**/__tests__/**',
      '**/test/**',
      'apps/e2e/**',
      'scripts/**',
      // `packages/*/scripts/prepare-publish.mjs` — publish tooling, same class
      // as `scripts/`. This config lints .mjs, which the main one does not, so
      // these had never been seen before.
      '**/scripts/**',
      '**/*.mts',
      'apps/cli/**',
    ],
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },

  // The react-hooks plugin is registered, with every rule off, purely so the
  // `eslint-disable-next-line react-hooks/exhaustive-deps` comments the frontend
  // legitimately carries resolve to a known rule. Without this, ESLint reports
  // "Definition for rule ... was not found" and this pass fails on 19 comments
  // that have nothing to do with security.
  {
    files: ['apps/web/src/frontend/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/exhaustive-deps': 'off', 'react-hooks/rules-of-hooks': 'off' },
  },
);
