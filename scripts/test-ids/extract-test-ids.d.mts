/** Types for extract-test-ids.mjs, for the tests that import it. */
export interface TestIdEntry {
  pattern: string;
  params: string[];
  fromProps?: boolean;
  area: string;
  component: string;
  file: string;
  line: number;
  element: string;
  description: string;
}
export interface MissingTestId {
  file: string;
  line: number;
  element: string;
  description: string;
}
export interface TestIdCatalog {
  entries: TestIdEntry[];
  missing: MissingTestId[];
}
export const REPO_ROOT: string;
export const WEB_ROOT: string;
export const MARKDOWN_PATH: string;
export const TYPESCRIPT_PATH: string;
export const SHARED_IDS: Record<string, string>;
export function collectTestIds(root?: string): TestIdCatalog;
export function duplicates(catalog: TestIdCatalog): Array<[string, string[]]>;
export function controlsWithId(catalog: TestIdCatalog): number;
export function renderMarkdown(catalog: TestIdCatalog): string;
export function renderTypeScript(catalog: TestIdCatalog): string;
