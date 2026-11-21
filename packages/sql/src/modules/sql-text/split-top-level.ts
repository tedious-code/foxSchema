/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one top-level splitter: commas in a SELECT list, `AND` in a WHERE
 * clause, dots in a qualified name. Shared by the SQL editor's column origins
 * and the query subset, so it lives with the other SQL text helpers.
 */
/**
 * Split `text` on top-level occurrences of `sep` — outside parentheses and
 * outside quoted text (`'…'`, `"…"`, `` `…` ``, `[…]`).
 *
 * `sep` is either a punctuation character (`,`) or a keyword (`AND`). A
 * keyword matches case-insensitively and only on word boundaries, so
 * `name LIKE '%AND%'` and a column called `brand` stay in one piece.
 *
 * This is the one top-level splitter — do not add a second scanner.
 */
export function splitTopLevel(text: string, sep: string): string[] {
  const isKeyword = /^[A-Za-z]/.test(sep);
  const lowerSep = sep.toLowerCase();
  const items: string[] = [];
  let depth = 0;
  let current = '';
  let quote: '"' | '`' | "'" | '[' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (quote === '[' && ch === ']') quote = null;
      else if (ch === quote) {
        if ((quote === '"' || quote === "'") && text[i + 1] === quote) {
          current += text[++i];
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === '`' || ch === "'" || ch === '[') {
      quote = ch === '[' ? '[' : ch;
      current += ch;
      continue;
    }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); current += ch; continue; }
    const hit =
      depth === 0 &&
      (isKeyword
        ? text.slice(i, i + sep.length).toLowerCase() === lowerSep &&
          !/[\w$]/.test(text[i - 1] ?? '') &&
          !/[\w$]/.test(text[i + sep.length] ?? '')
        : ch === sep);
    if (hit) {
      items.push(current.trim());
      current = '';
      i += sep.length - 1;
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}
