import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { getSessionStorageDir } from '../utils/file-system';

export interface SessionState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export async function saveSession(context: BrowserContext, projectSlug: string): Promise<string> {
  const storageDir = getSessionStorageDir(projectSlug);
  const statePath = path.join(storageDir, 'session.json');
  const state = await context.storageState();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  logger.info(`Session saved: ${statePath}`);
  return statePath;
}

export function sessionExists(projectSlug: string): boolean {
  const storageDir = getSessionStorageDir(projectSlug);
  const statePath = path.join(storageDir, 'session.json');
  return fs.existsSync(statePath);
}

export function getSessionPath(projectSlug: string): string {
  return path.join(getSessionStorageDir(projectSlug), 'session.json');
}

export interface LiveLoginSession {
  browser: Browser;
  context: BrowserContext;
  /** The page the user was on when they clicked Done — already authenticated */
  page: Page;
  /**
   * The exact URL captured at the moment the user clicked Done.
   * Use this as the crawl start URL — the page is ALREADY here, no navigation needed.
   */
  postLoginUrl: string;
}

/**
 * Opens a headed browser at the login page. A floating "Done" button is
 * injected on every page. When the user clicks it, the session is saved to
 * disk for future use AND the live browser + context are returned so the
 * crawler can continue in the SAME browser (already authenticated).
 * The caller is responsible for closing the browser when the crawl finishes.
 */
export async function waitForLoginAndSaveSession(
  loginUrl: string,
  projectSlug: string,
  onStatus?: (msg: string) => void,
): Promise<LiveLoginSession> {
  logger.info(`Opening browser at login page: ${loginUrl}`);
  onStatus?.('Browser opened — log in, then click the green button to start crawling.');

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  // ── Inject "Done" button ──────────────────────────────────────────────────
  const DONE_FLAG = '__RE_AI_LOGIN_DONE__';
  const URL_FLAG  = '__RE_AI_LOGIN_URL__';
  let loginDone = false;

  const injectDoneButton = async (): Promise<void> => {
    if (loginDone) return;
    await page
      .evaluate((flags: { done: string; url: string }) => {
        if ((window as unknown as Record<string, boolean>)[flags.done]) {
          document.getElementById('__re-ai-btn__')?.remove();
          return;
        }
        if (document.getElementById('__re-ai-btn__')) return;
        const btn = document.createElement('button');
        btn.id = '__re-ai-btn__';
        btn.textContent = '✓ Done — Start Crawling';
        btn.style.cssText = [
          'position:fixed', 'bottom:24px', 'right:24px', 'z-index:2147483647',
          'background:#4f46e5', 'color:#fff', 'border:none',
          'padding:12px 22px', 'border-radius:10px', 'font-size:14px',
          'font-weight:700', 'cursor:pointer', 'letter-spacing:.3px',
          'box-shadow:0 4px 18px rgba(0,0,0,.35)',
          'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
        ].join(';');
        btn.onmouseover = () => { btn.style.background = '#4338ca'; };
        btn.onmouseout  = () => { btn.style.background = '#4f46e5'; };
        btn.onclick = () => {
          // Capture exact URL at the moment of click — this is the crawl start URL
          (window as unknown as Record<string, string>)[flags.url] = window.location.href;
          (window as unknown as Record<string, boolean>)[flags.done] = true;
          btn.remove();
        };
        document.body?.appendChild(btn);
      }, { done: DONE_FLAG, url: URL_FLAG })
      .catch(() => undefined);
  };

  page.on('load', () => { void injectDoneButton(); });
  page.on('domcontentloaded', () => { void injectDoneButton(); });

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await injectDoneButton();

  logger.info('Waiting for user to complete login and click "Done — Start Crawling"…');
  onStatus?.('Log in to the application, then click the green "Done — Start Crawling" button.');

  // ── Wait for button click or browser close ────────────────────────────────
  let browserClosed = false;
  try {
    await Promise.race([
      page.waitForFunction(
        (flag: string) => !!(window as unknown as Record<string, boolean>)[flag],
        DONE_FLAG,
        { timeout: 600_000, polling: 500 },
      ),
      new Promise<void>((resolve) => {
        browser.on('disconnected', () => { browserClosed = true; resolve(); });
      }),
    ]);
  } catch {
    logger.warn('Login wait timed out — proceeding with current session state');
  }

  if (browserClosed) {
    // User force-closed the browser — we can't crawl, throw so the job fails cleanly
    throw new Error('Browser was closed before login was completed. Start a new crawl to try again.');
  }

  loginDone = true;
  await page.evaluate(() => {
    document.getElementById('__re-ai-btn__')?.remove();
  }).catch(() => undefined);

  logger.info('User confirmed login. Saving session for future crawls…');
  onStatus?.('Login confirmed — saving session for future use…');

  // Capture the exact URL at the moment Done was clicked
  const postLoginUrl = await page.evaluate(
    (flag: string) => (window as unknown as Record<string, string>)[flag] ?? window.location.href,
    URL_FLAG,
  ).catch(() => page.url());

  logger.info(`Post-login URL captured: ${postLoginUrl}`);

  // Save session to disk so future crawls don't need to login again
  try {
    const savedPath = await saveSession(context, projectSlug);
    const raw = fs.readFileSync(savedPath, 'utf-8');
    const state = JSON.parse(raw) as { cookies?: unknown[] };
    const cookieCount = state.cookies?.length ?? 0;
    logger.info(`Session saved with ${cookieCount} cookie(s). Crawl will continue in this browser.`);
    onStatus?.(`Session saved (${cookieCount} cookies). Starting crawl from ${postLoginUrl}…`);
  } catch (err) {
    logger.warn('Session save failed: ' + (err instanceof Error ? err.message : String(err)));
  }

  // ── Return the LIVE session — do NOT close the browser ───────────────────
  // The crawler will use this same context and page to crawl — already authenticated.
  // postLoginUrl is where to start crawling — the page is ALREADY there.
  return { browser, context, page, postLoginUrl };
}
