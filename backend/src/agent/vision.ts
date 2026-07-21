import type { Page } from 'playwright';
import { logger } from '../utils/logger';
import { injectElementOverlay, removeElementOverlay } from './overlay';
import { hideLiveLogOverlay, showLiveLogOverlay } from '../crawler/log-overlay';
import type { PageState } from './types';

export interface VisionCapture {
  dataUrl: string;
  labeledCount: number;
}

/**
 * Capture a small annotated viewport image for navigator LLM calls.
 * The numbered overlay matches PageState.interactiveElements indexes, so the
 * model can combine visual layout with the DOM action list.
 */
export async function captureNavigatorVision(
  page: Page,
  pageState: PageState,
): Promise<VisionCapture | null> {
  try {
    await hideLiveLogOverlay(page);
    const labeledCount = await injectElementOverlay(page, pageState.interactiveElements);
    const buffer = await page.screenshot({
      type: 'jpeg',
      quality: 62,
      fullPage: false,
      timeout: 10_000,
    });
    await removeElementOverlay(page);
    await showLiveLogOverlay(page);

    return {
      dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
      labeledCount,
    };
  } catch (err) {
    await removeElementOverlay(page).catch(() => undefined);
    await showLiveLogOverlay(page).catch(() => undefined);
    logger.debug(`[Vision] Navigator screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
