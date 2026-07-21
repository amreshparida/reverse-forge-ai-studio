import { Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import type { PageState } from './types';

const OBSERVE_SCRIPT_PATH = path.join(__dirname, 'browser-observe.js');
let _observeScript: string | null = null;
function getObserveScript(): string {
  if (!_observeScript) _observeScript = fs.readFileSync(OBSERVE_SCRIPT_PATH, 'utf-8');
  return _observeScript;
}

import { UNSAFE_TEXT_PATTERNS } from '../crawler/safety';

/** Capture a compact, LLM-friendly snapshot of the current page */
export async function observePage(page: Page): Promise<PageState> {
  const unsafeSources = UNSAFE_TEXT_PATTERNS.map((r) => r.source);

  // Inject plain-JS script (no esbuild transformation — avoids __name issues)
  await page.evaluate(getObserveScript()).catch(() => undefined);

  return page.evaluate(
    (patterns: string[]) => {
      const fn = (window as unknown as Record<string, (p: string[]) => unknown>)['__reAiObserve'];
      if (typeof fn !== 'function') throw new Error('__reAiObserve not available');
      return fn(patterns) as PageState;
    },
    unsafeSources,
  );
}
