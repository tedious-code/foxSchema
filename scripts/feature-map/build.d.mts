/** Types for build.mjs, for the tests that import it. */
export interface FeatureMapSources {
  template: string;
  data: string;
  app: string;
  featureMap: string;
}
export function buildBoardPage(sources: FeatureMapSources): string;
export function buildStaticPage(boardPage: string): string;
export function readSources(root?: string): FeatureMapSources;
