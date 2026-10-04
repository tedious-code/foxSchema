/** Types for diff-test-ids.mjs, for the tests that import it. */
export const MARKER: string;
export function idsIn(text: string): Set<string>;
export function renderDiff(before: Set<string>, after: Set<string>): string;
