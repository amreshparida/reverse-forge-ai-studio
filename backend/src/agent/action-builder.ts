import { Page } from 'playwright';
import { logger } from '../utils/logger';
import { sleep } from '../utils/retry';
import { isSafeExplorationClick, isSessionEndingAction, isSessionEndingUrl, SESSION_END_HREF_RE } from '../crawler/safety';
import { isAuxiliaryBrowserPage, waitForPageSettled } from '../crawler/new-page-follower';
import type { AgentAction, PageState } from './types';

async function waitForOpenedPage(page: Page, timeoutMs: number): Promise<Page | null> {
  const known = new Set(page.context().pages());
  const fromPopup = page.waitForEvent('popup', { timeout: timeoutMs }).catch(() => null);
  const fromContext = new Promise<Page | null>((resolve) => {
    const timer = setTimeout(() => {
      page.context().off('page', onPage);
      resolve(null);
    }, timeoutMs);
    const onPage = (opened: Page) => {
      if (known.has(opened) || isAuxiliaryBrowserPage(opened)) return;
      clearTimeout(timer);
      page.context().off('page', onPage);
      resolve(opened);
    };
    page.context().on('page', onPage);
  });
  return (await Promise.race([fromPopup, fromContext])) as Page | null;
}

async function adoptOpenedPage(opened: Page | null): Promise<ActionResult | null> {
  if (!opened || opened.isClosed() || isAuxiliaryBrowserPage(opened)) return null;
  const url = await waitForPageSettled(opened);
  if (!url || opened.isClosed()) return null;
  await opened.bringToFront().catch(() => undefined);
  return { success: true, newUrl: url, page: opened };
}

function isHrefSafe(href: string | undefined): boolean {
  if (!href) return true;
  return !SESSION_END_HREF_RE.test(href) && !isSessionEndingUrl(href);
}

/** Never click controls that close the browser tab/window. */
async function isWindowCloseLocator(locator: ReturnType<Page['locator']>): Promise<boolean> {
  const onclick = await locator.getAttribute('onclick').catch(() => null);
  if (onclick && /window\s*\.\s*close\s*\(|self\s*\.\s*close\s*\(/i.test(onclick)) return true;
  const href = await locator.getAttribute('href').catch(() => null);
  if (href && /javascript:\s*window\s*\.\s*close/i.test(href)) return true;
  return false;
}

/**
 * Resolve a click target by text first so generic selectors like button.btn.btn-sm
 * cannot hit an unrelated close button.
 */
async function resolveClickLocator(page: Page, el: PageState['interactiveElements'][number]) {
  const tag = el.tag || 'button';
  const text = (el.text || '').trim();
  if (text) {
    const byRole = page.getByRole(tag === 'a' ? 'link' : 'button', { name: text, exact: false }).first();
    if (await byRole.isVisible({ timeout: 1500 }).catch(() => false)) {
      if (!(await isWindowCloseLocator(byRole))) return byRole;
    }
    const byText = page.locator(`${tag}:visible`, { hasText: text }).first();
    if (await byText.isVisible({ timeout: 1500 }).catch(() => false)) {
      if (!(await isWindowCloseLocator(byText))) return byText;
    }
  }
  if (el.selector) {
    const bySel = page.locator(el.selector).first();
    if (await bySel.isVisible({ timeout: 1500 }).catch(() => false)) {
      if (await isWindowCloseLocator(bySel)) {
        return null;
      }
      // Guard: generic Bootstrap selectors must still match intended text
      if (text && /^(a|button|div|span)(\.(btn|btn-sm|btn-xs|btn-lg|pull-right|d-))/i.test(el.selector)) {
        const matchedText = ((await bySel.innerText().catch(() => '')) || '').trim();
        if (matchedText && !matchedText.toLowerCase().includes(text.toLowerCase().slice(0, 20))) {
          logger.warn(
            `ActionBuilder: selector "${el.selector}" matched "${matchedText.slice(0, 40)}" not "${text}" — refusing click`,
          );
          return null;
        }
      }
      return bySel;
    }
  }
  return null;
}

export interface ActionResult {
  success: boolean;
  newUrl: string;
  page?: Page;
  error?: string;
}

/**
 * ActionBuilder — executes a validated LLM action via Playwright.
 * This is the only place that touches the browser DOM.
 */
export async function executeAction(
  page: Page,
  action: AgentAction,
  state: PageState,
): Promise<ActionResult> {
  const beforeUrl = page.url();

  try {
    switch (action.type) {
      case 'click': {
        const el = state.interactiveElements.find((e) => e.index === action.elementIndex);
        if (!el) {
          return { success: false, newUrl: beforeUrl, error: `Element index ${action.elementIndex} not found` };
        }

        // Triple-check: never click logout / session-terminate / SSO end
        if (
          !el.isSafe ||
          isSessionEndingAction({ text: el.text, href: el.href }) ||
          !isSafeExplorationClick(el.text, el.href, [], { isFormSubmit: el.isFormSubmit, actionKind: el.actionKind }) ||
          !isHrefSafe(el.href)
        ) {
          logger.warn(`ActionBuilder: BLOCKED click on "${el.text}" (href: ${el.href}) — logout/session-end/unsafe`);
          return { success: false, newUrl: beforeUrl, error: `Blocked: "${el.text}" is a logout/session-end/unsafe element` };
        }

        logger.debug(`ActionBuilder: click [${el.index}] "${el.text}" (${el.selector})`);

        const href = el.href ?? '';
        const isHashNav = /^#|^javascript:/i.test(href) || /#$/.test(href);
        const openedPromise = waitForOpenedPage(page, 1_500);

        const locator = await resolveClickLocator(page, el);
        if (!locator) {
          return {
            success: false,
            newUrl: beforeUrl,
            error: `Could not safely resolve click target for "${el.text}" (blocked window.close / ambiguous selector)`,
          };
        }

        let clicked = false;
        await locator.click({ timeout: 8000 });
        clicked = true;

        const adopted = await adoptOpenedPage(await openedPromise);
        if (adopted) return adopted;

        if (!clicked && href.startsWith('http') && !isHashNav) {
          await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        } else if (!clicked) {
          return { success: false, newUrl: beforeUrl, error: `Element not visible: ${el.text}` };
        }

        // If this click closed the active tab, adopt another live page instead of killing the crawl.
        if (page.isClosed()) {
          const fallback = page.context().pages().find((p) => !p.isClosed() && !isAuxiliaryBrowserPage(p));
          if (fallback) {
            await waitForPageSettled(fallback);
            await fallback.bringToFront().catch(() => undefined);
            logger.warn(`ActionBuilder: active tab closed after click on "${el.text}" — switched to remaining tab`);
            return { success: true, newUrl: fallback.url(), page: fallback };
          }
          return { success: false, newUrl: beforeUrl, error: 'Active tab closed after click (no remaining pages)' };
        }

        // Wait for same-tab navigation or dynamic content
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
        await sleep(600);
        break;
      }

      case 'navigate': {
        if (!action.url) return { success: false, newUrl: beforeUrl, error: 'No URL provided' };
        if (!isHrefSafe(action.url)) {
          logger.warn(`ActionBuilder: BLOCKED navigate to "${action.url}" — logout/SSO URL`);
          return { success: false, newUrl: beforeUrl, error: `Blocked navigation to logout/SSO URL` };
        }
        logger.debug(`ActionBuilder: navigate → ${action.url}`);
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
        await sleep(600);
        break;
      }

      case 'input': {
        const el = state.interactiveElements.find((e) => e.index === action.elementIndex);
        if (!el || !action.value) return { success: false, newUrl: beforeUrl, error: 'Invalid input action' };
        logger.debug(`ActionBuilder: input "${action.value}" into ${el.selector}`);
        await page.fill(el.selector, action.value, { timeout: 5000 });
        await sleep(300);
        break;
      }

      case 'select': {
        const el = state.interactiveElements.find((e) => e.index === action.elementIndex);
        if (!el || !action.optionText) return { success: false, newUrl: beforeUrl, error: 'Invalid select action' };
        if (el.actionKind !== 'dropdown' && el.tag !== 'select') {
          return { success: false, newUrl: beforeUrl, error: `Element is not a dropdown: ${el.text}` };
        }
        logger.debug(`ActionBuilder: select "${action.optionText}" in ${el.selector}`);
        const locator = page.locator(el.selector).first();
        await locator.selectOption({ label: action.optionText }, { timeout: 5000 }).catch(async () => {
          await locator.selectOption(action.optionText!, { timeout: 5000 });
        });
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        await sleep(400);
        break;
      }

      case 'send_keys': {
        if (!action.keys) return { success: false, newUrl: beforeUrl, error: 'No keys provided' };
        logger.debug(`ActionBuilder: send keys "${action.keys}"`);
        await page.keyboard.press(action.keys, { delay: 30 }).catch(async () => {
          await page.keyboard.type(action.keys!, { delay: 20 });
        });
        await sleep(300);
        break;
      }

      case 'scroll': {
        const amount = typeof action.value === 'string' && /up/i.test(action.value) ? -500 : 500;
        await page.evaluate((dy) => window.scrollBy(0, dy), amount);
        await sleep(300);
        break;
      }

      case 'scroll_to_text': {
        if (!action.text) return { success: false, newUrl: beforeUrl, error: 'No scroll target text provided' };
        const found = await page.evaluate((target) => {
          const lower = target.toLowerCase();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            const text = node.textContent || '';
            if (text.toLowerCase().includes(lower)) {
              const parent = node.parentElement;
              parent?.scrollIntoView({ block: 'center', inline: 'nearest' });
              return true;
            }
            node = walker.nextNode();
          }
          return false;
        }, action.text);
        await sleep(400);
        return { success: found, newUrl: page.url(), error: found ? undefined : `Text not found: ${action.text}` };
      }

      case 'scroll_to_percent': {
        const yPercent = Math.max(0, Math.min(100, action.yPercent ?? 50));
        await page.evaluate((pct) => {
          const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          window.scrollTo(0, (pct / 100) * maxY);
        }, yPercent);
        await sleep(400);
        break;
      }

      case 'open_tab': {
        if (!action.url) return { success: false, newUrl: beforeUrl, error: 'No URL provided' };
        if (!isHrefSafe(action.url)) return { success: false, newUrl: beforeUrl, error: 'Blocked unsafe tab URL' };
        const openedPromise = waitForOpenedPage(page, 4_000);
        const newPage = await page.context().newPage();
        await newPage.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await newPage.bringToFront();
        await sleep(600);
        const extra = await openedPromise;
        if (extra && extra !== newPage && !extra.isClosed()) {
          const adopted = await adoptOpenedPage(extra);
          if (adopted) return adopted;
        }
        return { success: true, newUrl: newPage.url(), page: newPage };
      }

      case 'switch_tab': {
        const pages = page.context().pages();
        const target = pages[action.tabIndex ?? pages.length - 1];
        if (!target) return { success: false, newUrl: beforeUrl, error: 'Tab index not found' };
        await target.bringToFront();
        await sleep(300);
        return { success: true, newUrl: target.url(), page: target };
      }

      case 'close_tab': {
        const pages = page.context().pages();
        const target = pages[action.tabIndex ?? pages.length - 1];
        if (!target || pages.length <= 1) return { success: false, newUrl: beforeUrl, error: 'Cannot close selected tab' };
        await target.close();
        const current = page.context().pages().slice(-1)[0];
        await current?.bringToFront().catch(() => undefined);
        await sleep(300);
        return { success: true, newUrl: current?.url() ?? beforeUrl, page: current };
      }

      case 'back': {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => undefined);
        await sleep(500);
        break;
      }

      case 'done': {
        return { success: true, newUrl: beforeUrl };
      }
    }

    return { success: true, newUrl: page.url() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`ActionBuilder: action "${action.type}" failed: ${msg}`);
    return { success: false, newUrl: page.url(), error: msg };
  }
}
