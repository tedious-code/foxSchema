/** Types for first-load.mjs, for the tests that import it. */
export interface Sizes {
  raw: number;
  gzip: number;
  br: number;
}
export function firstLoadFiles(html: string): string[];
export function sizesOf(buffer: Buffer): Sizes;
export function measureFirstLoad(dist: string): { files: ({ file: string } & Sizes)[]; total: Sizes };
export function renderReport(measured: { files: ({ file: string } & Sizes)[]; total: Sizes }, budgetGzipKb?: number): string;
