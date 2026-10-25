import type * as Monaco from 'monaco-editor/editor/editor.api';
import { extractTableAliases } from '@/shared/lib/sql-splitter';
import { suggestTableAlias } from '@/features/sql-editor/lib/selectClauseEdit';
import { projectToVirtualDoc } from '@/features/sql-editor/lib/foxscriptVirtualDocs';
import { filterCallParameters, getCompletionContext } from './sqlEditorBridge';
import {
  buildSchemaTries,
  schemaRevision,
  trieCollect,
  type SchemaTrieBundle,
} from './completionTrie';

const LIGHT_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL',
  'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS', 'NULL',
  'GROUP', 'BY', 'ORDER', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'HAVING', 'UNION',
  'ALL', 'DISTINCT', 'AS', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'ALTER', 'DROP', 'TABLE', 'VIEW', 'INDEX', 'WITH', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'CALL', 'EXECUTE', 'EXEC',
];

const LANG_IDS = ['sql', 'pgsql', 'mysql', 'foxschema-sql', 'foxscript'] as const;

/**
 * Where the caret is in a SELECT, so the popup can offer the next kind of name.
 *
 * `table` — after FROM or JOIN, the list is tables (each with an alias).
 * `join-modifier` — after LEFT / RIGHT / INNER / OUTER, the next word is JOIN.
 * `expression` — after ON, WHERE, AND, OR, HAVING, or in the select list:
 * columns already in the query, written `alias.column`, plus common functions.
 */
type CompletionSlot = 'table' | 'join-modifier' | 'expression' | 'other';

/**
 * Clause keyword → the slot it opens. One table drives all three uses: the
 * set of words {@link withoutPartialIdent} keeps, the scan regex, and the
 * slot lookup — so a new keyword is added in exactly one place.
 */
const SLOT_BY_WORD: Record<string, CompletionSlot> = {
  SELECT: 'expression', ON: 'expression', WHERE: 'expression', HAVING: 'expression',
  AND: 'expression', OR: 'expression', GROUP: 'expression', ORDER: 'expression',
  FROM: 'table', JOIN: 'table', INTO: 'table', UPDATE: 'table',
  LEFT: 'join-modifier', RIGHT: 'join-modifier', FULL: 'join-modifier',
  INNER: 'join-modifier', CROSS: 'join-modifier', OUTER: 'join-modifier',
  LIMIT: 'other', OFFSET: 'other', UNION: 'other', SET: 'other', VALUES: 'other',
};

const SLOT_WORDS = new Set(Object.keys(SLOT_BY_WORD));

/** Built once, not per keystroke. `lastIndex` is reset before every scan. */
const SLOT_RE = new RegExp(`\\b(${[...SLOT_WORDS].join('|')})\\b`, 'gi');

/** A space after one of these opens the popup without Ctrl+Space. */
const AUTO_OPEN = new Set([
  'FROM', 'JOIN', 'ON', 'WHERE', 'AND', 'OR', 'HAVING',
  'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'OUTER',
  '=',
]);

const COMMON_SQL_FUNCTIONS: { name: string; snippet: string; detail: string }[] = [
  { name: 'COUNT', snippet: 'COUNT(${1:*})', detail: 'count rows or values' },
  { name: 'SUM', snippet: 'SUM(${1:expr})', detail: 'sum' },
  { name: 'AVG', snippet: 'AVG(${1:expr})', detail: 'average' },
  { name: 'MIN', snippet: 'MIN(${1:expr})', detail: 'minimum' },
  { name: 'MAX', snippet: 'MAX(${1:expr})', detail: 'maximum' },
  { name: 'COALESCE', snippet: 'COALESCE(${1:expr}, ${2:fallback})', detail: 'first non-null' },
  { name: 'NULLIF', snippet: 'NULLIF(${1:expr}, ${2:value})', detail: 'null when equal' },
  { name: 'UPPER', snippet: 'UPPER(${1:expr})', detail: 'uppercase' },
  { name: 'LOWER', snippet: 'LOWER(${1:expr})', detail: 'lowercase' },
  { name: 'TRIM', snippet: 'TRIM(${1:expr})', detail: 'trim spaces' },
  { name: 'LENGTH', snippet: 'LENGTH(${1:expr})', detail: 'length' },
  { name: 'SUBSTRING', snippet: 'SUBSTRING(${1:expr}, ${2:1}, ${3:n})', detail: 'substring' },
  { name: 'REPLACE', snippet: 'REPLACE(${1:expr}, ${2:from}, ${3:to})', detail: 'replace' },
  { name: 'CONCAT', snippet: 'CONCAT(${1:a}, ${2:b})', detail: 'concatenate' },
  { name: 'CAST', snippet: 'CAST(${1:expr} AS ${2:type})', detail: 'cast' },
  { name: 'ROUND', snippet: 'ROUND(${1:expr}, ${2:0})', detail: 'round' },
  { name: 'ABS', snippet: 'ABS(${1:expr})', detail: 'absolute value' },
  { name: 'CURRENT_DATE', snippet: 'CURRENT_DATE', detail: 'current date' },
  { name: 'CURRENT_TIMESTAMP', snippet: 'CURRENT_TIMESTAMP', detail: 'current timestamp' },
];

function stripSqlLiterals(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''").replace(/--[^\n]*/g, ' ');
}

/** Drop the identifier being typed, but keep a finished clause keyword. */
function withoutPartialIdent(sql: string): string {
  const match = /[A-Za-z_][\w$]*$/.exec(sql);
  if (!match) return sql;
  if (SLOT_WORDS.has(match[0].toUpperCase())) return sql;
  return sql.slice(0, match.index);
}

/**
 * The text the two readers below both work from: literals and comments
 * blanked, and the identifier being typed dropped. Computed once per
 * keystroke and passed to both, since each pass copies the whole prefix.
 */
export function completionBody(sqlBeforeCursor: string): string {
  return withoutPartialIdent(stripSqlLiterals(sqlBeforeCursor));
}

export function completionSlot(sqlBeforeCursor: string, body = completionBody(sqlBeforeCursor)): CompletionSlot {
  let slot: CompletionSlot = 'other';
  SLOT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SLOT_RE.exec(body)) !== null) {
    slot = SLOT_BY_WORD[match[1]!.toUpperCase()] ?? 'other';
  }
  return slot;
}

/**
 * True when a just-typed space or `=` should open the clause list.
 *
 * Monaco skips trigger characters whenever quick suggestions are on, so a
 * space after FROM / LEFT / ON never opened the popup by itself.
 */
export function shouldOpenClauseSuggest(
  sqlBeforeCursor: string,
  body = completionBody(sqlBeforeCursor)
): boolean {
  const keyword = clauseKeywordBeforeCursor(sqlBeforeCursor, body);
  return keyword != null && AUTO_OPEN.has(keyword);
}

/** Clause keyword touching the caret, once the word being typed is set aside. */
export function clauseKeywordBeforeCursor(
  sqlBeforeCursor: string,
  precomputed = completionBody(sqlBeforeCursor)
): string | null {
  const body = precomputed.trimEnd();
  // `ON c.id = ` is still the ON list — a space here should offer the other alias.
  if (/(?:<>|!=|<=|>=|=|<|>)$/.test(body)) return '=';
  const match = /\b([A-Za-z_]+)$/.exec(body);
  return match ? match[1]!.toUpperCase() : null;
}

/**
 * `schema.table` → `table`. `lastIndexOf` returns -1 when there is no dot, so
 * `slice(0)` already gives the whole name back — no need to test for one.
 */
function bareName(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

/** One pass: per table, the alias to qualify its columns with. */
function columnQualifiers(aliases: Record<string, string>): { alias: string; table: string }[] {
  const byTable = new Map<string, { table: string; short?: string }>();
  for (const [alias, table] of Object.entries(aliases)) {
    const lower = table.toLowerCase();
    const prev = byTable.get(lower);
    const short = alias !== lower && alias !== bareName(lower) ? alias : prev?.short;
    byTable.set(lower, { table, short });
  }
  return [...byTable.values()].map(({ table, short }) => ({
    alias: short ?? bareName(table.toLowerCase()),
    table,
  }));
}

type SchemaTableEntry = { table: { name: string; objectType?: string }; schema?: string };

/**
 * Lower-cased table name → its table and owning schema, under both the
 * qualified and the bare name. Built once per request: the two lookups below
 * used to rescan every schema for every suggested table, which made building
 * a FROM list O(tables²) on each keystroke.
 */
function tableSchemaIndex(
  schemas: ReturnType<typeof getCompletionContext>['schemas']
): Map<string, SchemaTableEntry> {
  const index = new Map<string, SchemaTableEntry>();
  for (const src of schemas) {
    const schema = src.schema?.trim();
    const usable = schema && /^[A-Za-z_][\w$]*$/.test(schema) ? schema : undefined;
    for (const table of src.tables) {
      const lower = table.name.toLowerCase();
      const entry: SchemaTableEntry = { table, schema: usable };
      if (!index.has(lower)) index.set(lower, entry);
      const bare = bareName(lower);
      if (!index.has(bare)) index.set(bare, entry);
    }
  }
  return index;
}

function qualifiedTableName(name: string, index: Map<string, SchemaTableEntry>): string {
  if (name.includes('.')) return name;
  if (!/^[A-Za-z_][\w$]*$/.test(name)) return name;
  const schema = index.get(name.toLowerCase())?.schema;
  return schema ? `${schema}.${name}` : name;
}

let registered = false;
/** Rebuilt when schemaCache revision changes. */
let cachedTries: SchemaTrieBundle | null = null;

function objectTypeOf(
  schemas: ReturnType<typeof getCompletionContext>['schemas'],
  name: string
): string | undefined {
  const key = name.toLowerCase();
  for (const src of schemas) {
    for (const table of src.tables) {
      const full = table.name.toLowerCase();
      const bare = full.includes('.') ? full.slice(full.lastIndexOf('.') + 1) : full;
      if (full === key || bare === key) return table.objectType;
    }
  }
  return undefined;
}

function triesFor(schemas: ReturnType<typeof getCompletionContext>['schemas']): SchemaTrieBundle {
  const rev = schemaRevision(schemas);
  if (cachedTries && cachedTries.revision === rev) return cachedTries;
  cachedTries = buildSchemaTries(schemas);
  return cachedTries;
}

/**
 * Register completion providers once per Monaco language id. Suggestions read
 * the active tab's SQL + schemaCache via {@link getCompletionContext} so we
 * never re-register (duplicate-provider leak) on remount.
 *
 * Alias support: `alias.` / `alias.col…` resolves via {@link extractTableAliases}
 * to the underlying table's columns. Aliases themselves are also suggested.
 */
function expressionSuggestions(args: {
  monaco: typeof Monaco;
  range: Monaco.IRange;
  prefix: string;
  aliases: Record<string, string>;
  tries: SchemaTrieBundle;
  schemas: ReturnType<typeof getCompletionContext>['schemas'];
  tableIndex: () => ReturnType<typeof buildTableIndex>;
}): Monaco.languages.CompletionItem[] {
  const { monaco, range, prefix, aliases, tries, schemas, tableIndex } = args;
  const items: Monaco.languages.CompletionItem[] = [];
  const seen = new Set<string>();
  for (const { alias, table } of columnQualifiers(aliases)) {
    const tableLower = table.toLowerCase();
    const colTrie =
      tries.columnsByTable.get(tableLower) ?? tries.columnsByTable.get(bareName(tableLower));
    // The index is built at most once per request, not once per alias.
    const cols = colTrie ? trieCollect(colTrie, '') : columnsForTable(tableIndex(), table);
    for (const col of cols) {
      const qualified = `${alias}.${col}`;
      const key = qualified.toLowerCase();
      if (seen.has(key)) continue;
      const aliasLower = alias.toLowerCase();
      const colLower = col.toLowerCase();
      if (
        prefix &&
        !key.startsWith(prefix) &&
        !colLower.startsWith(prefix) &&
        !aliasLower.startsWith(prefix)
      ) {
        continue;
      }
      seen.add(key);
      items.push({
        label: qualified,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: qualified,
        filterText: `${qualified} ${col}`,
        detail: `column · ${table}`,
        sortText: `0_${alias}_${col}`,
        range,
      });
    }
  }
  for (const fn of COMMON_SQL_FUNCTIONS) {
    if (prefix && !fn.name.toLowerCase().startsWith(prefix)) continue;
    items.push({
      label: fn.name,
      kind: monaco.languages.CompletionItemKind.Function,
      insertText: fn.snippet,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      filterText: fn.name,
      detail: `function · ${fn.detail}`,
      sortText: `1_${fn.name}`,
      range,
    });
  }
  for (const src of schemas) {
    for (const table of src.tables) {
      if (table.objectType !== 'FUNCTION') continue;
      const bare = bareName(table.name);
      const key = bare.toLowerCase();
      if (seen.has(`fn:${key}`)) continue;
      if (prefix && !key.startsWith(prefix)) continue;
      seen.add(`fn:${key}`);
      items.push({
        label: bare,
        kind: monaco.languages.CompletionItemKind.Function,
        insertText: `${bare}()`,
        filterText: bare,
        detail: `function · ${src.schema ?? table.name}`,
        sortText: `1b_${bare}`,
        range,
      });
    }
  }
  for (const kw of ['AND', 'OR', 'NOT', 'IN', 'LIKE', 'IS', 'NULL', 'BETWEEN']) {
    if (prefix && !kw.toLowerCase().startsWith(prefix)) continue;
    items.push({
      label: kw,
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: kw,
      detail: 'keyword',
      sortText: `2_${kw}`,
      range,
    });
  }
  return items;
}

export function ensureSqlCompletions(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  const provider: Monaco.languages.CompletionItemProvider = {
    triggerCharacters: ['.', '{', ' '],
    provideCompletionItems(model, position, context) {
      // Inside `-- @js` / `-- @ts` fences, FoxScript virtual-doc providers own suggest.
      if (projectToVirtualDoc(model, position)) {
        return { suggestions: [] };
      }
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const { sql, schemas, variables } = getCompletionContext();
      // Prefer the live model text — context sql can lag one keystroke behind.
      const modelSql = model.getValue() || sql;
      const aliases = extractTableAliases(modelSql);
      const sqlBeforeCursor = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      // Both readers work from the same stripped prefix — one pass, not two.
      const body = completionBody(sqlBeforeCursor);
      const slot = completionSlot(sqlBeforeCursor, body);
      const fromTablePos = slot === 'table' || slot === 'join-modifier';
      // A space opens the list only at FROM / JOIN / ON / WHERE / AND. Anywhere
      // else a space is just a space — Ctrl+Space still completes.
      if (context?.triggerCharacter === ' ' && !shouldOpenClauseSuggest(sqlBeforeCursor, body)) {
        return { suggestions: [] };
      }
      // Only the cold fallbacks need the full index; most keystrokes are
      // served by the tries, so build it on first use.
      let builtIndex: TableIndex | null = null;
      const tableIndexLazy = (): TableIndex => (builtIndex ??= buildTableIndex(schemas));
      const tries = triesFor(schemas);
      const prefix = (word.word || '').toLowerCase();

      // `${{name.` — suggest columns of a table variable.
      // eslint-disable-next-line security/detect-unsafe-regex -- false positive: fixed `${{` prefix; bounded identifiers
      const varColMatch = /\$\{\{([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)?$/.exec(
        linePrefix
      );
      if (varColMatch) {
        const varName = varColMatch[1]!;
        const partial = (varColMatch[2] ?? '').toLowerCase();
        const startCol = position.column - (varColMatch[2]?.length ?? 0);
        const colRange: Monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: startCol,
          endColumn: position.column,
        };
        const tableVar = variables.find(
          (v) => v.name === varName && v.kind === 'table'
        );
        if (!tableVar) {
          return {
            suggestions: [
              {
                label: `(${varName} is not a table variable)`,
                kind: monaco.languages.CompletionItemKind.Text,
                insertText: '',
                detail: 'Save a result as table, or use -- @set name = table',
                range: colRange,
              },
            ],
          };
        }
        const cols = (tableVar.columns ?? []).filter(
          (c) => !partial || c.toLowerCase().startsWith(partial)
        );
        return {
          suggestions: cols.map((c) => ({
            label: c,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: `${c}}}`,
            detail: `column · ${varName}`,
            sortText: `0_${c}`,
            range: colRange,
          })),
        };
      }

      // `${{` or `${{partial` — suggest global SQL Editor variables.
      // eslint-disable-next-line security/detect-unsafe-regex -- false positive: fixed `${{` prefix; bounded identifier
      const varMatch = /\$\{\{([A-Za-z_][A-Za-z0-9_]*)?$/.exec(linePrefix);
      if (varMatch) {
        const partial = (varMatch[1] ?? '').toLowerCase();
        const startCol = position.column - (varMatch[1]?.length ?? 0);
        const varRange: Monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: startCol,
          endColumn: position.column,
        };
        const suggestions = variables
          .filter((v) => !partial || v.name.toLowerCase().startsWith(partial))
          .map((v) => {
            const kindDetail =
              v.kind === 'list'
                ? `list · ${v.values?.length ?? 0} values`
                : v.kind === 'table'
                  ? `table · ${(v.rows?.length ?? 0)}×${(v.columns?.length ?? 0)}`
                  : 'scalar';
            return {
              label: v.name,
              kind: v.secret
                ? monaco.languages.CompletionItemKind.Constant
                : monaco.languages.CompletionItemKind.Variable,
              insertText: `${v.name}}}`,
              detail: v.secret ? `secret · ${kindDetail}` : kindDetail,
              sortText: `${v.secret ? '0' : '1'}_${v.name}`,
              range: varRange,
            };
          });
        if (suggestions.length === 0) {
          return {
            suggestions: [
              {
                label: '(no variables)',
                kind: monaco.languages.CompletionItemKind.Text,
                insertText: '',
                detail: 'Add one in the Variables sidebar or save a result cell',
                range: varRange,
              },
            ],
          };
        }
        return { suggestions };
      }

      // Inside `CALL proc(` / `fn(` — suggest parameters with IN / OUT / INOUT.
      // eslint-disable-next-line security/detect-unsafe-regex -- bounded identifiers; no nested quantifiers
      const callOpen = /(?:\bCALL\s+)?([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s*\(\s*([^()]*)$/i.exec(
        linePrefix
      );
      if (callOpen) {
        const routineRef = callOpen[1]!.toLowerCase();
        const argSoFar = callOpen[2] ?? '';
        const argIndex = (argSoFar.match(/,/g) || []).length;
        const afterComma = argSoFar.includes(',')
          ? argSoFar.slice(argSoFar.lastIndexOf(',') + 1).trim()
          : argSoFar.trim();
        const routine = findRoutine(schemas, routineRef);
        if (routine) {
          const params = filterCallParameters(routine.parameters ?? []);
          if (params.length > 0) {
            const partial = afterComma.toLowerCase();
            const startCol = position.column - afterComma.length;
            const argRange: Monaco.IRange = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: startCol,
              endColumn: position.column,
            };
            const suggestions = params
              .map((p, i) => ({ p, i }))
              .filter(
                ({ p, i }) =>
                  (!partial ||
                    p.name.toLowerCase().startsWith(partial) ||
                    p.mode.toLowerCase().startsWith(partial)) &&
                  // Prefer next expected arg, but still show others filtered by prefix.
                  (i === argIndex || partial.length > 0)
              )
              .map(({ p, i }) => ({
                label: `${p.mode} ${p.name || `arg${i + 1}`}`,
                kind: monaco.languages.CompletionItemKind.Variable,
                insertText: p.name || '?',
                detail: `${p.mode}${p.type ? ` · ${p.type}` : ''} · arg ${i + 1}/${params.length}`,
                sortText: `${i === argIndex ? '0' : '1'}_${String(i).padStart(2, '0')}`,
                range: argRange,
              }));
            if (suggestions.length > 0) {
              return { suggestions };
            }
          }
        }
      }

      // `alias.` or `alias.partial` — keep matching after the user types past the dot.
      const dot = /([A-Za-z_][\w$]*)\.([A-Za-z_\d$]*)$/.exec(linePrefix);
      if (dot) {
        const ref = dot[1]!.toLowerCase();
        const partial = (dot[2] ?? '').toLowerCase();
        const tableName = aliases[ref] ?? ref;
        const colTrie =
          tries.columnsByTable.get(tableName.toLowerCase()) ??
          tries.columnsByTable.get(
            tableName.toLowerCase().includes('.')
              ? tableName.toLowerCase().slice(tableName.toLowerCase().lastIndexOf('.') + 1)
              : tableName.toLowerCase()
          );
        const cols = colTrie
          ? trieCollect(colTrie, partial)
          : columnsForTable(tableIndexLazy(), tableName).filter(
              (name) => !partial || name.toLowerCase().startsWith(partial)
            );
        // Replace only the column fragment after the dot (not the alias).
        const colRange: Monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - partial.length,
          endColumn: position.column,
        };
        // `schema.` — the qualifier names a schema, not a table or an alias.
        //
        // Checked only once columns come back empty, so nothing that resolved
        // as a table or alias changes behaviour: a name that is both keeps its
        // columns, which is what someone writing `orders.` meant. A schema has
        // no columns, so it used to fall through to an empty popup even though
        // its tables were already loaded.
        const schemaTables = cols.length === 0 ? tries.tablesBySchema.get(ref) : undefined;
        // Whether the schema holds anything at all, as opposed to anything
        // matching what has been typed. `demo_a.zzz` used to report "no tables
        // in demo_a" — a typo looking exactly like an empty schema.
        const schemaHasAny = schemaTables ? trieCollect(schemaTables, '').length > 0 : false;
        if (schemaTables) {
          const names = trieCollect(schemaTables, partial);
          if (names.length > 0) {
            // Same as bare FROM/JOIN: insert `table alias` so the reader can
            // qualify columns with the short name. Outside FROM (e.g. SELECT
            // list `demo_a.`) keep the bare table — an alias there is noise.
            const takenAliases = new Set(Object.keys(aliases));
            return {
              suggestions: names.map((name) => {
                const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
                const kind = objectTypeOf(schemas, name);
                if (kind === 'FUNCTION' || kind === 'PROCEDURE') {
                  return {
                    label: name,
                    kind: monaco.languages.CompletionItemKind.Function,
                    insertText: `${name}()`,
                    filterText: name,
                    detail: `${kind.toLowerCase()} · ${dot[1]!}`,
                    sortText: `1_${name}`,
                    range: colRange,
                  };
                }
                if (fromTablePos) {
                  const alias = suggestTableAlias(bare, takenAliases);
                  takenAliases.add(alias);
                  return {
                    label: `${name}  ${alias}`,
                    kind: monaco.languages.CompletionItemKind.Struct,
                    insertText: `${name} ${alias}`,
                    filterText: name,
                    detail: `table · ${dot[1]!} · alias ${alias}`,
                    sortText: `0_${name}`,
                    range: colRange,
                  };
                }
                return {
                  label: name,
                  kind: monaco.languages.CompletionItemKind.Struct,
                  insertText: name,
                  detail: `table · ${dot[1]!}`,
                  sortText: `0_${name}`,
                  range: colRange,
                };
              }),
            };
          }
        }

        if (cols.length === 0) {
          // `aliases` self-maps a bare table name in FROM, so `aliases[ref]`
          // is truthy for `nowhere.` as well as for a real alias. Only a name
          // that resolves to a *different* table is an alias, and only that
          // case can honestly say the table is missing its columns.
          const resolvedAlias = aliases[ref] && aliases[ref]!.toLowerCase() !== ref;
          const knownSchema = tries.tablesBySchema.has(ref);
          const note = resolvedAlias
            ? {
                label: `(no columns for ${tableName})`,
                detail:
                  schemas.length === 0
                    ? 'Load a destination schema (check a server)'
                    : 'Table not in loaded schema',
              }
            : knownSchema
              ? schemaHasAny
                ? {
                    label: `(nothing in ${dot[1]!} starts with "${partial}")`,
                    detail: 'The schema has tables — none match what you typed',
                  }
                : {
                    label: `(no tables in ${dot[1]!})`,
                    detail: 'The schema loaded, but has no tables or views',
                  }
              : {
                  label: '(schema not loaded)',
                  detail:
                    schemas.length === 0
                      ? 'Check a server in the sidebar to load its schema'
                      : `No table or schema named ${dot[1]!} in what is loaded`,
                };
          return {
            suggestions: [
              {
                label: note.label,
                kind: monaco.languages.CompletionItemKind.Text,
                insertText: '',
                detail: note.detail,
                range: colRange,
              },
            ],
          };
        }

        return {
          suggestions: cols.map((name) => ({
            label: name,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: name,
            detail: `column · ${tableName}`,
            range: colRange,
          })),
        };
      }

      if (slot === 'expression') {
        return {
          suggestions: expressionSuggestions({
            monaco,
            range,
            prefix,
            aliases,
            tries,
            schemas,
            tableIndex: tableIndexLazy,
          }),
        };
      }

      const seen = new Set<string>();
      const suggestions: Monaco.languages.CompletionItem[] = [];

      // Aliases first so `u` suggests the alias before unrelated keywords.
      // In the table slot the next name is a table, not an alias already used.
      if (slot !== 'table') {
        for (const [alias, table] of Object.entries(aliases)) {
          const tableLower = table.toLowerCase();
          if (alias === tableLower) continue; // skip bare table self-map
          if (tableLower.endsWith('.' + alias)) continue;
          const bare = tableLower.includes('.')
            ? tableLower.slice(tableLower.lastIndexOf('.') + 1)
            : tableLower;
          if (alias === bare) continue;
          if (prefix && !alias.startsWith(prefix)) continue;
          if (seen.has(alias)) continue;
          seen.add(alias);
          suggestions.push({
            label: alias,
            kind: monaco.languages.CompletionItemKind.Variable,
            insertText: alias,
            detail: `alias → ${table}`,
            sortText: `0_${alias}`,
            range,
          });
        }
      }

      /**
       * Schema names, so `demo_a.` is something you can find rather than
       * something you have to already know.
       *
       * Accepting one inserts the dot and re-triggers the suggest widget, so
       * the table list opens straight away — the whole point of the request.
       * Sorted above tables: typing a schema name is the start of a longer
       * path, and a table of the same name is still one keystroke away.
       */
      for (const schemaName of [...tries.tablesBySchema.keys()].sort()) {
        if (prefix && !schemaName.startsWith(prefix)) continue;
        if (seen.has(schemaName)) continue;
        // A name that is both a schema and a table stays a table: that is what
        // it means in a FROM clause, and the schema is still reachable by
        // typing the dot.
        if (tries.columnsByTable.has(schemaName)) continue;
        seen.add(schemaName);
        suggestions.push({
          label: schemaName,
          kind: monaco.languages.CompletionItemKind.Module,
          insertText: `${schemaName}.`,
          detail: 'schema',
          sortText: slot === 'table' ? `1_${schemaName}` : `0a_${schemaName}`,
          range,
          command: { id: 'editor.action.triggerSuggest', title: 'Suggest tables' },
        });
      }

      const tableNames = trieCollect(tries.tables, prefix);
      const takenAliases = new Set(Object.keys(aliases));
      // One index for the whole loop: both the objectType lookup and the
      // schema qualification below used to rescan every schema per table.
      const schemaIndex = tableSchemaIndex(schemas);
      for (const name of tableNames) {
        const key = name.toLowerCase();
        const bare = bareName(key);
        if (seen.has(key) || seen.has(bare)) continue;
        seen.add(key);
        seen.add(bare);
        const meta = (schemaIndex.get(key) ?? schemaIndex.get(bare))?.table;
        // In FROM/JOIN, insert `table alias` so columns can use the short name.
        let insertText = name;
        let detail = (meta?.objectType ?? 'TABLE').toLowerCase();
        let label: string = name;
        if (fromTablePos) {
          const alias = suggestTableAlias(bare, takenAliases);
          takenAliases.add(alias);
          const qualified = qualifiedTableName(name, schemaIndex);
          insertText = `${qualified} ${alias}`;
          label = `${name}  ${alias}`;
          detail = `${detail} · alias ${alias}`;
        }
        suggestions.push({
          label,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText,
          filterText: fromTablePos ? `${name} ${insertText}` : name,
          detail,
          sortText:
            slot === 'join-modifier' ? `2_${name}` : slot === 'table' ? `0_${name}` : `1_${name}`,
          range,
        });
      }

      if (slot === 'table' || slot === 'join-modifier') {
        const keywords =
          slot === 'join-modifier'
            ? ['JOIN', 'OUTER', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS']
            : ['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'ON', 'WHERE', 'AND'];
        const keywordSort = slot === 'join-modifier' ? '0' : '8';
        for (const kw of keywords) {
          if (prefix && !kw.toLowerCase().startsWith(prefix)) continue;
          suggestions.push({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw,
            detail: 'keyword',
            sortText: `${keywordSort}_${kw}`,
            range,
          });
        }
        return { suggestions };
      }

      // Procedures / functions — show IN/OUT/INOUT signature in detail; insert CALL/fn(…).
      for (const src of schemas) {
        for (const t of src.tables) {
          if (t.objectType !== 'PROCEDURE' && t.objectType !== 'FUNCTION') continue;
          const key = t.name.toLowerCase();
          const bare = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key;
          if (prefix && !key.startsWith(prefix) && !bare.startsWith(prefix)) continue;
          if (seen.has(`fn:${key}`) || seen.has(`fn:${bare}`)) continue;
          seen.add(`fn:${key}`);
          seen.add(`fn:${bare}`);
          const params = filterCallParameters(t.parameters ?? []);
          const sig =
            params.length === 0
              ? '(no params)'
              : params
                  .map((p) => `${p.mode} ${p.name || '?'}${p.type ? ` ${p.type}` : ''}`)
                  .join(', ');
          const snippetArgs = params
            .map((p, i) => {
              const hint = [p.mode, p.name || `arg${i + 1}`].filter(Boolean).join(' ');
              return `\${${i + 1}:${hint}}`;
            })
            .join(', ');
          const callBody = params.length ? `(${snippetArgs})` : '()';
          const insertText =
            t.objectType === 'PROCEDURE' ? `CALL ${t.name}${callBody}` : `${t.name}${callBody}`;
          suggestions.push({
            label: t.name,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: `${t.objectType.toLowerCase()} · ${sig}`,
            documentation: sig,
            sortText: `1b_${t.name}`,
            range,
          });
        }
      }

      for (const kw of LIGHT_KEYWORDS) {
        const low = kw.toLowerCase();
        if (seen.has(low)) continue;
        if (prefix && !low.startsWith(prefix)) continue;
        suggestions.push({
          label: kw,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: kw,
          detail: 'keyword',
          sortText: `2_${kw}`,
          range,
        });
      }

      return { suggestions };
    },
  };

  for (const lang of LANG_IDS) {
    monaco.languages.registerCompletionItemProvider(lang, provider);
  }
}

type TableIndex = Map<string, Set<string>>; // lower table name → column names

function buildTableIndex(schemas: ReturnType<typeof getCompletionContext>['schemas']): TableIndex {
  const index: TableIndex = new Map();
  for (const src of schemas) {
    for (const t of src.tables) {
      if (t.objectType !== 'TABLE' && t.objectType !== 'VIEW' && t.objectType !== 'MQT') continue;
      const cols = new Set<string>((t.columns ?? []).map((c: { name: string }) => c.name));
      const full = t.name;
      const lower = full.toLowerCase();
      const bare = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
      mergeCols(index, lower, cols);
      mergeCols(index, bare, cols);
    }
  }
  return index;
}

function mergeCols(index: TableIndex, key: string, cols: Set<string>): void {
  const existing = index.get(key);
  if (!existing) {
    index.set(key, new Set(cols));
    return;
  }
  for (const c of cols) existing.add(c);
}

function columnsForTable(index: TableIndex, tableName: string): string[] {
  const lower = tableName.toLowerCase();
  const bare = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
  let set = index.get(lower) ?? index.get(bare);
  if (!set) {
    // Schema may store SCHEMA.TABLE while the SQL used a bare/keyword table name.
    for (const [key, cols] of index) {
      if (key === bare || key.endsWith('.' + bare)) {
        set = cols;
        break;
      }
    }
  }
  if (!set) return [];
  return [...set].sort((a, b) => a.localeCompare(b));
}

function findRoutine(
  schemas: ReturnType<typeof getCompletionContext>['schemas'],
  ref: string
): (typeof schemas)[number]['tables'][number] | undefined {
  const lower = ref.toLowerCase();
  const bare = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
  for (const src of schemas) {
    for (const t of src.tables) {
      if (t.objectType !== 'PROCEDURE' && t.objectType !== 'FUNCTION') continue;
      const key = t.name.toLowerCase();
      const tBare = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key;
      if (key === lower || tBare === bare || key.endsWith('.' + bare)) return t;
    }
  }
  return undefined;
}
