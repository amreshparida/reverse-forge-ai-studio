import { Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

const OVERLAY_SCRIPT_PATH = path.join(__dirname, 'browser-overlay.js');
let _overlayScript: string | null = null;

function getOverlayScript(): string {
  if (!_overlayScript) {
    _overlayScript = fs.readFileSync(OVERLAY_SCRIPT_PATH, 'utf-8');
  }
  return _overlayScript;
}

export interface OverlayElement {
  index: number;
  selector: string;
  tag: string;
  isSafe: boolean;
  isNavigation: boolean;
  role?: string;
  type?: string;
}

/**
 * Inject colored numbered bounding boxes over every detected interactive
 * element on the page. Call removeElementOverlay() after taking the screenshot.
 *
 * Color legend:
 *   Blue   = navigation link / tab / menu item
 *   Green  = form input / select / textarea
 *   Orange = safe button
 *   Purple = other interactive element
 *   Red    = unsafe element (blocked by safety rules — never clicked)
 */
export async function injectElementOverlay(
  page: Page,
  elements: OverlayElement[],
): Promise<number> {
  try {
    // Inject the plain-JS overlay script (avoids esbuild __name issues)
    await page.evaluate(getOverlayScript()).catch(() => undefined);

    const labeled = await page.evaluate(
      (els: OverlayElement[]) => {
        const overlay = (window as unknown as Record<string, unknown>)['__reAiOverlay'] as
          | { inject: (e: OverlayElement[]) => number }
          | undefined;
        if (!overlay?.inject) return 0;
        return overlay.inject(els) ?? 0;
      },
      elements,
    );

    return labeled as number;
  } catch (err) {
    logger.debug(`[Overlay] Inject failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/** Remove the overlay after the screenshot has been taken. */
export async function removeElementOverlay(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const overlay = (window as unknown as Record<string, unknown>)['__reAiOverlay'] as
        | { remove: () => void }
        | undefined;
      overlay?.remove();
    });
  } catch {
    // Non-critical — page may have navigated away
  }
}
