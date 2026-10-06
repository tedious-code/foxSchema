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
  try {
    let built: unknown;
    try {
      built = new Function('z', `"use strict"; return (${code});`)(zod);
    } catch {
      built = new Function('z', `"use strict"; ${code}`)(zod);
    }
    const schema = zod.toJSONSchema(built as never, {
      target: 'draft-7',
    }) as Record<string, unknown>;
    return { schema };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
