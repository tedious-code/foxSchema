/** Compact prefix trie for SQL identifier autocomplete. */

export type TrieNode = {
  children: Map<string, TrieNode>;
  /** Terminal labels that end at this node (original casing). */
  values: string[];
};

export function createTrie(): TrieNode {
  return { children: new Map(), values: [] };
}

export function trieInsert(root: TrieNode, label: string): void {
  let node = root;
  const key = label.toLowerCase();
  for (const ch of key) {
    let next = node.children.get(ch);
    if (!next) {
      next = createTrie();
      node.children.set(ch, next);
    }
    node = next;
  }
  if (!node.values.includes(label)) node.values.push(label);
}

/** Collect up to `limit` labels under the node reached by `prefix` (case-insensitive). */
export function trieCollect(root: TrieNode, prefix: string, limit = 200): string[] {
  let node: TrieNode | undefined = root;
  const key = prefix.toLowerCase();
  for (const ch of key) {
    node = node.children.get(ch);
    if (!node) return [];
  }
  const out: string[] = [];
  const walk = (n: TrieNode) => {
    if (out.length >= limit) return;
    for (const v of n.values) {
      out.push(v);
      if (out.length >= limit) return;
    }
    for (const child of n.children.values()) walk(child);
  };
  walk(node);
  return out;
}

export type SchemaTrieBundle = {
  revision: string;
  tables: TrieNode;
  columnsByTable: Map<string, TrieNode>; // lower table key → column trie
  /**
   * Lower schema name → trie of the table names in it.
   *
   * `demo_a.` used to complete to nothing: the dot handler treated everything
   * before the dot as a table or alias and offered its columns, and a schema
   * has none. The tables were already loaded — there was just no way to ask
   * for them by schema.
   */
  tablesBySchema: Map<string, TrieNode>;
};

/**
 * Stable revision from connection ids + table/column *names* (and object types).
 * Counts alone miss renames and swap-in-place metadata changes.
 */
export function schemaRevision(
  schemas: Array<{
    connectionId: string;
    schema?: string;
    tables: Array<{
      name: string;
      objectType?: string;
      columns?: Array<{ name: string }>;
    }>;
  }>
): string {
  return schemas
    .map((s) => {
      const tables = [...s.tables]
        .map((t) => {
          const cols = [...(t.columns ?? []).map((c) => c.name)].sort().join(',');
          return `${t.objectType ?? ''}:${t.name}(${cols})`;
        })
        .sort()
        .join(';');
      // The schema name is part of the identity: switching a connection to
      // another schema can return the same table names and must still rebuild.
      return `${s.connectionId}@${s.schema ?? ''}:{${tables}}`;
    })
    .join('|');
}

export function buildSchemaTries(
  schemas: Array<{
    connectionId: string;
    schema?: string;
    tables: Array<{
      name: string;
      objectType?: string;
      columns?: Array<{ name: string }>;
    }>;
  }>
): SchemaTrieBundle {
  const tables = createTrie();
  const columnsByTable = new Map<string, TrieNode>();
  const tablesBySchema = new Map<string, TrieNode>();
  const intoSchema = (schema: string | undefined, table: string) => {
    const key = (schema ?? '').trim().toLowerCase();
    if (!key) return;
    let trie = tablesBySchema.get(key);
    if (!trie) {
      trie = createTrie();
      tablesBySchema.set(key, trie);
    }
    trieInsert(trie, table);
  };
  for (const src of schemas) {
    // Register the schema before its tables, so a schema that loaded and holds
    // nothing is still *known*. Without this an empty schema is indistinguish-
    // able from one nobody has loaded, and the editor tells the reader to go
    // load a schema they are already looking at.
    const schemaKey = (src.schema ?? '').trim().toLowerCase();
    if (schemaKey && !tablesBySchema.has(schemaKey)) tablesBySchema.set(schemaKey, createTrie());
    for (const t of src.tables) {
      const ot = t.objectType;
      if (ot && ot !== 'TABLE' && ot !== 'VIEW' && ot !== 'MQT' && ot !== 'FUNCTION' && ot !== 'PROCEDURE') {
        continue;
      }
      const lower = t.name.toLowerCase();
      const bare = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
      // Routines belong in `schema.` suggestions. They are not tables: putting
      // them on the table trie made Ctrl+Space invent an alias for a function.
      if (ot === 'FUNCTION' || ot === 'PROCEDURE') {
        const routineDot = t.name.lastIndexOf('.');
        if (routineDot > 0) intoSchema(t.name.slice(0, routineDot), t.name.slice(routineDot + 1));
        else intoSchema(src.schema, t.name);
        continue;
      }
      trieInsert(tables, t.name);
      // Two ways a table belongs to a schema: the connection loaded it from
      // there (names come back bare), or the name itself is qualified. They
      // are alternatives, not both — indexing a qualified name under the
      // connection's schema as well made `demo_a.` offer `sales.invoices`,
      // and accepting it inserted `demo_a.sales.invoices`.
      const dotAt = t.name.lastIndexOf('.');
      if (dotAt > 0) {
        intoSchema(t.name.slice(0, dotAt), t.name.slice(dotAt + 1));
      } else {
        intoSchema(src.schema, t.name);
      }
      let colTrie = columnsByTable.get(lower);
      if (!colTrie) {
        colTrie = createTrie();
        columnsByTable.set(lower, colTrie);
        columnsByTable.set(bare, colTrie);
      }
      for (const c of t.columns ?? []) trieInsert(colTrie, c.name);
    }
  }
  return { revision: schemaRevision(schemas), tables, columnsByTable, tablesBySchema };
}
