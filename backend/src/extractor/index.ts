import { Page } from 'playwright';
import { extractDeep } from './deep';
import type { ComprehensivePageData, ConsoleEntry } from './types';

export type { ComprehensivePageData, ConsoleEntry, TechStack } from './types';
export { detectTechStack } from './deep';
export type PageExtractedData = ComprehensivePageData;

export async function extractPageData(
  page: Page,
  url: string,
  _safeSelectors: string[] = [],
  consoleErrors: ConsoleEntry[] = [],
): Promise<ComprehensivePageData> {
  return extractDeep(page, url, consoleErrors);
}
