/**
 * The first-load budget check (scripts/bundle/first-load.mjs) that CI runs on
 * the built web app: it must count what a browser fetches for the first page,
 * and nothing that only loads later.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstLoadFiles, measureFirstLoad, renderReport } from '../../../scripts/bundle/first-load.mjs';

const HTML = `<!doctype html><html><head>
<link rel="icon" href="/favicon.svg">
<script type="module" crossorigin src="/assets/index-a1.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-react-b2.js">
<link rel="stylesheet" crossorigin href="/assets/index-c3.css">
<script src="https://example.com/analytics.js"></script>
</head><body><div id="root"></div></body></html>`;

describe('first-load budget', () => {
  const dist = mkdtempSync(join(tmpdir(), 'foxschema-first-load-'));
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  it('counts the entry, its preloads and the stylesheet, not icons or other origins', () => {
    expect(firstLoadFiles(HTML)).toEqual(['assets/index-a1.js', 'assets/vendor-react-b2.js', 'assets/index-c3.css']);
  });

  it('measures those files and says when the total is over budget', () => {
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), HTML);
    writeFileSync(join(dist, 'assets', 'index-a1.js'), 'export const a = 1;\n'.repeat(400));
    writeFileSync(join(dist, 'assets', 'vendor-react-b2.js'), 'export const r = 2;\n');
    writeFileSync(join(dist, 'assets', 'index-c3.css'), 'body{margin:0}\n');
    // Loaded later, so not part of the first visit however big it is.
    writeFileSync(join(dist, 'assets', 'monaco-d4.js'), 'x'.repeat(100_000));

    const measured = measureFirstLoad(dist);
    expect(measured.files.map((f) => f.file).sort()).toEqual(
      ['assets/index-a1.js', 'assets/index-c3.css', 'assets/vendor-react-b2.js', 'index.html'].sort()
    );
    expect(measured.total.raw).toBeLessThan(20_000);
    expect(measured.total.br).toBeLessThan(measured.total.raw);
    expect(renderReport(measured, 1)).toMatch(/Within the 1 KB gzip budget/);
    expect(renderReport(measured, 0.01)).toMatch(/Over the 0.01 KB gzip budget/);
  });
});
