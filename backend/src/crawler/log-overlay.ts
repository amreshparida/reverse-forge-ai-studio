/**
 * Persistent live-log WINDOW (not injected into the crawled page).
 *
 * Injecting into the app page always flashes on navigation because the document
 * is destroyed. This module opens a separate popup that never navigates, so
 * logs stay put while the crawl tab moves page-to-page.
 */
import type { BrowserContext, Page } from 'playwright';
import { crawlLogBus, type CrawlLogEntry } from './live-log';
import { logger } from '../utils/logger';

const OVERLAY_MARKER = '__re_ai_live_log_window__';
const overlayPages = new WeakSet<Page>();

export function isLiveLogOverlayPage(page: Page): boolean {
  if (overlayPages.has(page)) return true;
  try {
    return page.url().includes(OVERLAY_MARKER);
  } catch {
    return false;
  }
}

export interface LogOverlayHandle {
  dispose: () => void;
  push: (entry: CrawlLogEntry) => void;
}

function buildOverlayHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" data-re-ai="${OVERLAY_MARKER}">
<head>
  <meta charset="utf-8" />
  <title>Live Crawl Log</title>
  <style>
    html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden; background:rgba(15,23,42,0.92); }
    body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#e5e7eb; display:flex; flex-direction:column; }
    #header {
      display:flex; align-items:center; justify-content:space-between; gap:8px;
      padding:8px 10px; background:rgba(0,0,0,0.35);
      border-bottom:1px solid rgba(255,255,255,0.12); cursor:move; user-select:none; flex-shrink:0;
    }
    #title { font-size:12px; font-weight:700; color:#f8fafc; }
    #count { font-size:10px; color:#94a3b8; margin-left:6px; font-weight:500; }
    #body {
      flex:1; overflow-y:auto; padding:6px 8px;
      font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      font-size:11px; line-height:1.35;
    }
    .row { display:flex; gap:6px; padding:3px 0; border-bottom:1px solid rgba(255,255,255,0.06); }
    .row:last-child { border-bottom:none; }
    .time { color:#64748b; flex-shrink:0; }
    .level { flex-shrink:0; text-transform:uppercase; font-weight:700; width:42px; }
    .msg { color:#f1f5f9; word-break:break-word; min-width:0; }
    .empty { color:#94a3b8; padding:8px 2px; }
  </style>
</head>
<body>
  <div id="header" title="Drag to move window">
    <div><span id="title">Live Crawl Log</span><span id="count">0 events</span></div>
  </div>
  <div id="body"><div class="empty">Waiting for crawler activity...</div></div>
  <script>
    (function () {
      var MAX = 300;
      var logs = [];

      function levelColor(level) {
        if (level === 'error') return '#fca5a5';
        if (level === 'warn') return '#fcd34d';
        if (level === 'debug') return '#9ca3af';
        return '#93c5fd';
      }
      function formatTime(iso) {
        try { return new Date(iso).toLocaleTimeString(); } catch (e) { return ''; }
      }
      function render() {
        document.getElementById('count').textContent = logs.length + ' events';
        var body = document.getElementById('body');
        body.innerHTML = '';
        if (!logs.length) {
          var empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = 'Waiting for crawler activity...';
          body.appendChild(empty);
          return;
        }
        for (var i = 0; i < logs.length; i++) {
          var e = logs[i];
          var row = document.createElement('div');
          row.className = 'row';
          var t = document.createElement('span'); t.className = 'time'; t.textContent = formatTime(e.timestamp);
          var l = document.createElement('span'); l.className = 'level'; l.style.color = levelColor(e.level); l.textContent = e.level || 'info';
          var m = document.createElement('span'); m.className = 'msg'; m.textContent = e.message || '';
          row.appendChild(t); row.appendChild(l); row.appendChild(m);
          body.appendChild(row);
        }
        body.scrollTop = body.scrollHeight;
      }

      window.__reAiLogOverlay = {
        append: function (entry) {
          if (!entry || !entry.message) return;
          if (entry.id != null) {
            for (var i = 0; i < logs.length; i++) if (logs[i].id === entry.id) return;
          }
          logs.push({
            id: entry.id,
            level: entry.level || 'info',
            message: String(entry.message),
            timestamp: entry.timestamp || new Date().toISOString(),
          });
          if (logs.length > MAX) logs = logs.slice(-MAX);
          render();
        },
        seed: function (entries) {
          if (!Array.isArray(entries)) return;
          for (var i = 0; i < entries.length; i++) window.__reAiLogOverlay.append(entries[i]);
        },
      };

      // Drag the OS window by the header
      var header = document.getElementById('header');
      var dragging = false, sx = 0, sy = 0;
      header.addEventListener('pointerdown', function (e) {
        if (e.button != null && e.button !== 0) return;
        dragging = true; sx = e.screenX; sy = e.screenY;
        try { header.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
      });
      header.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var dx = e.screenX - sx, dy = e.screenY - sy;
        sx = e.screenX; sy = e.screenY;
        try { window.moveBy(dx, dy); } catch (err) {}
      });
      header.addEventListener('pointerup', function () { dragging = false; });
      header.addEventListener('pointercancel', function () { dragging = false; });
    })();
  </script>
</body>
</html>`;
}

async function createOverlayWindow(context: BrowserContext): Promise<Page> {
  const pages = context.pages().filter((p) => !p.isClosed() && !isLiveLogOverlayPage(p));
  const opener = pages[pages.length - 1];

  let screen = { availWidth: 1440, availHeight: 900 };
  if (opener) {
    screen = await opener
      .evaluate(() => ({
        availWidth: window.screen.availWidth || 1440,
        availHeight: window.screen.availHeight || 900,
      }))
      .catch(() => screen);
  }

  const width = 440;
  const height = 320;
  const left = Math.max(0, screen.availWidth - width - 24);
  const top = Math.max(0, screen.availHeight - height - 48);

  let overlay: Page | null = null;

  if (opener) {
    try {
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 8000 }),
        opener.evaluate(
          ({ name, w, h, l, t }) => {
            window.open(
              'about:blank',
              name,
              `popup=yes,width=${w},height=${h},left=${l},top=${t},resizable=yes`,
            );
          },
          { name: OVERLAY_MARKER, w: width, h: height, l: left, t: top },
        ),
      ]);
      overlay = popup;
    } catch (err) {
      logger.warn(
        `[LogOverlay] Popup open failed, falling back to tab: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!overlay) {
    overlay = await context.newPage();
  }

  overlayPages.add(overlay);
  await overlay.setContent(buildOverlayHtml(), { waitUntil: 'domcontentloaded' });
  // Encode marker into history URL for isLiveLogOverlayPage checks after reloads
  await overlay
    .evaluate((marker) => {
      try {
        history.replaceState(null, '', `#${marker}`);
      } catch {
        /* ignore */
      }
      try {
        window.moveTo(
          Math.max(0, (window.screen.availWidth || 1440) - (window.outerWidth || 440) - 24),
          Math.max(0, (window.screen.availHeight || 900) - (window.outerHeight || 320) - 48),
        );
      } catch {
        /* ignore */
      }
    }, OVERLAY_MARKER)
    .catch(() => undefined);

  // Keep focus on the crawl page, not the log window
  if (opener && !opener.isClosed()) {
    await opener.bringToFront().catch(() => undefined);
  }

  logger.info('[LogOverlay] Persistent live log window opened (survives page navigations)');
  return overlay;
}

async function appendToOverlay(overlay: Page, entry: CrawlLogEntry): Promise<void> {
  if (overlay.isClosed()) return;
  await overlay
    .evaluate((e) => {
      (window as unknown as { __reAiLogOverlay?: { append: (x: typeof e) => void } })
        .__reAiLogOverlay?.append(e);
    }, entry)
    .catch(() => undefined);
}

/**
 * Open a persistent log window and mirror crawlLogBus events into it.
 * Does NOT inject into crawled pages — so navigations cannot flash/reset it.
 *
 * Chromium does not allow removing the OS close (X) button. If the user closes
 * the popup during a crawl, we reopen it immediately and restore recent logs.
 */
export function attachLiveLogOverlay(
  context: BrowserContext,
  sessionId: string,
): LogOverlayHandle {
  let overlay: Page | null = null;
  let disposed = false;
  let opening: Promise<void> = Promise.resolve();
  const pending: CrawlLogEntry[] = [];

  const seedOverlay = async (page: Page) => {
    const recent = crawlLogBus.getLogs(sessionId).slice(-120);
    for (const entry of [...recent, ...pending]) {
      await appendToOverlay(page, entry);
    }
    pending.length = 0;
  };

  const wireCloseGuard = (page: Page) => {
    // Soft block: confirm dialog if the page tries to unload via script
    page
      .evaluate(() => {
        window.addEventListener('beforeunload', (e) => {
          e.preventDefault();
          e.returnValue = '';
        });
      })
      .catch(() => undefined);

    page.on('close', () => {
      if (disposed) return;
      logger.info('[LogOverlay] Log window was closed — reopening (close is disabled during crawl)');
      overlay = null;
      opening = (async () => {
        try {
          // Brief yield so Chromium finishes tearing down the old popup
          await new Promise((r) => setTimeout(r, 150));
          if (disposed) return;
          const next = await createOverlayWindow(context);
          if (disposed) {
            await next.close().catch(() => undefined);
            return;
          }
          overlay = next;
          wireCloseGuard(next);
          await seedOverlay(next);
        } catch (err) {
          logger.warn(
            `[LogOverlay] Failed to reopen log window: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    });
  };

  opening = (async () => {
    try {
      overlay = await createOverlayWindow(context);
      if (disposed) {
        await overlay.close().catch(() => undefined);
        overlay = null;
        return;
      }
      wireCloseGuard(overlay);
      await seedOverlay(overlay);
    } catch (err) {
      logger.warn(
        `[LogOverlay] Failed to open log window: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();

  const onLog = (entry: CrawlLogEntry) => {
    if (entry.sessionId !== sessionId) return;
    void opening.then(async () => {
      if (!overlay || overlay.isClosed()) {
        pending.push(entry);
        return;
      }
      await appendToOverlay(overlay, entry);
    });
  };
  crawlLogBus.on('crawl:log', onLog);

  return {
    push: (entry) => onLog(entry),
    dispose: () => {
      disposed = true;
      crawlLogBus.off('crawl:log', onLog);
      if (overlay && !overlay.isClosed()) {
        void overlay.close().catch(() => undefined);
      }
      overlay = null;
      logger.debug(`[LogOverlay] Closed for session ${sessionId}`);
    },
  };
}

/** No-op: log UI lives in a separate window, not on the crawl page. */
export async function hideLiveLogOverlay(_page: Page): Promise<void> {
  /* intentionally empty */
}

/** No-op: log UI lives in a separate window, not on the crawl page. */
export async function showLiveLogOverlay(_page: Page): Promise<void> {
  /* intentionally empty */
}
