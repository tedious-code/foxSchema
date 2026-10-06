/**
 * How the UI server sends the built frontend.
 *
 * Vite names everything under `assets/` by content hash, so a release writes
 * new names and an old copy can never be stale: a browser may keep those for a
 * year without asking. Everything else, above all index.html, which names the
 * current hashes, is revalidated on every load, or a release would never reach
 * a returning browser.
 */
import { relative, resolve, sep } from 'node:path';
import type { FastifyStaticOptions } from '@fastify/static';

export const IMMUTABLE_ASSET = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'no-cache';

/** Cache-Control for one file under the static root. */
export function staticCacheControl(root: string, file: string): string {
  return relative(root, file).startsWith(`assets${sep}`) ? IMMUTABLE_ASSET : REVALIDATE;
}

/** True for a request path that names a hashed build asset. */
export function isAssetPath(url: string): boolean {
  return url.startsWith('/assets/');
}

export function staticOptions(staticDir: string): FastifyStaticOptions {
  const root = resolve(staticDir);
  return {
    root,
    wildcard: false,
    // The build writes .br and .gz copies beside each text file
    // (apps/web/src/build/precompress.ts). Brotli, then gzip, then the file
    // itself when there is no copy or the browser accepts neither.
    preCompressed: true,
    // The copies are found beside each file; they need no routes of their own.
    globIgnore: ['**/*.br', '**/*.gz'],
    cacheControl: false,
    setHeaders: (reply, file) => {
      reply.header('Cache-Control', staticCacheControl(root, file));
    },
  };
}
