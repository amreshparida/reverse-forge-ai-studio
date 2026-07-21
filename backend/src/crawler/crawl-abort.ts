import { EventEmitter } from 'events';
import type { Browser } from 'playwright';
import { logger } from '../utils/logger';

/**
 * Per-session abort controllers so Stop Crawl can halt an active job
 * and close the headed browser immediately.
 */
class CrawlAbortRegistry extends EventEmitter {
  private readonly controllers = new Map<string, AbortController>();
  private readonly browsers = new Map<string, Browser>();

  /** Start (or replace) an abort controller for this session. */
  begin(sessionId: string): AbortSignal {
    this.end(sessionId);
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    return controller.signal;
  }

  /** Track the live browser so Stop can close the window immediately. */
  registerBrowser(sessionId: string, browser: Browser | null | undefined): void {
    if (!browser) return;
    this.browsers.set(sessionId, browser);
  }

  /** Request stop for a running crawl. Returns true if a controller existed. */
  stop(sessionId: string, reason = 'Stopped by user'): boolean {
    const controller = this.controllers.get(sessionId);
    const browser = this.browsers.get(sessionId);

    if (controller && !controller.signal.aborted) {
      controller.abort(reason);
      this.emit('abort', sessionId, reason);
    }

    // Close headed window right away (don't wait for in-flight page.goto)
    if (browser) {
      this.browsers.delete(sessionId);
      void browser.close().then(
        () => logger.info(`[Stop] Browser closed for session ${sessionId}`),
        (err) => logger.warn(`[Stop] Browser close failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }

    return !!(controller || browser);
  }

  /** Drop the controller after the crawl finishes. */
  end(sessionId: string): void {
    this.controllers.delete(sessionId);
    this.browsers.delete(sessionId);
  }

  isAborted(sessionId: string): boolean {
    return this.controllers.get(sessionId)?.signal.aborted === true;
  }
}

export const crawlAbortRegistry = new CrawlAbortRegistry();
