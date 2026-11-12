/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Whether a type as a catalog writes it names a given user-defined type.
 * Shared by the Drop Type planner and its dialects, and kept apart from the
 * planner so a dialect can import it without a cycle.
 */

/** The parts of a type reference: `"shop"."order_status"[]` is `shop`, `order_status`, an array. */
export function parseTypeReference(reference: string): { schema?: string; name: string; array: boolean } {
  let text = reference.trim();
  let array = false;
  while (text.endsWith('[]')) {
    array = true;
    text = text.slice(0, -2).trimEnd();
  }
  // A length or precision is not part of the name: `phone(20)`.
  const paren = text.indexOf('(');
  if (paren > 0 && text.endsWith(')')) text = text.slice(0, paren).trimEnd();
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"' || ch === '`' || ch === '[' || ch === ']') {
      quoted = ch === '[' ? true : ch === ']' ? false : !quoted;
      continue;
    }
    if (ch === '.' && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  const name = (parts.pop() ?? '').trim();
  const schema = parts.pop()?.trim();
  return { ...(schema ? { schema } : {}), name, array };
}

/**
 * Whether `reference` (a column's type, a parameter's type, a domain's base)
 * is the type `typeName`. Case is ignored, as engines fold it differently and
 * two types differing only by case in one schema would be its own problem.
 * A schema on the reference must be the type's schema when that is known.
 */
export function referencesType(
  reference: string | undefined,
  typeName: string,
  schema?: string
): { uses: boolean; array: boolean } {
  if (!reference || !typeName) return { uses: false, array: false };
  const parsed = parseTypeReference(reference);
  const sameName = parsed.name.toLowerCase() === typeName.toLowerCase();
  const sameSchema = !parsed.schema || !schema || parsed.schema.toLowerCase() === schema.toLowerCase();
  return { uses: sameName && sameSchema, array: parsed.array };
}
