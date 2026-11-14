/**
 * The feature-map generator (scripts/feature-map/build.mjs): docs/architecture/feature-map.html
 * is built from docs/architecture/feature-map/ and the diagrams in docs/architecture/FEATURE_MAP.md.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBoardPage, buildStaticPage, readSources } from '../../../scripts/feature-map/build.mjs';

const featureMap = '# Map\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\n```mermaid\nflowchart LR\n  c[x < y & z]\n```\n';
const template = '<title>T</title>\n<header class="top"></header>\n<pre class="mermaid">__M1__</pre>\n<script>\n/*__DATA__*/\n/*__APP__*/\n</script>';

describe('feature map build', () => {
  it('places the named diagram, escaped, and the data and script as written', () => {
    const page = buildBoardPage({ template, data: "const A = 'cost: $& and $1';", app: 'run();', featureMap });
    expect(page).toContain('<pre class="mermaid">flowchart LR\n  c[x &lt; y &amp; z]</pre>');
    // A `$` pattern in the sources is text, not a replacement pattern.
    expect(page).toContain("const A = 'cost: $& and $1';");
    expect(page).toContain('run();');
  });

  it('refuses a template that places a diagram the doc does not have', () => {
    expect(() =>
      buildBoardPage({ template: template.replace('__M1__', '__M2__'), data: '', app: '', featureMap })
    ).toThrow(/diagram 2; FEATURE_MAP.md has only 2/);
  });

  it('wraps the repo copy in a whole document with the board off', () => {
    const page = buildStaticPage(buildBoardPage({ template, data: '', app: '', featureMap }));
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<title>T</title>\n</head>\n<body>\n<script>window.FOX_MAP_STATIC = true;</script>\n<header class="top">');
    expect(page).toContain('mermaid@11.4.1');
  });

  // The page is generated: an edit made to it by hand is lost on the next build.
  // Edit docs/architecture/feature-map/ or FEATURE_MAP.md, then run `npm run docs:feature-map`.
  it('docs/architecture/feature-map.html is what the build writes', () => {
    const built = buildStaticPage(buildBoardPage(readSources()));
    const committed = readFileSync(new URL('../../../docs/architecture/feature-map.html', import.meta.url), 'utf8');
    expect(committed === built, 'docs/architecture/feature-map.html is stale: run npm run docs:feature-map').toBe(true);
  });
});
