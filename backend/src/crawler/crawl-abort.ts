import { EventEmitter } from 'events';
import type { Browser } from 'playwright';
import { logger } from '../utils/logger';

/**
 * Per-session abort controllers so Stop Crawl can halt an active job
 * and close the headed browser immediately.
 */
class CrawlAbortRegistry extends EventEmitter {
  private readonly controllers = new Map<string, AbortController>();
  /** Xpert uses two Chromium windows — track all of them for Stop Crawl. */
  private readonly browsers = new Map<string, Set<Browser>>();

  /** Start (or replace) an abort controller for this session. */
  begin(sessionId: string): AbortSignal {
    this.end(sessionId);
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    return controller.signal;
  }

  /** Track a live browser so Stop can close the window immediately. */
  registerBrowser(sessionId: string, browser: Browser | null | undefined): void {
    if (!browser) return;
    let set = this.browsers.get(sessionId);
    if (!set) {
      set = new Set();
      this.browsers.set(sessionId, set);
    }
    set.add(browser);
  }

  /** Request stop for a running crawl. Returns true if a controller existed. */
  stop(sessionId: string, reason = 'Stopped by user'): boolean {
    const controller = this.controllers.get(sessionId);
    const browserSet = this.browsers.get(sessionId);
    const hadBrowser = Boolean(browserSet && browserSet.size > 0);

    if (controller && !controller.signal.aborted) {
      controller.abort(reason);
      this.emit('abort', sessionId, reason);
    }

    // Close headed window(s) right away (don't wait for in-flight page.goto)
    if (browserSet && browserSet.size > 0) {
      this.browsers.delete(sessionId);
      for (const browser of browserSet) {
        void browser.close().then(
          () => logger.info(`[Stop] Browser closed for session ${sessionId}`),
          (err) => logger.warn(`[Stop] Browser close failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }

    return !!(controller || hadBrowser);
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
