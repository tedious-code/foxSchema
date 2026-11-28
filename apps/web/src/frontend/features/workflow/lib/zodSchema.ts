/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (lib/zod-schema.ts).
 */
import { loadOnce } from '@/shared/lib/loadOnce';

// The author's code gets the whole `z` namespace, so all of zod (340 kB) is
// kept: fetched when someone first types a schema, not with the designer.
const loadZod = loadOnce(() => import('zod'));

const ZOD_MAX_CODE_LENGTH = 50_000;

const BLOCKED_ZOD_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(?:window|document|globalThis|self|top|parent|frames)\b/, label: 'browser globals' },
  { re: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator|location)\b/, label: 'network or navigation globals' },
  { re: /\b(?:localStorage|sessionStorage|indexedDB|caches|cookie)\b/, label: 'browser storage' },
  { re: /\b(?:eval|Function|import|require|Reflect|Proxy)\b/, label: 'dynamic execution' },
  { re: /\.constructor\b|__proto__|\bgetPrototypeOf\b|\bgetOwnPropertyDescriptor\b/, label: 'prototype access' },
  { re: /\[[\s]*['"]constructor['"][\s]*\]/, label: 'constructor access' },
];

const SHADOWED_GLOBALS = [
  'window',
  'document',
  'globalThis',
  'self',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'localStorage',
  'sessionStorage',
  'navigator',
  'location',
  'Function',
] as const;

function validateZodSnippetSafety(code: string): string | null {
  if (code.length > ZOD_MAX_CODE_LENGTH) {
    return `Schema code must be under ${ZOD_MAX_CODE_LENGTH} characters.`;
  }
  for (const { re, label } of BLOCKED_ZOD_PATTERNS) {
    if (re.test(code)) {
      return `Schema code may not reference ${label}.`;
    }
  }
  return null;
}

/**
 * Compile designer-authored Zod code into an ajv-compatible JSON Schema
 * (draft-7). Accepts a bare expression (`z.object({...})`) or statements
 * ending in `return`. Runs only in the author's own browser — the server
 * stores and enforces the compiled JSON Schema, never the code.
 */
export async function compileZodSchema(
  code: string,
): Promise<{ schema: Record<string, unknown> } | { error: string } | null> {
  // Every call waits on the same load, an empty one too, so results reach the
  // editor in the order it asked for them.
  let zod: typeof import('zod').z;
  try {
    zod = (await loadZod()).z;
  } catch {
    return code.trim() ? { error: 'Could not load Zod. Check the connection and try again.' } : null;
  }
  if (!code.trim()) return null;
  const blocked = validateZodSnippetSafety(code);
  if (blocked) return { error: blocked };
  try {
    let built: unknown;
    try {
      built = new Function('z', ...SHADOWED_GLOBALS, `"use strict"; return (${code});`)(zod);
    } catch {
      built = new Function('z', ...SHADOWED_GLOBALS, `"use strict"; ${code}`)(zod);
    }
    const schema = zod.toJSONSchema(built as never, {
      target: 'draft-7',
    }) as Record<string, unknown>;
    return { schema };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
