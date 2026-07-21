import { Page } from 'playwright';
import path from 'path';
import fs from 'fs';

export interface JsIntelligence {
  inlineScripts: string[];
  externalScripts: string[];
  windowGlobals: Record<string, { type: string; keys?: string[]; value?: string }>;
  reactComponents: string[];
  vueComponents: string[];
  clientRoutes: Array<{ path?: string; name?: string; framework?: string }>;
  storeShape: Record<string, { type: string; keys?: string[]; stores?: string[]; version?: string }>;
  appConfig: Record<string, Record<string, string>>;
  sourceMaps: string[];
  apiBaseUrls: Array<{ source: string; url: string }>;
  featureFlags: Record<string, boolean>;
  i18nKeys: string[];
  webWorkers: string[];
  serviceWorkers: string[];
  errors: string[];
}

const JS_INTEL_PATH = path.join(__dirname, 'js-intel.js');

let _jsIntelScript: string | null = null;
function getJsIntelScript(): string {
  if (!_jsIntelScript) {
    _jsIntelScript = fs.readFileSync(JS_INTEL_PATH, 'utf-8');
  }
  return _jsIntelScript;
}

/**
 * Extract JavaScript intelligence from the current page:
 * - Inline script contents
 * - Non-standard window globals (app config, feature flags)
 * - React/Vue component names
 * - Client-side routes
 * - State management store shapes (Redux, Zustand, Pinia, MobX, NgRx)
 * - API base URLs
 * - Source map references
 * - i18n translation keys
 */
export async function extractJsIntelligence(page: Page): Promise<JsIntelligence | null> {
  try {
    // Inject the script into the page
    await page.evaluate(getJsIntelScript()).catch(() => undefined);

    // Call the function
    const result = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, unknown>)['__reAiJsIntel'];
      if (typeof fn !== 'function') return null;
      return (fn as () => unknown)();
    }) as JsIntelligence | null;

    return result;
  } catch {
    return null;
  }
}
