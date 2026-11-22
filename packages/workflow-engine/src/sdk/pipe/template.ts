import { getPath } from '../../common/index.js';
/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/sdk/src/pipe/template.ts).
 */
/**
 * Mustache-lite interpolation: `{{path.to.value}}` resolved against a
 * variables object. Missing paths become empty strings. Used for URL,
 * query key/value, headers, and body templates on HTTP requests.
 */

const TOKEN = /\{\{\s*([a-zA-Z0-9_.$-]+)\s*\}\}/g;
/** A string that is nothing but one token, e.g. `"{{records}}"`. */
const SOLE_TOKEN = /^\s*\{\{\s*([a-zA-Z0-9_.$-]+)\s*\}\}\s*$/;

export function interpolate(
  template: string,
  variables: Record<string, unknown>,
  /** Applied to each substituted value, never to the template's own text — e.g. HTML escaping. */
  escape: (value: string) => string = (value) => value,
): string {
  return template.replace(TOKEN, (_match, path: string) => {
    const value = getPath(variables, path);
    if (value === undefined || value === null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return escape(String(value));
    }
    return escape(JSON.stringify(value));
  });
}

/**
 * A template cut at its tokens: the literal text around them, and each token's
 * path. `strings` is always one longer than `paths`, the shape a tagged
 * template has — for callers that must bind values rather than write them into
 * text, as SQL does.
 */
export function splitTemplate(template: string): { strings: string[]; paths: string[] } {
  const strings: string[] = [];
  const paths: string[] = [];
  let last = 0;
  for (const match of template.matchAll(TOKEN)) {
    strings.push(template.slice(last, match.index));
    paths.push(match[1]!);
    last = match.index + match[0].length;
  }
  strings.push(template.slice(last));
  return { strings, paths };
}

/**
 * Template paths in a structure that would resolve to nothing, in order and
 * without repeats. `interpolate` turns them into empty strings, which is the
 * contract (an optional `{{trigger.page}}` may be absent); this lets a caller
 * say so, because a misspelled `{{vars.userId}}` sends `userId=` and looks
 * like a request that simply found nothing.
 */
export function missingTemplatePaths(value: unknown, variables: Record<string, unknown>): string[] {
  const missing = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(TOKEN)) {
        const resolved = getPath(variables, match[1]!);
        if (resolved === undefined || resolved === null) missing.add(match[1]!);
      }
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      for (const [key, entry] of Object.entries(node)) {
        walk(key);
        walk(entry);
      }
    }
  };
  walk(value);
  return [...missing];
}

/**
 * Interpolate every string in a structure. A string that is *only* a token
 * (`"{{records}}"`) is replaced by the resolved value itself, so an array or
 * object substitutes structurally instead of being flattened to a JSON
 * string — which is what a bulk endpoint expecting `{"items": [...]}` needs.
 * Strings with surrounding text (`"got {{count}}"`) still stringify.
 */
export function interpolateDeep<T>(value: T, variables: Record<string, unknown>): T {
  if (typeof value === 'string') {
    const sole = SOLE_TOKEN.exec(value);
    if (sole) {
      const resolved = getPath(variables, sole[1]!);
      // Scalars keep the string path so `"{{n}}"` stays "5" in a JSON body
      // exactly as before; only non-scalars substitute structurally.
      if (resolved !== null && typeof resolved === 'object') {
        return resolved as T;
      }
    }
    return interpolate(value, variables) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateDeep(item, variables)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        interpolate(key, variables),
        interpolateDeep(entry, variables),
      ]),
    ) as T;
  }
  return value;
}

