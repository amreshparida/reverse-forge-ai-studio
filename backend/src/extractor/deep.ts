import { Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import type { ComprehensivePageData, TechStack, ConsoleEntry } from './types';
import { UNSAFE_TEXT_PATTERNS } from '../crawler/safety';

const BROWSER_SCRIPT_PATH = path.join(__dirname, 'browser-extract.js');

// Cache the script content so we only read the file once
let _scriptContent: string | null = null;
function getScriptContent(): string {
  if (!_scriptContent) {
    _scriptContent = fs.readFileSync(BROWSER_SCRIPT_PATH, 'utf-8');
  }
  return _scriptContent;
}

/** Standalone tech-stack detector (used by observer and other modules) */
export async function detectTechStack(page: Page): Promise<TechStack> {
  const data = await extractDeep(page, page.url());
  return data.techStack;
}

/**
 * Deep page extraction via a plain-JavaScript script injected directly
 * into the current page. The script file is never processed by esbuild/tsx,
 * avoiding the __name helper serialization issue.
 */
export async function extractDeep(
  page: Page,
  url: string,
  consoleErrors: ConsoleEntry[] = [],
): Promise<ComprehensivePageData> {
  const unsafeSources = UNSAFE_TEXT_PATTERNS.map((r) => r.source);

  // Inject the plain-JS extraction function into the current page context
  await page.evaluate(getScriptContent()).catch(() => undefined);

  const data = await page.evaluate(
    (patterns: string[]) => {
      const fn = (window as unknown as Record<string, (p: string[]) => unknown>)['__reAiExtract'];
      if (typeof fn !== 'function') throw new Error('__reAiExtract not available in page context');
      return fn(patterns);
    },
    unsafeSources,
  ) as unknown as Omit<ComprehensivePageData, 'consoleErrors'>;

  return { ...data, url, consoleErrors: consoleErrors.length ? consoleErrors : undefined };
}

