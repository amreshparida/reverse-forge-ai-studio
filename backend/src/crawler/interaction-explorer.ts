import type { Page } from 'playwright';
import { observePage } from '../agent/observer';
import { extractPageData } from '../extractor';
import { isSafeExplorationClick, isSessionEndingAction, isSessionEndingUrl, isUrlSafe } from './safety';
import { sleep } from '../utils/retry';
import { logger } from '../utils/logger';

export interface InteractionSnapshot {
  actionText: string;
  actionKind: string;
  url: string;
  discoveredLinks: string[];
  extractedData: unknown | null;
}

export interface InteractionExploreResult {
  links: string[];
  snapshots: InteractionSnapshot[];
}

export interface InteractionExploreOptions {
  allowedDomains: string[];
  excludedUrls: string[];
  safeSelectors?: string[];
  visitedActionKeys?: Set<string>;
  maxClicks?: number;
}

const LOW_VALUE_RE = /^(next|previous|prev|\d+|last|first)$/i;
/** Account / avatar menus almost always contain Logout — never open them during exploration */
const ACCOUNT_MENU_RE = /avatar|navbar-avatar|dropdown-toggle|user-menu|account-menu|wb-power|profile-menu/i;

function isInPageHashHref(href: string | null | undefined): boolean {
  if (!href) return true;
  if (/^#|^javascript:/i.test(href)) return true;
  try {
    const u = new URL(href);
    // Browser resolves href="#" to https://host/path# — treat as in-page
    return u.hash === '#' || (u.hash === '' && /#$/.test(href));
  } catch {
    return false;
  }
}

export async function exploreSafeInteractions(
  page: Page,
  currentUrl: string,
  options: InteractionExploreOptions,
): Promise<InteractionExploreResult> {
  const visitedActionKeys = options.visitedActionKeys ?? new Set<string>();
  const maxClicks = options.maxClicks ?? 10;
  const state = await observePage(page).catch(() => null);
  if (!state) return { links: [], snapshots: [] };

  const candidates = state.interactiveElements
    .filter((el) => {
      if (!el.isSafe) return false;
      if (!isSafeExplorationClick(el.text, el.href, options.safeSelectors ?? [], { isFormSubmit: el.isFormSubmit, actionKind: el.actionKind })) return false;
      if (isSessionEndingAction({ text: el.text, href: el.href })) return false;
      if (el.href && isSessionEndingUrl(el.href)) return false;
      if (el.href && !isInPageHashHref(el.href) && !/^javascript:/i.test(el.href)) return false;
      if (ACCOUNT_MENU_RE.test(`${el.selector} ${el.text} ${el.href ?? ''}`)) return false;
      if (el.actionKind === 'pagination' || LOW_VALUE_RE.test(el.text)) return false;
      if (visitedActionKeys.has(el.actionKey ?? `${el.actionKind}:${el.text.toLowerCase()}`)) return false;
      return ['modal', 'form-open', 'detail', 'toggle', 'table-action', 'other'].includes(el.actionKind ?? 'other');
    })
    .sort((a, b) => score(b) - score(a))
    .slice(0, maxClicks);

  const links = new Set<string>();
  const snapshots: InteractionSnapshot[] = [];
  const startUrl = page.url();

  for (const el of candidates) {
    const actionKey = el.actionKey ?? `${el.actionKind}:${el.text.toLowerCase()}`;
    visitedActionKeys.add(actionKey);

    const beforeUrl = page.url();
    try {
      const locator = page.locator(el.selector).first();
      if (!(await locator.isVisible({ timeout: 1500 }).catch(() => false))) continue;

      // Live DOM check — observed metadata can be stale / wrong selector
      const blocked = await locator.evaluate((node) => {
        const href = (node as HTMLAnchorElement).href || node.getAttribute('href') ||
          node.getAttribute('data-href') || '';
        const text = ((node.textContent || '') + ' ' + (node.getAttribute('aria-label') || '')).trim();
        const onclick = node.getAttribute('onclick') || '';
        if (/window\s*\.\s*close\s*\(|self\s*\.\s*close\s*\(/i.test(onclick + ' ' + href)) return true;
        const blob = [node.id, (node as HTMLElement).className, text, href].join(' ');
        return /log[_\\s-]*out|sign[_\\s-]*out|signout|wb-power|logouta/i.test(blob);
      }).catch(() => false);
      if (blocked) {
        logger.info(`[InteractionExplorer] Skipped logout/session-end/window.close control: "${el.text}"`);
        continue;
      }

      // Prefer text match over generic class selectors (btn.btn-sm often hits window.close)
      const text = (el.text || '').trim();
      const clickTarget = text
        ? page.locator(`${el.tag || 'button'}:visible`, { hasText: text }).first()
        : locator;
      if (!(await clickTarget.isVisible({ timeout: 1500 }).catch(() => false))) continue;
      const closesWindow = await clickTarget.evaluate((node) => {
        const onclick = node.getAttribute('onclick') || '';
        const href = node.getAttribute('href') || '';
        return /window\s*\.\s*close\s*\(|self\s*\.\s*close\s*\(/i.test(onclick + ' ' + href);
      }).catch(() => false);
      if (closesWindow) {
        logger.info(`[InteractionExplorer] Skipped window.close control: "${el.text}"`);
        continue;
      }

      await clickTarget.click({ timeout: 5000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      await sleep(500);

      const afterUrl = page.url();
      if (afterUrl !== beforeUrl) {
        if (isSessionEndingUrl(afterUrl) || !isUrlSafe(afterUrl, options.allowedDomains, options.excludedUrls)) {
          logger.warn(`[InteractionExplorer] Navigation hit unsafe/session-end URL — restoring: ${afterUrl}`);
          await page.goto(beforeUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => undefined);
          await sleep(400);
          continue;
        }
        if (isUrlSafe(afterUrl, options.allowedDomains, options.excludedUrls)) links.add(afterUrl);
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(async () => {
          await page.goto(beforeUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => undefined);
        });
        await sleep(400);
        continue;
      }
    } catch (err) {
      logger.debug(`[InteractionExplorer] Skipped "${el.text}": ${err instanceof Error ? err.message : String(err)}`);
      await closeTransientSurface(page);
      if (page.url() !== beforeUrl) {
        await page.goto(beforeUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => undefined);
      }
      continue;
    }

    try {
      const discoveredLinks = await collectLinks(page, currentUrl, options.allowedDomains, options.excludedUrls);
      discoveredLinks.forEach((link) => links.add(link));

      const afterUrl = page.url();
      const hasInterestingSurface = await page.evaluate(() => {
        const visibleDialog = Array.from(document.querySelectorAll('[role="dialog"], .modal, [class*="Modal"], [class*="modal"]'))
          .some((node) => {
            const style = window.getComputedStyle(node as HTMLElement);
            return style.display !== 'none' && style.visibility !== 'hidden' && (node as HTMLElement).offsetParent !== null;
          });
        return visibleDialog || document.querySelectorAll('form, [role="form"], input, textarea, select').length > 0;
      }).catch(() => false);

      snapshots.push({
        actionText: el.text,
        actionKind: el.actionKind ?? 'other',
        url: afterUrl,
        discoveredLinks,
        extractedData: hasInterestingSurface ? await extractPageData(page, afterUrl, options.safeSelectors ?? []).catch(() => null) : null,
      });

      await closeTransientSurface(page);
    } catch (err) {
      logger.debug(`[InteractionExplorer] Post-click skipped "${el.text}": ${err instanceof Error ? err.message : String(err)}`);
      await closeTransientSurface(page);
      if (page.url() !== beforeUrl) {
        await page.goto(beforeUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => undefined);
      }
    }
  }

  if (page.url() !== startUrl) {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => undefined);
  }

  return { links: [...links], snapshots };
}

async function collectLinks(page: Page, currentUrl: string, allowedDomains: string[], excludedUrls: string[]): Promise<string[]> {
  const base = new URL(currentUrl);
  const hrefs = await page.evaluate(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    const add = (href: string | null) => {
      if (href && !seen.has(href)) {
        seen.add(href);
        result.push(href);
      }
    };
    document.querySelectorAll('a[href]').forEach((el) => add((el as HTMLAnchorElement).href));
    document.querySelectorAll('[data-href], [data-url], [data-route]').forEach((el) => {
      add(el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-route'));
    });
    return result;
  }).catch(() => []);

  return [...new Set(hrefs.flatMap((href) => {
    try {
      const resolved = new URL(href, base.toString()).toString();
      return isUrlSafe(resolved, allowedDomains, excludedUrls) ? [resolved] : [];
    } catch {
      return [];
    }
  }))];
}

async function closeTransientSurface(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => undefined);
  await sleep(150);
  const closeSelectors = [
    '[aria-label="Close"]',
    '[aria-label="close"]',
    '.btn-close',
    '[data-bs-dismiss="modal"]',
    '[data-dismiss="modal"]',
  ];
  for (const selector of closeSelectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: 300 }).catch(() => false)) {
      await locator.click({ timeout: 1000 }).catch(() => undefined);
      break;
    }
  }
}

function score(el: { actionKind?: string; text: string }): number {
  const kind = el.actionKind ?? 'other';
  const weights: Record<string, number> = {
    modal: 100,
    'form-open': 90,
    detail: 80,
    'table-action': 55,
    toggle: 40,
    other: 10,
  };
  const readOnlyHint = /view|detail|preview|open|show|create|new|add|edit/i.test(el.text) ? 10 : 0;
  return (weights[kind] ?? 0) + readOnlyHint;
}
