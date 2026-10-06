/**
 * Allowlisted packages for SQL Editor JS/TS code cells, bundled for the browser.
 * The import parser itself lives in `@foxschema/sql` and is shared with the
 * Node executor — this module only supplies the browser's module namespaces.
 *
 * Every package is fetched when a cell first runs, never with the editor.
 * The executor's in-process fallback keeps this module in the SQL Editor's
 * store chunk, which loads on the first visit, so a static import here put
 * all of lodash and date-fns (150 kB) in front of every user, code cells or not.
 */

import { loadOnce } from '@/shared/lib/loadOnce';

export {
  CODE_CELL_ALLOWED_PACKAGES,
  parseCodeCellImports,
  type CodeCellAllowedPackage,
  type CodeCellImportSpec,
} from '@/shared/lib/sql-splitter';

/** lodash and date-fns, keyed by import specifier. */
const loadBundledPackages = loadOnce(async (): Promise<Record<string, object>> => {
  const [lodash, dateFns] = await Promise.all([import('lodash-es'), import('date-fns')]);
  return { lodash, 'lodash-es': lodash, 'date-fns': dateFns };
});

/** faker is ~400 kB, so only a cell that imports it pays for it. */
const loadFakerModule = loadOnce(async (): Promise<object> => {
  // Locale entry, not the package root: the root re-exports every locale.
  const { faker } = await import('@faker-js/faker/locale/en');
  // The real package has no default export, but a cell writing
  // `import faker from '@faker-js/faker'` should still get the instance.
  return { faker, default: faker };
});

/**
 * Module namespaces for one cell body: lodash and date-fns, plus faker when the
 * body imports it.
 */
export async function loadCodeCellPackageModules(
  body: string
): Promise<Record<string, object>> {
  const bundled = await loadBundledPackages();
  if (!body.includes('@faker-js/faker')) return bundled;
  return { ...bundled, '@faker-js/faker': await loadFakerModule() };
}
