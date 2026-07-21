import { Page } from 'playwright';
import { logger } from '../utils/logger';
import { sleep } from '../utils/retry';
import { isSafeExplorationClick, isSessionEndingAction, isSessionEndingUrl, SESSION_END_HREF_RE } from '../crawler/safety';
import type { AgentAction, PageState } from './types';

function isHrefSafe(href: string | undefined): boolean {
  if (!href) return true;
  return !SESSION_END_HREF_RE.test(href) && !isSessionEndingUrl(href);
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

        // If it has a real http(s) navigation href (not in-page hash), navigate directly
        const href = el.href ?? '';
        const isHashNav = /^#|^javascript:/i.test(href) || /#$/.test(href);
        if (href.startsWith('http') && !isHashNav) {
          await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        } else {
          // Try to find and click the element
          const locator = page.locator(el.selector).first();
          const isVisible = await locator.isVisible({ timeout: 3000 }).catch(() => false);

          if (!isVisible) {
            // Fallback: find by text
            const byText = page.locator(`text="${el.text}"`).first();
            const textVisible = await byText.isVisible({ timeout: 2000 }).catch(() => false);
            if (textVisible) {
              await byText.click({ timeout: 8000 });
            } else {
              return { success: false, newUrl: beforeUrl, error: `Element not visible: ${el.text}` };
            }
          } else {
            await locator.click({ timeout: 8000 });
          }
        }

        // Wait for navigation or dynamic content
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
        const newPage = await page.context().newPage();
        await newPage.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await newPage.bringToFront();
        await sleep(600);
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
