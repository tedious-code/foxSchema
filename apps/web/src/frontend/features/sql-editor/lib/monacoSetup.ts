// Self-host Monaco from the bundled package instead of the default CDN loader,
// so the editor works in offline / firewalled enterprise networks.
import { loader } from '@monaco-editor/react';
// Import only the editor core + the SQL dialects we use, not all ~90 languages
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/pgsql/register';
import 'monaco-editor/languages/definitions/mysql/register';
// The Workflow designer's script pipe. The tokenizer loads on first use.
import 'monaco-editor/languages/definitions/javascript/register';
// JSON (the Workflow designer's config editors) validates in its own worker.
import 'monaco-editor/languages/features/json/register';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import { FOXSCHEMA_SQL_LANG, FOXSCRIPT_LANG } from '@/features/sql-editor/lib/foxschemaSqlLanguage';
import { dialectFamily } from '@foxschema/ui-shared';

// SQL highlighting runs on the main thread (basic-languages); only JSON needs a
// language worker — everything else uses the core editor worker.
self.MonacoEnvironment = {
  getWorker: (_workerId, label) => (label === 'json' ? new jsonWorker() : new editorWorker()),
};

loader.config({ monaco });

/** Diff highlight color per object status — same hue for inserted/removed regions,
 * since a diff pane's "add" vs "remove" is relative to which side you're reading,
 * not a fixed direction. The color instead signals what the migration will DO:
 * green = brand-new object, amber = an existing object's definition changed,
 * red = the object is being dropped. */
const DIFF_HUE: Record<'ADDED' | 'MODIFIED' | 'REMOVED', string> = {
  ADDED: '#22c55e', // green-500
  MODIFIED: '#f59e0b', // amber-500
  REMOVED: '#ef4444', // red-500
};

function diffColors(hex: string, dark: boolean) {
  return {
    'diffEditor.insertedTextBackground': `${hex}${dark ? '22' : '2e'}`,
    'diffEditor.removedTextBackground': `${hex}${dark ? '22' : '2e'}`,
    'diffEditor.insertedLineBackground': `${hex}${dark ? '18' : '22'}`,
    'diffEditor.removedLineBackground': `${hex}${dark ? '18' : '22'}`,
  };
}

const BASE_DARK_COLORS = {
  'editor.background': '#020617',
  'editor.foreground': '#cbd5e1',
  'editorCursor.foreground': '#22d3ee',
  'editor.lineHighlightBackground': '#0f172a',
  'editorLineNumber.foreground': '#334155',
  'editorGutter.background': '#020617',
};

const BASE_LIGHT_COLORS = {
  'editor.background': '#ffffff',
  'editor.foreground': '#1e293b',
  'editorCursor.foreground': '#0891b2',
  'editor.lineHighlightBackground': '#f1f5f9',
  'editorLineNumber.foreground': '#94a3b8',
  'editorGutter.background': '#ffffff',
};

/** Shared token colors so SQL keywords / strings / numbers read clearly. */
const TOKEN_RULES_DARK: monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '64748b' },
  { token: 'comment.fence', foreground: '94a3b8', fontStyle: 'bold' },
  { token: 'keyword', foreground: '22d3ee' },
  { token: 'operator', foreground: '94a3b8' },
  { token: 'number', foreground: 'fbbf24' },
  { token: 'string', foreground: '34d399' },
  { token: 'predefined', foreground: 'a78bfa' },
  { token: 'identifier', foreground: 'e2e8f0' },
  { token: 'delimiter', foreground: '94a3b8' },
  // FoxScript semantic tokens (tables / columns from schema cache)
  { token: 'type', foreground: '67e8f9' },
  { token: 'property', foreground: 'fcd34d' },
];

const TOKEN_RULES_LIGHT: monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '64748b' },
  { token: 'comment.fence', foreground: '475569', fontStyle: 'bold' },
  { token: 'keyword', foreground: '0891b2' },
  { token: 'operator', foreground: '64748b' },
  { token: 'number', foreground: 'b45309' },
  { token: 'string', foreground: '047857' },
  { token: 'predefined', foreground: '7c3aed' },
  { token: 'identifier', foreground: '0f172a' },
  { token: 'delimiter', foreground: '64748b' },
  { token: 'type', foreground: '0e7490' },
  { token: 'property', foreground: 'a16207' },
];

/** Shared dark theme tuned to the app's slate palette — default/MODIFIED variant. */
export const MONACO_THEME = 'schemaSyncDark';
/** Light counterpart, used when the app theme resolves to light. */
export const MONACO_THEME_LIGHT = 'schemaSyncLight';

monaco.editor.defineTheme(MONACO_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: TOKEN_RULES_DARK,
  colors: { ...BASE_DARK_COLORS, ...diffColors(DIFF_HUE.MODIFIED, true) },
});

monaco.editor.defineTheme(MONACO_THEME_LIGHT, {
  base: 'vs',
  inherit: true,
  rules: TOKEN_RULES_LIGHT,
  colors: { ...BASE_LIGHT_COLORS, ...diffColors(DIFF_HUE.MODIFIED, false) },
});

/** Status-specific diff themes — one per object status, dark + light. */
export const MONACO_DIFF_THEME: Record<'ADDED' | 'MODIFIED' | 'REMOVED', string> = {
  ADDED: 'schemaSyncDiffAddedDark',
  MODIFIED: MONACO_THEME,
  REMOVED: 'schemaSyncDiffRemovedDark',
};

export const MONACO_DIFF_THEME_LIGHT: Record<'ADDED' | 'MODIFIED' | 'REMOVED', string> = {
  ADDED: 'schemaSyncDiffAddedLight',
  MODIFIED: MONACO_THEME_LIGHT,
  REMOVED: 'schemaSyncDiffRemovedLight',
};

monaco.editor.defineTheme(MONACO_DIFF_THEME.ADDED, {
  base: 'vs-dark',
  inherit: true,
  rules: TOKEN_RULES_DARK,
  colors: { ...BASE_DARK_COLORS, ...diffColors(DIFF_HUE.ADDED, true) },
});
monaco.editor.defineTheme(MONACO_DIFF_THEME_LIGHT.ADDED, {
  base: 'vs',
  inherit: true,
  rules: TOKEN_RULES_LIGHT,
  colors: { ...BASE_LIGHT_COLORS, ...diffColors(DIFF_HUE.ADDED, false) },
});
monaco.editor.defineTheme(MONACO_DIFF_THEME.REMOVED, {
  base: 'vs-dark',
  inherit: true,
  rules: TOKEN_RULES_DARK,
  colors: { ...BASE_DARK_COLORS, ...diffColors(DIFF_HUE.REMOVED, true) },
});
monaco.editor.defineTheme(MONACO_DIFF_THEME_LIGHT.REMOVED, {
  base: 'vs',
  inherit: true,
  rules: TOKEN_RULES_LIGHT,
  colors: { ...BASE_LIGHT_COLORS, ...diffColors(DIFF_HUE.REMOVED, false) },
});

/** Shared Monaco editor defaults (DDL viewer + SQL Editor pane). */
export const MONACO_EDITOR_BASE_OPTIONS = {
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  lineNumbersMinChars: 3,
  scrollbar: { alwaysConsumeMouseWheel: false },
  padding: { top: 8, bottom: 8 },
  // Without this Monaco can render blank inside flex layouts.
  automaticLayout: true,
} as const;

/**
 * Map an app dialect to a Monaco language id.
 * SQL Editor upgrades to {@link FOXSCRIPT_LANG} (or legacy
 * {@link FOXSCHEMA_SQL_LANG}) after lazy registration.
 */
export function monacoLanguage(dialect: string): string {
  // Wire-compatible relatives get their family's grammar rather than the
  // generic one: MariaDB and TiDB speak MySQL, and CockroachDB, YugabyteDB
  // and Redshift speak PostgreSQL. Falling through to plain `sql` cost them
  // backtick and dollar-quote handling for no reason.
  switch (dialectFamily(dialect)) {
    case 'mysql':
      return 'mysql';
    case 'postgres':
      return 'pgsql';
    default:
      return 'sql';
  }
}

export { FOXSCHEMA_SQL_LANG, FOXSCRIPT_LANG };
