/**
 * Dedicated Manual Crawl control window (not injected into the app page).
 * Opened from a sticky about:blank opener so app navigations do not close it.
 */
import type { BrowserContext, Page } from 'playwright';
import { logger } from '../utils/logger';

const CONTROL_MARKER = '__re_ai_manual_controls_window__';
const controlPages = new WeakSet<Page>();

export function isManualControlPage(page: Page): boolean {
  if (controlPages.has(page)) return true;
  try {
    const url = page.url();
    return url.includes(CONTROL_MARKER);
  } catch {
    return false;
  }
}

export interface ManualControlHandlers {
  onStart: () => Promise<{ capturing: boolean; message: string }>;
  onCapture: () => Promise<{ capturing: boolean; message: string }>;
  onFinish: () => Promise<{ capturing: boolean; message: string }>;
  getStatus: () => { capturing: boolean; message: string };
}

export interface ManualControlHandle {
  dispose: () => void;
  setStatus: (message: string, capturing?: boolean) => Promise<void>;
  page: Page;
}

function buildControlHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" data-re-ai="${CONTROL_MARKER}">
<head>
  <meta charset="utf-8" />
  <title>ReverseForge Manual Capture</title>
  <style>
    html, body {
      margin: 0; padding: 0; height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a; color: #f8fafc;
    }
    body { display: flex; flex-direction: column; padding: 16px; box-sizing: border-box; gap: 12px; }
    h1 { margin: 0; font-size: 16px; font-weight: 700; }
    #status {
      min-height: 40px; padding: 10px 12px; border-radius: 8px;
      background: #1e293b; color: #cbd5e1; font-size: 13px; line-height: 1.4;
    }
    .actions { display: flex; flex-direction: column; gap: 8px; }
    button {
      border: 0; border-radius: 8px; padding: 12px 14px; font-size: 14px;
      font-weight: 700; cursor: pointer; color: #fff;
    }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    #start { background: #16a34a; }
    #capture { background: #4f46e5; }
    #finish { background: #dc2626; }
    .hint { font-size: 12px; color: #94a3b8; line-height: 1.4; }
  </style>
</head>
<body>
  <h1>🧭 Manual Capture Controls</h1>
  <div id="status">Log in on the app window, then click Start capture.</div>
  <div class="actions">
    <button id="start" type="button">✓ Start capture</button>
    <button id="capture" type="button" disabled>Capture current state</button>
    <button id="finish" type="button">Finish &amp; save</button>
  </div>
  <div class="hint">
    Keep this control window open until Finish &amp; save.
    The app opens in a separate Chrome window — if that window crashes on a heavy report, this control window stays up and the app can be relaunched.
  </div>
  <script>
    (function () {
      var start = document.getElementById('start');
      var capture = document.getElementById('capture');
      var finish = document.getElementById('finish');
      var status = document.getElementById('status');

      window.__rfRender = function (state) {
        status.textContent = state.message || '';
        start.style.display = state.capturing ? 'none' : 'block';
        start.disabled = !!state.capturing;
        capture.disabled = !state.capturing;
        finish.disabled = false;
      };

      start.onclick = async function () {
        status.textContent = 'Starting capture…';
        try { window.__rfRender(await window.__rfStart()); }
        catch (e) { status.textContent = (e && e.message) || 'Start failed'; }
      };
      capture.onclick = async function () {
        status.textContent = 'Capturing…';
        try { window.__rfRender(await window.__rfCapture()); }
        catch (e) { status.textContent = (e && e.message) || 'Capture failed'; }
      };
      finish.onclick = async function () {
        start.disabled = true; capture.disabled = true; finish.disabled = true;
        status.textContent = 'Saving…';
        try { window.__rfRender(await window.__rfFinish()); }
        catch (e) { status.textContent = (e && e.message) || 'Finish failed'; }
      };
    })();
  </script>
</body>
</html>`;
}

async function wireControlPage(page: Page, handlers: ManualControlHandlers): Promise<void> {
  controlPages.add(page);
  await page.exposeFunction('__rfStart', () => handlers.onStart()).catch(() => undefined);
  await page.exposeFunction('__rfCapture', () => handlers.onCapture()).catch(() => undefined);
  await page.exposeFunction('__rfFinish', () => handlers.onFinish()).catch(() => undefined);
  await page.setContent(buildControlHtml(), { waitUntil: 'domcontentloaded' });
  await page.evaluate((marker) => {
    try {
      history.replaceState(null, '', `#${marker}`);
    } catch {
      /* ignore */
    }
  }, CONTROL_MARKER).catch(() => undefined);
  const initial = handlers.getStatus();
  await page.evaluate((state) => {
    (window as unknown as { __rfRender?: (s: { capturing: boolean; message: string }) => void }).__rfRender?.(state);
  }, initial).catch(() => undefined);
  await page.bringToFront().catch(() => undefined);
}

/**
 * Opens Manual Capture controls in their own Chromium context/browser so an
 * app-page crash (e.g. Essential Viewer OOM) cannot kill the control UI.
 */
export async function openManualControlWindow(
  context: BrowserContext,
  handlers: ManualControlHandlers,
): Promise<ManualControlHandle> {
  let page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 440 });
  await wireControlPage(page, handlers);
  logger.info('[Manual] Control window opened — use Start capture / Finish & save there');

  let disposed = false;
  let current = page;

  const reopen = async () => {
    if (disposed || !context.browser()?.isConnected()) return;
    logger.warn('[Manual] Control window was closed — reopening (do not close it until Finish)');
    try {
      current = await context.newPage();
      await current.setViewportSize({ width: 380, height: 440 });
      await wireControlPage(current, handlers);
      current.on('close', () => {
        if (!disposed) void reopen();
      });
    } catch (err) {
      logger.warn(`[Manual] Failed to reopen controls: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  current.on('close', () => {
    if (!disposed) void reopen();
  });

  return {
    get page() {
      return current;
    },
    setStatus: async (message, capturing) => {
      if (current.isClosed()) return;
      const state = {
        capturing: capturing ?? handlers.getStatus().capturing,
        message,
      };
      await current.evaluate((s) => {
        (window as unknown as { __rfRender?: (x: { capturing: boolean; message: string }) => void }).__rfRender?.(s);
      }, state).catch(() => undefined);
    },
    dispose: () => {
      disposed = true;
      if (!current.isClosed()) {
        void current.close().catch(() => undefined);
      }
    },
  };
}
