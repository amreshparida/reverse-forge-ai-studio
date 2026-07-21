import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import { logger } from '../utils/logger';
import { prisma } from '../database/client';
import { isUrlSafe } from './safety';
import { browserClosedMessage, isBrowserClosedError } from './browser-closed';
import { getSessionPath, sessionExists, waitForLoginAndSaveSession } from './session';
import { extractPageData } from '../extractor';
import { exploreSafeInteractions } from './interaction-explorer';
import { emitCrawlLog } from './live-log';
import { attachLiveLogOverlay, hideLiveLogOverlay, showLiveLogOverlay, isLiveLogOverlayPage, type LogOverlayHandle } from './log-overlay';
import { installSessionEndGuard } from './session-end-guard';
import { crawlAbortRegistry } from './crawl-abort';
import { extractJsIntelligence } from '../extractor/js-intelligence';
import {
  fetchGraphQLSchema,
  fetchOpenApiSpec,
  fetchSourceMaps,
  captureCookieStructure,
  captureIndexedDbSchema,
  extractResponseHeaders,
  captureMobileView,
  detectSseEndpoints,
} from '../extractor/advanced-capture';
import { createNetworkRecorder, createWebSocketRecorder } from '../recorder';
import {
  getScreenshotsDir,
  getHtmlDir,
  getPagesDir,
  getApiDir,
  writeJson,
  writeText,
  urlToFilename,
} from '../utils/file-system';
import { sleep } from '../utils/retry';
import { config } from '../config';
import type { Project, CrawlSession } from '@prisma/client';

export interface CrawlOptions {
  project: Project;
  session: CrawlSession;
  projectSlug: string;
  onProgress?: (info: CrawlProgressInfo) => void;
  abortSignal?: AbortSignal;
}

export interface CrawlProgressInfo {
  visitedCount: number;
  queuedCount: number;
  currentUrl: string;
  status: string;
}

interface QueueEntry {
  url: string;
  depth: number;
  parentUrl?: string;
}

/** Absolute path to the output dir — used to compute /static/ URLs for screenshots */
const outputAbsDir = path.resolve(process.cwd(), config.outputDir);

function isLoginPage(url: string): boolean {
  return (
    /\/(login|signin|sign-in|auth|sso|oauth|logout)\b/i.test(url) ||
    // SSO / SAML redirect patterns
    /discovery\?entityID=/i.test(url) ||
    /Shibboleth\.sso/i.test(url) ||
    /returnIDParam=idp/i.test(url) ||
    /\/idp\//i.test(url) ||
    /\/adfs\//i.test(url) ||
    /SingleSignOn/i.test(url) ||
    /\/(saml|saml2|wsFed)\//i.test(url)
  );
}

export async function runCrawl(options: CrawlOptions): Promise<void> {
  const { project, session, projectSlug, onProgress, abortSignal } = options;

  const allowedDomains: string[] = JSON.parse(project.allowedDomains || '[]') as string[];
  const excludedUrls: string[] = JSON.parse(project.excludedUrls || '[]') as string[];
  const safeSelectors: string[] = JSON.parse(project.safeClickSelectors || '[]') as string[];
  const maxDepth = project.crawlDepth;

  const visited = new Set<string>();
  const visitedActionKeys = new Set<string>();
  const queue: QueueEntry[] = [{ url: project.baseUrl, depth: 0 }];

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let logOverlay: LogOverlayHandle | null = null;
  /** Headed browser (login always headed, or CRAWL_HEADLESS=false) */
  let headed = false;

  // Default allowed domain from base URL
  try {
    const baseHostname = new URL(project.baseUrl).hostname;
    if (allowedDomains.length === 0) {
      allowedDomains.push(baseHostname);
    }
  } catch {
    logger.warn('Could not parse baseUrl hostname');
  }

  try {
    // ── Step 1: Login if required ─────────────────────────────────────────
    if (project.loginRequired) {
      await prisma.crawlSession.update({
        where: { id: session.id },
        data: { status: 'awaiting_login', errorMessage: 'Browser opened — please log in to continue.' },
      }).catch(() => undefined);

      const loginUrl = project.loginUrl || project.baseUrl;

      // waitForLoginAndSaveSession returns the LIVE browser + context.
      // We use that same context for crawling — already authenticated, no new browser needed.
      const liveSession = await waitForLoginAndSaveSession(loginUrl, projectSlug, (msg) => {
        logger.info(msg);
        onProgress?.({ visitedCount: 0, queuedCount: 0, currentUrl: loginUrl, status: msg });
      });

      browser  = liveSession.browser;
      context  = liveSession.context;
      headed = true;

      // Replace queue start URL with the exact post-login URL captured at Done click
      // The page is ALREADY there — no navigation needed
      queue[0] = { url: liveSession.postLoginUrl, depth: 0 };
      logger.info(`[BFS] Crawl starts from post-login URL: ${liveSession.postLoginUrl}`);

      await prisma.crawlSession.update({
        where: { id: session.id },
        data: { status: 'running', errorMessage: null },
      }).catch(() => undefined);
    } else {
      // ── No login — launch a fresh headless (or headed) crawl browser ────
      const headless = config.crawler.headless;
      headed = !headless;
      logger.info(`Launching browser (headless=${headless})`);

      browser = await chromium.launch({
        headless,
        slowMo: headless ? 0 : 300,
      });

      const contextOptions: Record<string, unknown> = {};
      if (sessionExists(projectSlug)) {
        contextOptions['storageState'] = getSessionPath(projectSlug);
        logger.info('Loaded saved browser session');
      } else {
        logger.warn('No saved session — crawling without authentication');
      }

      context = await browser.newContext({
        ...contextOptions,
        viewport: { width: 1440, height: 900 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      // Block all form submissions at the browser level — read-only guarantee
      context.on('page', (p) => {
        p.addInitScript(() => {
          document.addEventListener('submit', (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            console.warn('[RE-AI] Form submission blocked (read-only mode)');
          }, true);
        }).catch(() => undefined);
      });
    }

    await prisma.crawlSession.update({
      where: { id: session.id },
      data: { status: 'running', startedAt: new Date() },
    }).catch(() => undefined);

    crawlAbortRegistry.registerBrowser(session.id, browser);

    const screenshotsDir = getScreenshotsDir(projectSlug, session.id);
    const htmlDir = getHtmlDir(projectSlug, session.id);
    const pagesDir = getPagesDir(projectSlug, session.id);
    const apiDir = getApiDir(projectSlug, session.id);

    // ── ONE persistent page for the entire crawl ──────────────────────────
    let crawlPage =
      context!.pages().filter((p) => !p.isClosed() && !isLiveLogOverlayPage(p)).slice(-1)[0]
      ?? await context!.newPage();

    await installSessionEndGuard(context!);

    await crawlPage.addInitScript(() => {
      document.addEventListener('submit', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
    }).catch(() => undefined);

    // Transparent live-log panel inside the browser (headed mode only)
    if (headed && context) {
      logOverlay = attachLiveLogOverlay(context, session.id);
      emitCrawlLog(session.id, 'info', 'Live crawl log overlay attached to browser window');
    }

    // Attach recorders ONCE
    const networkRecorder = project.networkCaptureEnabled ? createNetworkRecorder(crawlPage) : null;
    const wsRecorder = createWebSocketRecorder(crawlPage);

    // Attach console recorder ONCE — reset between pages
    const consoleEntries: Array<{ type: 'error' | 'warning' | 'info' | 'log'; text: string }> = [];
    crawlPage.on('console', (msg) => {
      const t = msg.type() as 'error' | 'warning' | 'info' | 'log';
      if (t === 'error' || t === 'warning') {
        consoleEntries.push({ type: t, text: msg.text().slice(0, 500) });
      }
    });

    while (queue.length > 0) {
      if (abortSignal?.aborted) {
        logger.info('Crawl aborted by signal');
        break;
      }

      if (crawlPage.isClosed() || !context?.browser()?.isConnected()) {
        throw new Error(browserClosedMessage());
      }

      const entry = queue.shift()!;
      const { url, depth } = entry;

      const normalizedUrl = normalizeUrl(url);
      if (visited.has(normalizedUrl)) continue;
      visited.add(normalizedUrl);

      if (!isUrlSafe(normalizedUrl, allowedDomains, excludedUrls)) {
        logger.debug(`Skipping unsafe URL: ${normalizedUrl}`);
        continue;
      }

      if (depth > maxDepth) {
        logger.debug(`Max depth reached, skipping: ${normalizedUrl}`);
        continue;
      }

      onProgress?.({
        visitedCount: visited.size,
        queuedCount: queue.length,
        currentUrl: normalizedUrl,
        status: 'crawling',
      });

      logger.info(`Crawling [${depth}/${maxDepth}]: ${normalizedUrl}`);

      // Reset per-page accumulators (reuse same tab — no new page!)
      networkRecorder?.reset();
      consoleEntries.length = 0;

      const pageStartTime = Date.now();
      let pageCapture = await prisma.pageCapture.create({
        data: { crawlSessionId: session.id, url: normalizedUrl, depth },
      });

      try {
        // Skip navigation if already on this URL (e.g. first page after login)
        // Navigating to the same URL can trigger app redirects that open new tabs
        const alreadyThere = normalizeUrl(crawlPage.url()) === normalizedUrl;
        let response = null;

        if (!alreadyThere) {
          response = await crawlPage.goto(normalizedUrl, {
            waitUntil: 'domcontentloaded',
            timeout: config.crawler.timeoutMs,
          });
        } else {
          logger.info(`Already on ${normalizedUrl} — skipping navigation`);
        }

        // Wait for network idle (SPA frameworks need this)
        await crawlPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
        // Extra buffer for SPA rendering after network settles
        await sleep(1500);

        // Detect login / SSO redirect
        const finalUrl = crawlPage.url();
        if (isLoginPage(finalUrl) && !isLoginPage(normalizedUrl)) {
          const isSso = /discovery\?entityID=|Shibboleth|returnIDParam=idp/i.test(finalUrl);
          const msg = isSso
            ? `SSO/SAML redirect detected at ${finalUrl} — the app requires re-authentication. The session may have a tab/window restriction.`
            : `Redirected to login at ${finalUrl}. Please run Login again.`;
          logger.warn(`[Crawler] ${msg}`);
          await prisma.crawlSession.update({
            where: { id: session.id },
            data: { errorMessage: msg },
          }).catch(() => undefined);
        }

        if ((response?.status() ?? 0) >= 400) {
          logger.warn(`HTTP ${response?.status()} for ${normalizedUrl}`);
        }

        // Scroll to trigger lazy-loaded content
        await autoScroll(crawlPage);
        await sleep(500);

        const loadTimeMs = Date.now() - pageStartTime;
        const title = await crawlPage.title().catch(() => '');

        // Full-page screenshot only (no separate viewport shot)
        let screenshotPath: string | undefined;
        let fullScreenshotPath: string | undefined;
        if (project.screenshotEnabled) {
          const filename = urlToFilename(normalizedUrl, '.png');
          const absShot = path.join(screenshotsDir, filename);

          await hideLiveLogOverlay(crawlPage);
          await crawlPage
            .screenshot({ path: absShot, fullPage: true, timeout: 20000 })
            .catch((e) => {
              logger.warn(`Screenshot failed: ${(e as Error).message}`);
            });
          await showLiveLogOverlay(crawlPage);

          const rel = path.relative(outputAbsDir, absShot).replace(/\\/g, '/');
          screenshotPath = rel;
          fullScreenshotPath = rel;
        }

        // Save HTML
        const html = await crawlPage.content().catch(() => '');
        const htmlFilename = urlToFilename(normalizedUrl, '.html');
        const htmlFilePath = path.join(htmlDir, htmlFilename);
        writeText(htmlFilePath, html);

        // Extract page data
        const extractedData = await extractPageData(crawlPage, normalizedUrl, safeSelectors, consoleEntries);
        let interactionLinks: string[] = [];

        if (depth < maxDepth) {
          const interactionResult = await exploreSafeInteractions(crawlPage, normalizedUrl, {
            allowedDomains,
            excludedUrls,
            safeSelectors,
            visitedActionKeys,
            maxClicks: 10,
          }).catch((err) => {
            logger.debug(`[Crawler] Interaction exploration skipped: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          });

          if (interactionResult) {
            interactionLinks = interactionResult.links;
            if (interactionResult.snapshots.length > 0) {
              (extractedData as unknown as Record<string, unknown>)['interactionExploration'] = interactionResult.snapshots;
              logger.info(`  -> opened ${interactionResult.snapshots.length} safe modal/form interaction(s), found ${interactionLinks.length} link(s)`);
              emitCrawlLog(session.id, 'info', `Opened ${interactionResult.snapshots.length} safe modal/form interaction(s)`, {
                url: normalizedUrl,
                linksFound: interactionLinks.length,
              });
            }
          }
        }

        // JavaScript intelligence: globals, components, routes, store shape, API base URLs
        const jsIntel = await extractJsIntelligence(crawlPage);
        if (jsIntel) {
          writeJson(path.join(pagesDir, urlToFilename(normalizedUrl, '-js-intel.json')), jsIntel);
          (extractedData as unknown as Record<string, unknown>)['jsIntelligence'] = jsIntel;
        }

        // ── Per-page advanced captures ─────────────────────────────────
        // Source maps (first time we see a script we haven't parsed yet)
        if (depth === 0) {
          const sourceMaps = await fetchSourceMaps(crawlPage);
          if (sourceMaps.length > 0) {
            writeJson(path.join(pagesDir, urlToFilename(normalizedUrl, '-source-maps.json')), sourceMaps);
            logger.info(`[Advanced] Source maps: ${sourceMaps.flatMap(s => s.sources).length} original files from ${sourceMaps.length} bundles`);
          }
        }

        // IndexedDB schema (only on first page — it's the same app-wide)
        if (depth === 0) {
          const idbSchema = await captureIndexedDbSchema(crawlPage);
          if (idbSchema.length > 0) {
            writeJson(path.join(pagesDir, '_indexeddb-schema.json'), idbSchema);
            logger.info(`[Advanced] IndexedDB: ${idbSchema.map(d => `${d.name}(${d.objectStores.join(',')})`).join('; ')}`);
          }
        }

        // Response headers
        const respHeaders = extractResponseHeaders(response ?? null);
        if (respHeaders) {
          (extractedData as unknown as Record<string, unknown>)['responseHeaders'] = respHeaders;
        }

        // Mobile viewport screenshot (sample every 5th page to avoid slowdown)
        if (project.screenshotEnabled && visited.size % 5 === 1) {
          const mobileResult = await captureMobileView(crawlPage, screenshotsDir, urlToFilename(normalizedUrl, '.png'));
          if (mobileResult) {
            (extractedData as unknown as Record<string, unknown>)['mobileScreenshotPath'] = mobileResult.path;
            if (mobileResult.layoutChanged) {
              logger.info(`[Advanced] Mobile layout differs: ${normalizedUrl}`);
            }
          }
        }

        // Save extracted data as JSON
        const pageJsonPath = path.join(pagesDir, urlToFilename(normalizedUrl, '.json'));
        writeJson(pageJsonPath, extractedData);

        // Visible text
        const visibleText = await crawlPage
          .evaluate(() => document.body.innerText.slice(0, 10000))
          .catch(() => '');

        // Update page capture in DB
        pageCapture = await prisma.pageCapture.update({
          where: { id: pageCapture.id },
          data: {
            title,
            html: html.slice(0, 500_000),
            visibleText: visibleText.slice(0, 20_000),
            breadcrumbs: JSON.stringify(extractedData.breadcrumbs),
            screenshotPath: screenshotPath ?? null,
            fullScreenshotPath: fullScreenshotPath ?? null,
            extractedData: JSON.stringify(extractedData),
            loadTimeMs,
          },
        });

        // Save network calls
        if (project.networkCaptureEnabled) {
          const calls = networkRecorder!.getCalls();
          const apiJsonPath = path.join(apiDir, urlToFilename(normalizedUrl, '-api.json'));
          writeJson(apiJsonPath, calls);

          // Persist network calls to DB
          if (calls.length > 0) {
            await prisma.networkCall.createMany({
              data: calls.map((call) => ({
                crawlSessionId: session.id,
                pageCaptureId: pageCapture.id,
                method: call.method,
                url: call.url,
                queryParams: JSON.stringify(call.queryParams),
                requestPayload: call.requestPayload,
                requestContentType: call.requestContentType,
                responseStatus: call.responseStatus,
                responseBody: call.responseBody,
                responseContentType: call.responseContentType,
                responseSchemaKeys: call.responseSchemaKeys ? JSON.stringify(call.responseSchemaKeys) : null,
                requestHeaders: call.requestHeaders,
                responseHeaders: call.responseHeaders,
                timingMs: call.timingMs,
                resourceType: call.resourceType,
                isGraphQL: call.isGraphQL,
                graphQLOperationName: call.graphQLOperationName,
              })),
            });
          }
        }

        // Discover new links
        if (depth < maxDepth) {
          const links = [
            ...(await discoverLinks(crawlPage, normalizedUrl, allowedDomains, excludedUrls)),
            ...interactionLinks,
          ];
          let newCount = 0;
          for (const link of links) {
            const norm = normalizeUrl(link);
            if (!visited.has(norm)) {
              queue.push({ url: link, depth: depth + 1, parentUrl: normalizedUrl });
              newCount++;
            }
          }
          if (newCount > 0) logger.info(`  → ${newCount} new links found (queue: ${queue.length})`);
          else logger.debug(`  → No new links on ${normalizedUrl}`);
          emitCrawlLog(session.id, 'info', `Discovered ${newCount} new link(s)`, {
            url: normalizedUrl,
            queuedCount: queue.length,
          });
        }

        await prisma.crawlSession.update({
          where: { id: session.id },
          data: { pagesCount: visited.size },
        }).catch(() => undefined);

        logger.info(`  ✓ "${title}" (${loadTimeMs}ms)`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to crawl ${normalizedUrl}: ${errMsg}`);
        await prisma.pageCapture.update({
          where: { id: pageCapture.id },
          data: { title: `ERROR: ${errMsg}`.slice(0, 255) },
        }).catch(() => undefined); // ignore if session/page was cascade deleted

        if (isBrowserClosedError(err) || crawlPage.isClosed() || !context?.browser()?.isConnected()) {
          throw new Error(browserClosedMessage(err));
        }
      } finally {
        // DO NOT close crawlPage here — it is reused for all pages in the loop
      }

      await sleep(config.crawler.delayMs);
    }

    await prisma.crawlSession.update({
      where: { id: session.id },
      data: {
        status: abortSignal?.aborted ? 'stopped' : 'completed',
        finishedAt: new Date(),
        pagesCount: visited.size,
        errorMessage: abortSignal?.aborted ? 'Stopped by user' : null,
      },
    }).catch(() => undefined);

    // ── Session-level advanced captures ───────────────────────────────────
    // Run once after all pages visited so we have the full network picture
    if (!abortSignal?.aborted) try {
      // 1. OpenAPI / Swagger spec
      const openApiSpec = await fetchOpenApiSpec(crawlPage, project.baseUrl);
      if (openApiSpec) {
        writeJson(path.join(pagesDir, '_openapi-spec.json'), openApiSpec);
        logger.info(`[Advanced] OpenAPI spec saved: ${openApiSpec.paths.length} paths, ${openApiSpec.schemas.length} schemas`);
      }

      // 2. GraphQL introspection (detect endpoint from recorded network calls)
      const allCalls = networkRecorder?.getCalls() ?? [];
      const gqlEndpoints = [...new Set(
        allCalls
          .filter((c) => c.isGraphQL || /graphql|gql/i.test(c.url))
          .map((c) => { try { return new URL(c.url).pathname; } catch { return c.url; } }),
      )];
      for (const ep of gqlEndpoints.slice(0, 3)) {
        const fullEp = ep.startsWith('http') ? ep : new URL(ep, project.baseUrl).toString();
        const gqlSchema = await fetchGraphQLSchema(crawlPage, fullEp);
        if (gqlSchema) {
          writeJson(path.join(pagesDir, '_graphql-schema.json'), gqlSchema);
          logger.info(`[Advanced] GraphQL schema: ${gqlSchema.types.length} types`);
          break;
        }
      }

      // 3. WebSocket captures
      const wsCaptures = wsRecorder.getCaptures();
      if (wsCaptures.length > 0) {
        writeJson(path.join(apiDir, '_websocket-captures.json'), wsCaptures);
        logger.info(`[Advanced] WebSocket: ${wsCaptures.length} connections, ${wsCaptures.reduce((s, c) => s + c.messageCount, 0)} total messages`);
      }

      // 4. SSE endpoints
      const sseEndpoints = detectSseEndpoints(allCalls);
      if (sseEndpoints.length > 0) {
        writeJson(path.join(apiDir, '_sse-endpoints.json'), sseEndpoints);
        logger.info(`[Advanced] SSE endpoints detected: ${sseEndpoints.join(', ')}`);
      }

      // 5. Cookie structure (final state after all pages visited)
      if (context) {
        const cookies = await captureCookieStructure(context);
        if (cookies.length > 0) {
          writeJson(path.join(pagesDir, '_cookie-structure.json'), cookies);
          logger.info(`[Advanced] Cookies: ${cookies.length} (${cookies.filter(c => c.isAuthRelated).length} auth-related)`);
        }
      }
    } catch (err) {
      logger.warn(`[Advanced] Session-level captures failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    logger.info(`Crawl completed. Pages visited: ${visited.size}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Crawl failed: ${errMsg}`);
    await prisma.crawlSession.updateMany({
      where: { id: session.id, status: { not: 'stopped' } },
      data: { status: 'failed', finishedAt: new Date(), errorMessage: errMsg.slice(0, 500) },
    }).catch(() => undefined); // ignore if session was deleted by cascade
    throw err;
  } finally {
    logOverlay?.dispose();
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function discoverLinks(
  page: Page,
  currentUrl: string,
  allowedDomains: string[],
  excludedUrls: string[],
): Promise<string[]> {
  try {
    const base = new URL(currentUrl);

    const hrefs = await page.evaluate((): string[] => {
      const seen = new Set<string>();
      const results: string[] = [];

      // Standard anchor tags
      document.querySelectorAll('a[href]').forEach((el) => {
        const href = (el as HTMLAnchorElement).href;
        if (href && !seen.has(href)) { seen.add(href); results.push(href); }
      });

      // SPA-style data attributes
      document.querySelectorAll('[data-href], [data-url], [data-route]').forEach((el) => {
        const href =
          el.getAttribute('data-href') ||
          el.getAttribute('data-url') ||
          el.getAttribute('data-route');
        if (href && !seen.has(href)) { seen.add(href); results.push(href); }
      });

      return results;
    });

    const result: string[] = [];
    for (const href of hrefs) {
      try {
        const resolved = new URL(href, base.toString()).toString();
        if (isUrlSafe(resolved, allowedDomains, excludedUrls)) {
          result.push(resolved);
        }
      } catch {
        // invalid URL
      }
    }

    return [...new Set(result)];
  } catch {
    return [];
  }
}

async function autoScroll(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      await new Promise<void>((resolve) => {
        let totalHeight = 0;
        const distance = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 120);
        setTimeout(() => { clearInterval(timer); resolve(); }, 12000);
      });
    })
    .catch(() => undefined);
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove trailing slash, normalize
    let result = `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}${parsed.pathname.replace(/\/$/, '') || '/'}`;
    if (parsed.search) result += parsed.search;
    return result;
  } catch {
    return url;
  }
}

