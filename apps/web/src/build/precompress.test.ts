import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { precompressDir } from './precompress';

describe('precompressDir', () => {
  let dir: string;
  const script = 'export const rows = ' + JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i }))) + ';\n';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'foxschema-precompress-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), script);
    writeFileSync(join(dir, 'index.html'), '<!doctype html>' + '<div></div>'.repeat(200));
    writeFileSync(join(dir, 'assets', 'tiny.css'), 'a{}');
    writeFileSync(join(dir, 'assets', 'logo.png'), Buffer.alloc(4096, 7));
    await precompressDir(dir);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes Brotli and gzip copies that decode to the original, in nested folders', () => {
    const js = join(dir, 'assets', 'app-abc123.js');
    expect(brotliDecompressSync(readFileSync(`${js}.br`)).toString()).toBe(script);
    expect(gunzipSync(readFileSync(`${js}.gz`)).toString()).toBe(script);
    expect(existsSync(join(dir, 'index.html.br'))).toBe(true);
  });

  it('skips files too small to gain, and formats that are already compressed', () => {
    expect(existsSync(join(dir, 'assets', 'tiny.css.br'))).toBe(false);
    expect(existsSync(join(dir, 'assets', 'logo.png.br'))).toBe(false);
  });
});
