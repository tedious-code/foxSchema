/**
 * What a browser downloads on a first visit to the built web app, and a budget
 * for it.
 *
 *   node scripts/bundle/first-load.mjs [apps/web/dist] [--budget-gzip-kb=240]
 *
 * The first visit is index.html plus what it names: the entry script, its
 * modulepreload links and the stylesheet. Everything else is fetched later, when
 * a view, panel or library is used. Sizes are given raw, gzip (level 9) and
 * Brotli (quality 11), the encodings the server sends from the build's
 * pre-compressed copies.
 *
 * The budget is on gzip, the encoding every browser accepts. Over budget means
 * something heavy is now imported statically on the first page; the report
 * lists the largest files to start from.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** The same-origin files index.html makes the browser fetch, in page order. */
export function firstLoadFiles(html) {
  const files = new Set();
  const tag = /<(script|link)\b[^>]*>/gi;
  for (const [element, name] of html.matchAll(tag)) {
    const attr = (key) => new RegExp(`\\b${key}=["']([^"']+)["']`, 'i').exec(element)?.[1];
    const url = name.toLowerCase() === 'script' ? attr('src') : attr('href');
    // Another origin (`https://…`, `//cdn…`, `data:`) is not part of this build.
    if (!url || url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
    if (name.toLowerCase() === 'link' && !/^(?:stylesheet|modulepreload)$/i.test(attr('rel') ?? '')) continue;
    files.add(url.replace(/^\//, ''));
  }
  return [...files];
}

/** Raw, gzip and Brotli bytes of one buffer. */
export function sizesOf(buffer) {
  return {
    raw: buffer.length,
    gzip: zlib.gzipSync(buffer, { level: 9 }).length,
    br: zlib.brotliCompressSync(buffer, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY },
    }).length,
  };
}

/** Sizes of index.html and every file it names, largest (gzip) first, with totals. */
export function measureFirstLoad(dist) {
  const html = fs.readFileSync(path.join(dist, 'index.html'));
  const files = [
    { file: 'index.html', ...sizesOf(html) },
    ...firstLoadFiles(html.toString('utf8')).map((file) => ({
      file,
      ...sizesOf(fs.readFileSync(path.join(dist, file))),
    })),
  ].sort((a, b) => b.gzip - a.gzip);
  const total = files.reduce(
    (sum, f) => ({ raw: sum.raw + f.raw, gzip: sum.gzip + f.gzip, br: sum.br + f.br }),
    { raw: 0, gzip: 0, br: 0 }
  );
  return { files, total };
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

export function renderReport({ files, total }, budgetGzipKb) {
  const rows = files.map((f) => `  ${kb(f.gzip).padStart(9)} gzip  ${kb(f.br).padStart(9)} br  ${kb(f.raw).padStart(10)} raw  ${f.file}`);
  const lines = [
    `First visit: ${files.length} files, ${kb(total.gzip)} gzip, ${kb(total.br)} Brotli, ${kb(total.raw)} raw`,
    ...rows,
  ];
  if (budgetGzipKb !== undefined) {
    const over = total.gzip / 1024 > budgetGzipKb;
    lines.push(
      over
        ? `Over the ${budgetGzipKb} KB gzip budget. Something heavy is imported statically on the first page; load it on demand (shared/lib/loadOnce, MountWhenOpened, app/shell/viewLoaders).`
        : `Within the ${budgetGzipKb} KB gzip budget.`
    );
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const dist = args.find((a) => !a.startsWith('--')) ?? 'apps/web/dist';
  const budgetArg = args.find((a) => a.startsWith('--budget-gzip-kb='));
  const budget = budgetArg ? Number(budgetArg.split('=')[1]) : undefined;
  const measured = measureFirstLoad(dist);
  console.log(renderReport(measured, budget));
  if (budget !== undefined && measured.total.gzip / 1024 > budget) process.exit(1);
}
