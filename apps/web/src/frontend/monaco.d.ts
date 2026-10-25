/**
 * Module declarations for monaco's deep entry points.
 *
 * The specifiers carry no `esm/vs/` prefix: monaco 0.56 added an `exports` map
 * whose `"./*": "./esm/vs/*.js"` rule prepends that itself, so the old
 * `monaco-editor/esm/vs/editor/editor.api` now resolves to
 * `esm/vs/esm/vs/editor/editor.api.js` and fails to build.
 */
// monaco-editor's deep ESM subpaths aren't mapped in its type exports; declare them.
declare module 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
declare module 'monaco-editor/editor/editor.api' {
  export * from 'monaco-editor';
}
declare module 'monaco-editor/languages/definitions/sql/register';
declare module 'monaco-editor/languages/definitions/pgsql/register';
declare module 'monaco-editor/languages/definitions/mysql/register';
declare module 'monaco-editor/languages/definitions/javascript/register';
declare module 'monaco-editor/languages/definitions/typescript/register';
declare module 'monaco-editor/languages/definitions/sql/sql' {
  import type { languages } from 'monaco-editor';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
