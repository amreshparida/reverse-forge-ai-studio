/**
 * Hard stop for logout / session-kill navigations and clicks during a crawl.
 * Queue filters are not enough — BFS interaction clicks can still hit Logout
 * (e.g. ITMS avatar menu → logouta.get). This aborts those document requests
 * and swallows logout clicks in the page.
 */
import type { BrowserContext, Page } from 'playwright';
import { isSessionEndingUrl, SESSION_END_HREF_PATTERN_SOURCE } from './safety';
import { logger } from '../utils/logger';

const OVERLAY_MARKER = '__re_ai_live_log_window__';

const CLICK_GUARD_SOURCE = `
(function() {
  if (window.__RE_AI_SESSION_END_GUARD__) return;
  window.__RE_AI_SESSION_END_GUARD__ = true;
  var HREF_RE = /${SESSION_END_HREF_PATTERN_SOURCE}/i;
  var TEXT_RE = /log[\\s_-]*out|sign[\\s_-]*out|signout|sign[\\s_-]*off|log[\\s_-]*off|end[\\s_-]*session|kill[\\s_-]*session|terminate[\\s_-]*session|wb-power/i;
  function isBlocked(el) {
    if (!el || !el.closest) return false;
    var node = el.closest('a, button, [role="menuitem"], [role="link"], [data-href], [data-url], [data-route], [data-action]');
    if (!node) return false;
    var href = '';
    try { href = node.href || ''; } catch (e) {}
    href = href || node.getAttribute('href') || node.getAttribute('data-href') ||
      node.getAttribute('data-url') || node.getAttribute('data-route') ||
      node.getAttribute('data-action') || '';
    var text = ((node.textContent || '') + ' ' + (node.getAttribute('aria-label') || '') + ' ' +
      (node.getAttribute('title') || '') + ' ' + (node.id || '') + ' ' +
      (node.className ? node.className.toString() : '')).trim();
    if (href && HREF_RE.test(href)) return true;
    if (text && TEXT_RE.test(text)) return true;
    return false;
  }
  document.addEventListener('click', function(e) {
    if (isBlocked(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      console.warn('[RE-AI] Blocked logout/session-end click');
    }
  }, true);
})();
`;

function isOverlayPage(page: Page): boolean {
  try {
    return page.url().includes(OVERLAY_MARKER);
  } catch {
    return false;
  }
}

/**
 * Install context-wide guards that prevent navigating to or clicking
 * logout / session-end controls. Safe to call once per crawl context.
 */
export async function installSessionEndGuard(context: BrowserContext): Promise<void> {
  // Abort top-level document navigations to logout / SSO end URLs
  await context.route('**/*', async (route) => {
    try {
      const req = route.request();
      const url = req.url();
      if (req.resourceType() === 'document' && isSessionEndingUrl(url)) {
        logger.warn(`[Safety] Blocked session-end navigation: ${url}`);
        await route.abort('blockedbyclient');
        return;
      }
    } catch {
      /* fall through */
    }
    await route.continue().catch(() => undefined);
  });

  // Swallow logout clicks before they navigate (covers JS handlers too when href matches)
  await context.addInitScript({ content: CLICK_GUARD_SOURCE }).catch(() => undefined);

  for (const page of context.pages()) {
    if (page.isClosed() || isOverlayPage(page)) continue;
    await injectClickGuard(page);
  }

  context.on('page', (page) => {
    if (isOverlayPage(page)) return;
    void injectClickGuard(page);
  });

  logger.info('[Safety] Session-end navigation/click guard installed');
}

async function injectClickGuard(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page.addInitScript({ content: CLICK_GUARD_SOURCE }).catch(() => undefined);
  await page.evaluate(CLICK_GUARD_SOURCE).catch(() => undefined);
}
