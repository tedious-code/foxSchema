/**
 * Writes a Brotli (`.br`) and a gzip (`.gz`) copy of each compressible file in the
 * build. The server sends a copy in place of the original when the browser
 * accepts it (@fastify/static `preCompressed`), so a first visit downloads
 * about a quarter of the bytes and nothing is compressed per request.
 *
 * Both encodings, because browsers only offer Brotli over HTTPS: a Docker
 * install reached over plain HTTP on a LAN still gets gzip.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { Plugin } from 'vite';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Text, plus formats that ship uncompressed (TrueType: Monaco's icon font). */
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|txt|xml|wasm|ttf|ico)$/;
/** Below this, headers outweigh the saving. */
const MIN_BYTES = 1024;
/** A copy must save at least this share of the original to be worth serving. */
const MIN_SAVING = 0.1;

async function* filesUnder(dir: string): AsyncGenerator<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a folder of Vite's own build output, from its resolved config
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (COMPRESSIBLE.test(entry.name)) yield path;
  }
}

async function compressFile(path: string): Promise<number> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file found by walking the build output
  const original = await readFile(path);
  if (original.length < MIN_BYTES) return 0;
  const [br, gzipped] = await Promise.all([
    brotli(original, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: original.length,
      },
    }),
    gz(original, { level: constants.Z_BEST_COMPRESSION }),
  ]);
  const worthIt = (copy: Buffer) => copy.length <= original.length * (1 - MIN_SAVING);
  let written = 0;
  if (worthIt(br)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- beside a file found in the build output
    await writeFile(`${path}.br`, br);
    written++;
  }
  if (worthIt(gzipped)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- beside a file found in the build output
    await writeFile(`${path}.gz`, gzipped);
    written++;
  }
  return written;
}

/** Compress every compressible file under `dir`; returns how many copies were written. */
export async function precompressDir(dir: string): Promise<number> {
  const work: Promise<number>[] = [];
  for await (const path of filesUnder(dir)) work.push(compressFile(path));
  return (await Promise.all(work)).reduce((a, b) => a + b, 0);
}

/** Vite plugin: compress the finished build, workers and `public/` files included. */
export function precompress(): Plugin {
  let outDir = '';
  return {
    name: 'foxschema:precompress',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      await precompressDir(outDir);
    },
  };
}
