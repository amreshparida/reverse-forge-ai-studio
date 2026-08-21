import type { BrowserContext, Page } from 'playwright';
import { isLiveLogOverlayPage } from './log-overlay';
import { sleep } from '../utils/retry';
import { logger } from '../utils/logger';

export function isBlankOrNewTabUrl(url: string): boolean {
  const value = (url ?? '').trim().toLowerCase();
  return (
    !value
    || value === 'about:blank'
    || value === 'about:newtab'
    || value === 'about:srcdoc'
    || value.startsWith('chrome://')
    || value.startsWith('edge://')
    || value.startsWith('chrome-error://')
  );
}

export function isAuxiliaryBrowserPage(page: Page): boolean {
  if (isLiveLogOverlayPage(page)) return true;
  try {
    return page.url().includes('__re_ai_live_log_window__');
  } catch {
    return false;
  }
}

/** Wait until a popup/tab finishes its first real navigation when it starts blank. */
export async function waitForPageSettled(page: Page, timeoutMs = 15_000): Promise<string> {
  if (page.isClosed()) return '';
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
  if (!page.isClosed() && isBlankOrNewTabUrl(page.url())) {
    await page.waitForURL(
      (candidate) => !isBlankOrNewTabUrl(String(candidate)),
      { timeout: Math.min(8_000, timeoutMs) },
    ).catch(() => undefined);
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
  }
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
  await sleep(400);
  try {
    return page.isClosed() ? '' : page.url();
  } catch {
    return '';
  }
}

export function normalizePageUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.pathname.endsWith('/') && parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url.split('#')[0] ?? url;
  }
}

export interface NewPageFollower {
  dispose: () => void;
  takePending: () => Page | undefined;
  /** Take a pending page only if its settled URL matches (or is still blank / unknown). */
  takePendingForUrl: (url: string) => Page | undefined;
  waitForNewPage: (timeoutMs?: number) => Promise<Page | null>;
  adoptPage: (page: Page) => void;
  /** Mark a page as owned by the current crawler so siblings cannot steal it. */
  claimPage: (page: Page) => void;
  livePageForUrl: (url: string) => Page | undefined;
  consumeLivePage: (url: string) => Page | undefined;
  /** Ignore the next context.newPage() so crawler-owned tabs are not treated as popups. */
  runWithoutFollowing: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Follow every new browser tab/window in a Playwright context.
 * Skips the live-log overlay. Callers enqueue/capture via onNewPage.
 *
 * onPageCreated fires immediately (before URL settle) so callers can attach
 * network recorders before the first XHR/fetch completes.
 */
export function installNewPageFollower(
  context: BrowserContext,
  options?: {
    onPageCreated?: (page: Page) => void;
    onNewPage?: (page: Page, url: string) => void;
    shouldIgnore?: (page: Page) => boolean;
  },
): NewPageFollower {
  const pending: Page[] = [];
  const liveByUrl = new Map<string, Page>();
  const settledUrl = new WeakMap<Page, string>();
  const claimed = new WeakSet<Page>();
  const seen = new WeakSet<Page>();
  const waiters = new Set<(page: Page) => void>();
  let disposed = false;
  let ignoreProgrammatic = 0;

  const removeFromPending = (page: Page) => {
    const idx = pending.indexOf(page);
    if (idx >= 0) pending.splice(idx, 1);
  };

  const adoptPage = (page: Page) => {
    if (disposed || page.isClosed() || seen.has(page)) return;
    if (isAuxiliaryBrowserPage(page) || options?.shouldIgnore?.(page)) return;
    if (ignoreProgrammatic > 0) {
      seen.add(page);
      claimed.add(page);
      return;
    }
    seen.add(page);
    pending.push(page);

    try {
      options?.onPageCreated?.(page);
    } catch (err) {
      logger.warn(`[NewPage] onPageCreated failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter(page);
    }

    void (async () => {
      const url = await waitForPageSettled(page);
      if (!url || page.isClosed() || isAuxiliaryBrowserPage(page)) {
        removeFromPending(page);
        return;
      }
      settledUrl.set(page, url);
      liveByUrl.set(normalizePageUrlKey(url), page);
      logger.info(`[NewPage] Followed new tab/window: ${url}`);
      try {
        options?.onNewPage?.(page, url);
      } catch (err) {
        logger.warn(`[NewPage] onNewPage failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  const onPage = (page: Page) => adoptPage(page);
  context.on('page', onPage);

  const takeNextPending = (predicate?: (page: Page) => boolean): Page | undefined => {
    for (let i = 0; i < pending.length; i += 1) {
      const page = pending[i]!;
      if (page.isClosed() || isAuxiliaryBrowserPage(page) || claimed.has(page)) {
        pending.splice(i, 1);
        i -= 1;
        continue;
      }
      if (predicate && !predicate(page)) continue;
      pending.splice(i, 1);
      claimed.add(page);
      return page;
    }
    return undefined;
  };

  return {
    dispose: () => {
      disposed = true;
      context.off('page', onPage);
      waiters.clear();
      pending.length = 0;
      liveByUrl.clear();
    },
    takePending: () => takeNextPending(),
    takePendingForUrl: (url: string) => {
      const key = normalizePageUrlKey(url);
      return takeNextPending((page) => {
        const settled = settledUrl.get(page);
        if (!settled) return true; // still settling — allow claim for expected navigation
        return normalizePageUrlKey(settled) === key;
      });
    },
    waitForNewPage: async (timeoutMs = 3_000) => {
      const already = takeNextPending();
      if (already) return already;

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve(null);
        }, timeoutMs);
        const waiter = (page: Page) => {
          clearTimeout(timer);
          if (claimed.has(page) || page.isClosed() || isAuxiliaryBrowserPage(page)) {
            resolve(null);
            return;
          }
          claimed.add(page);
          removeFromPending(page);
          resolve(page);
        };
        waiters.add(waiter);
      });
    },
    adoptPage,
    claimPage: (page: Page) => {
      claimed.add(page);
      seen.add(page);
      removeFromPending(page);
    },
    livePageForUrl: (url: string) => {
      const page = liveByUrl.get(normalizePageUrlKey(url));
      if (!page || page.isClosed()) {
        liveByUrl.delete(normalizePageUrlKey(url));
        return undefined;
      }
      return page;
    },
    consumeLivePage: (url: string) => {
      const key = normalizePageUrlKey(url);
      const page = liveByUrl.get(key);
      liveByUrl.delete(key);
      if (!page || page.isClosed() || claimed.has(page)) return undefined;
      claimed.add(page);
      removeFromPending(page);
      return page;
    },
    runWithoutFollowing: async (fn) => {
      ignoreProgrammatic += 1;
      try {
        return await fn();
      } finally {
        ignoreProgrammatic -= 1;
      }
    },
  };
}
