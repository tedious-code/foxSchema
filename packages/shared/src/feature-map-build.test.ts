/**
 * The feature-map generator (scripts/feature-map/build.mjs): docs/feature-map.html
 * is built from docs/feature-map/ and the diagrams in docs/FEATURE_MAP.md.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPage, buildStaticPage } from '../../../scripts/feature-map/build.mjs';

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
});
