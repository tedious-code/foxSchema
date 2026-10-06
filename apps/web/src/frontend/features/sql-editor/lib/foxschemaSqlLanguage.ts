import type * as Monaco from 'monaco-editor/editor/editor.api';

/** Legacy id — kept for compatibility with existing completions / themes. */
export const FOXSCHEMA_SQL_LANG = 'foxschema-sql';

/** FoxScript document language (SQL-first + embedded code cells). */
export const FOXSCRIPT_LANG = 'foxscript';

/** Module-local flag — do NOT write onto the `monaco` namespace (ESM exports are non-extensible). */
let foxschemaSqlLanguageReady = false;

type MonarchLang = Monaco.languages.IMonarchLanguage;

const FENCE_END_RULE: Monaco.languages.IMonarchLanguageRule = [
  // String form + `@@` so Monarch treats `@` as literal (not an attribute ref).
  '^[ \\t]*--[ \\t]*@@end[ \\t]*$',
  { token: 'comment.fence', next: '@pop', nextEmbedded: '@pop' },
];

const EMBEDDED_BODY: Monaco.languages.IMonarchLanguageRule[] = [
  FENCE_END_RULE,
  [/.*$/, ''],
];

function registerLanguageId(monaco: typeof Monaco, id: string, aliases: string[]): void {
  if (!monaco.languages.getLanguages().some((l) => l.id === id)) {
    monaco.languages.register({ id, aliases });
  }
}

function applyMonarch(
  monaco: typeof Monaco,
  id: string,
  sqlConf: Monaco.languages.LanguageConfiguration,
  sqlLanguage: MonarchLang
): void {
  monaco.languages.setLanguageConfiguration(id, sqlConf);
  const base = sqlLanguage;
  const tokenizer = { ...(base.tokenizer ?? {}) } as MonarchLang['tokenizer'] &
    Record<string, Monaco.languages.IMonarchLanguageRule[]>;
  const root = [...(tokenizer.root ?? [])];

  monaco.languages.setMonarchTokensProvider(id, {
    ...base,
    tokenizer: {
      ...tokenizer,
      root: [
        [
          '^[ \\t]*--[ \\t]*@@(?:node-typescript|node-ts|nodets|typescript|ts)[ \\t]*$',
          {
            token: 'comment.fence',
            next: '@tsEmbedded',
            nextEmbedded: 'text/typescript',
          },
        ],
        [
          '^[ \\t]*--[ \\t]*@@(?:javascript|js|node)[ \\t]*$',
          {
            token: 'comment.fence',
            next: '@jsEmbedded',
            nextEmbedded: 'text/javascript',
          },
        ],
        ...root,
      ],
      jsEmbedded: EMBEDDED_BODY,
      tsEmbedded: EMBEDDED_BODY,
    },
  });
}

/**
 * Register `foxscript` + `foxschema-sql`: SQL highlighting with JavaScript /
 * TypeScript embedded inside `-- @js` / `-- @ts` / `-- @node` / `-- @nodets`
 * … `-- @end`. Prefer `foxscript` as the editor model language going forward.
 */
export async function ensureFoxschemaSqlLanguage(
  monaco: typeof Monaco
): Promise<boolean> {
  if (foxschemaSqlLanguageReady) return true;

  try {
    // javascript/register is already loaded: monaco-setup imports it statically.
    await import('monaco-editor/languages/definitions/typescript/register');
    const { conf: sqlConf, language: sqlLanguage } = await import(
      'monaco-editor/languages/definitions/sql/sql'
    );

    registerLanguageId(monaco, FOXSCHEMA_SQL_LANG, ['FoxSchema SQL']);
    registerLanguageId(monaco, FOXSCRIPT_LANG, ['FoxScript']);
    applyMonarch(monaco, FOXSCHEMA_SQL_LANG, sqlConf, sqlLanguage as MonarchLang);
    applyMonarch(monaco, FOXSCRIPT_LANG, sqlConf, sqlLanguage as MonarchLang);

    foxschemaSqlLanguageReady = true;
    return true;
  } catch (err) {
    console.warn('[foxschema-sql] code-cell highlighting unavailable', err);
    return false;
  }
}
