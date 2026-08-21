import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import type { CrawlSession, Project } from '@prisma/client';
import { prisma } from '../database/client';
import { extractPageData, type ConsoleEntry } from '../extractor';
import {
  captureCookieStructure,
  captureIndexedDbSchema,
  detectSseEndpoints,
  fetchGraphQLSchema,
  fetchOpenApiSpec,
  fetchSourceMaps,
} from '../extractor/advanced-capture';
import {
  createNetworkRecorder,
  createWebSocketRecorder,
  type NetworkRecorder,
  type RecordedNetworkCall,
  type WebSocketRecorder,
} from '../recorder';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  getApiDir,
  getHarDir,
  getHtmlDir,
  getPagesDir,
  getScreenshotsDir,
  writeJson,
  writeText,
  urlToFilename,
} from '../utils/file-system';
import { sleep } from '../utils/retry';
import { isUrlSafe } from './safety';
import { saveSession, sessionExists, getSessionPath } from './session';
import { installSessionEndGuard, installWindowCloseGuard } from './session-end-guard';
import { crawlAbortRegistry } from './crawl-abort';
import { waitForPageSettled } from './new-page-follower';
import { isManualControlPage, openManualControlWindow, type ManualControlHandle } from './manual-controls';

export interface ManualCrawlProgressInfo {
  capturedCount: number;
  currentUrl: string;
  status: 'waiting' | 'capturing' | 'captured' | 'finished';
  message: string;
}

export interface ManualCrawlOptions {
  project: Project;
  session: CrawlSession;
  projectSlug: string;
  abortSignal?: AbortSignal;
  onProgress?: (info: ManualCrawlProgressInfo) => void;
}

interface ManualPageState {
  recorder: NetworkRecorder | null;
  websocketRecorder: WebSocketRecorder;
  consoleEntries: ConsoleEntry[];
  lastCapturedUrl: string | null;
  captureTimer: ReturnType<typeof setTimeout> | null;
}

interface ManualTraceEntry {
  sequence: number;
  pageCaptureId: string;
  url: string;
  title: string;
  reason: string;
  capturedAt: string;
  networkCalls: number;
  screenshotPath: string | null;
}

export function manualCaptureFilename(sequence: number, url: string, extension: string): string {
  const prefix = `manual-${String(sequence).padStart(4, '0')}-`;
  try {
    return prefix + urlToFilename(url, extension);
  } catch {
    return `${prefix}page${extension}`;
  }
}

export async function runManualCrawl(options: ManualCrawlOptions): Promise<void> {
  const { project, session, projectSlug, abortSignal, onProgress } = options;
  const allowedDomains = JSON.parse(project.allowedDomains || '[]') as string[];
  const excludedUrls = JSON.parse(project.excludedUrls || '[]') as string[];
  if (allowedDomains.length === 0) {
    try { allowedDomains.push(new URL(project.baseUrl).hostname); } catch { /* validated at project creation */ }
  }

  const screenshotsDir = getScreenshotsDir(projectSlug, session.id);
  const htmlDir = getHtmlDir(projectSlug, session.id);
  const pagesDir = getPagesDir(projectSlug, session.id);
  const apiDir = getApiDir(projectSlug, session.id);
  const harDir = getHarDir(projectSlug, session.id);
  const outputRoot = path.resolve(config.outputDir);
  const states = new Map<Page, ManualPageState>();
  const trace: ManualTraceEntry[] = [];
  const allCalls: RecordedNetworkCall[] = [];
  let browser: Browser | null = null;
  let controlBrowser: Browser | null = null;
  let context: BrowserContext | null = null;
  let controlContext: BrowserContext | null = null;
  let controls: ManualControlHandle | null = null;
  let capturing = false; // Always wait for green "Start capture" (login or not)
  let guardInstalled = false;
  let finishing = false;
  let captureSequence = 0;
  let captureQueue = Promise.resolve();
  let finishResolve: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => { finishResolve = resolve; });
  let endReason: 'finish' | 'browser-closed' | 'aborted' | 'timeout' | null = null;
  let relaunchingApp = false;
  /** Track last URL per app page for SPA hash changes */
  const lastSeenUrl = new WeakMap<Page, string>();

  const progress = (status: ManualCrawlProgressInfo['status'], message: string, page?: Page) => {
    onProgress?.({ capturedCount: trace.length, currentUrl: page?.url() ?? '', status, message });
  };

  const chromeArgs = ['--start-maximized', '--disable-dev-shm-usage', '--disable-gpu'];

  /** Heavy Essential Viewer reports crash Chrome on fullPage screenshots — use viewport only. */
  const takeSafeScreenshot = async (page: Page, absPath: string): Promise<boolean> => {
    const url = page.url();
    const heavy =
      /\/viewer\//i.test(url) ||
      /[?&]XSL=/i.test(url) ||
      /reportXML/i.test(url) ||
      /Catalogue|Catalog/i.test(url);
    try {
      if (heavy) {
        await page.screenshot({ path: absPath, fullPage: false, timeout: 8_000 });
        return true;
      }
      await page.screenshot({ path: absPath, fullPage: true, timeout: 12_000 });
      return true;
    } catch (err) {
      logger.warn(`[Manual] fullPage screenshot failed, trying viewport: ${err instanceof Error ? err.message : String(err)}`);
      try {
        await page.screenshot({ path: absPath, fullPage: false, timeout: 8_000 });
        return true;
      } catch (err2) {
        logger.warn(`[Manual] Screenshot skipped: ${err2 instanceof Error ? err2.message : String(err2)}`);
        return false;
      }
    }
  };

  const capturePage = async (page: Page, reason: string, force = false): Promise<void> => {
    if (!capturing || page.isClosed() || isManualControlPage(page)) return;
    const state = states.get(page);
    if (!state) return;
    const url = page.url();
    if (!/^https?:/i.test(url) || !isUrlSafe(url, allowedDomains, excludedUrls)) {
      logger.warn(`[Manual] Skipping capture outside safe scope: ${url}`);
      progress('waiting', `Skipped unsafe or out-of-scope page: ${url}`, page);
      return;
    }
    if (!force && state.lastCapturedUrl === url) return;

    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    await sleep(400);
    if (page.isClosed()) return;

    captureSequence += 1;
    const sequence = captureSequence;
    progress('capturing', `Capturing ${url}`, page);
    try {
      const capturedAt = new Date().toISOString();
      const startedAt = Date.now();
      const title = await page.title().catch(() => '');
      // Cap HTML — huge Viewer DOMs can OOM Chrome for Testing during serialize
      const html = await page
        .evaluate(() => {
          const raw = `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
          return raw.length > 1_500_000 ? `${raw.slice(0, 1_500_000)}\n<!-- truncated -->` : raw;
        })
        .catch(() => '');
      const visibleText = await page.evaluate(() => document.body?.innerText?.slice(0, 20_000) ?? '').catch(() => '');
      const extractedData = await extractPageData(page, url, [], [...state.consoleEntries]).catch(() => null);
      const screenshotName = manualCaptureFilename(sequence, url, '.png');
      const htmlName = manualCaptureFilename(sequence, url, '.html');
      const pageName = manualCaptureFilename(sequence, url, '.json');
      const apiName = manualCaptureFilename(sequence, url, '-api.json');
      const harName = manualCaptureFilename(sequence, url, '.har');
      let screenshotPath: string | null = null;
      if (project.screenshotEnabled) {
        const screenshotAbs = path.join(screenshotsDir, screenshotName);
        const ok = await takeSafeScreenshot(page, screenshotAbs);
        if (ok) screenshotPath = path.relative(outputRoot, screenshotAbs).replace(/\\/g, '/');
      }
      writeText(path.join(htmlDir, htmlName), html);
      if (extractedData) writeJson(path.join(pagesDir, pageName), extractedData);

      const pageCapture = await prisma.pageCapture.create({
        data: {
          crawlSessionId: session.id,
          url,
          title,
          depth: 0,
          html: html.slice(0, 500_000),
          visibleText,
          breadcrumbs: JSON.stringify(extractedData?.breadcrumbs ?? []),
          screenshotPath,
          fullScreenshotPath: screenshotPath,
          extractedData: extractedData ? JSON.stringify(extractedData) : null,
          loadTimeMs: Date.now() - startedAt,
        },
      });

      await state.recorder?.flush();
      const calls = state.recorder?.getCalls() ?? [];
      if (state.recorder) {
        writeJson(path.join(apiDir, apiName), calls);
        writeJson(path.join(harDir, harName), state.recorder.getHar(url));
      }
      if (calls.length > 0) {
        allCalls.push(...calls);
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
      await state.recorder?.reset();
      state.consoleEntries.length = 0;
      state.lastCapturedUrl = url;
      trace.push({
        sequence,
        pageCaptureId: pageCapture.id,
        url,
        title,
        reason,
        capturedAt,
        networkCalls: calls.length,
        screenshotPath,
      });
      writeJson(path.join(pagesDir, '_manual-trace.json'), trace);
      await prisma.crawlSession.update({ where: { id: session.id }, data: { pagesCount: trace.length } });
      progress('captured', `Captured ${title || url} (${calls.length} network calls)`, page);
      logger.info(`[Manual] ✓ #${sequence} "${title || 'untitled'}" (${calls.length} APIs) — ${url}`);
      await controls?.setStatus(`Captured ${trace.length} page(s) · ${title || url}`, true);
    } catch (err) {
      logger.warn(`[Manual] Capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const enqueueCapture = (page: Page, reason: string, force = false): Promise<void> => {
    captureQueue = captureQueue.then(() => capturePage(page, reason, force)).catch((err) => {
      logger.warn(`[Manual] Capture failed: ${err instanceof Error ? err.message : String(err)}`);
      progress('waiting', `Capture failed: ${err instanceof Error ? err.message : String(err)}`, page);
    });
    return captureQueue;
  };

  const scheduleCapture = (page: Page, reason: string) => {
    const state = states.get(page);
    if (!state || !capturing || finishing) return;
    if (state.captureTimer) clearTimeout(state.captureTimer);
    state.captureTimer = setTimeout(() => {
      state.captureTimer = null;
      void enqueueCapture(page, reason);
    }, 1_200);
  };

  const attachPage = (page: Page) => {
    if (isManualControlPage(page) || states.has(page)) return;
    const state: ManualPageState = {
      recorder: project.networkCaptureEnabled ? createNetworkRecorder(page) : null,
      websocketRecorder: createWebSocketRecorder(page),
      consoleEntries: [],
      lastCapturedUrl: null,
      captureTimer: null,
    };
    states.set(page, state);
    lastSeenUrl.set(page, page.url());
    page.on('console', (message) => {
      const type = message.type();
      if (type === 'error' || type === 'warning') {
        state.consoleEntries.push({ type, text: message.text().slice(0, 500) });
      }
    });
    page.on('domcontentloaded', () => scheduleCapture(page, 'navigation'));
    page.on('framenavigated', () => {
      if (!capturing || finishing) return;
      const url = page.url();
      if (lastSeenUrl.get(page) === url) return;
      lastSeenUrl.set(page, url);
      scheduleCapture(page, 'spa-navigation');
    });
    page.on('close', () => {
      if (state.captureTimer) clearTimeout(state.captureTimer);
    });
    if (capturing) {
      void waitForPageSettled(page).then(() => scheduleCapture(page, 'page-opened'));
    }
  };

  const statusPayload = () => ({
    capturing,
    message: capturing
      ? `Recording enabled · ${trace.length} capture(s)`
      : 'Log in on the app window, then click Start capture here.',
  });

  const handleStart = async () => {
    if (!capturing) {
      capturing = true;
      if (!guardInstalled && context) {
        await installSessionEndGuard(context);
        guardInstalled = true;
      }
      if (context) await saveSession(context, projectSlug).catch(() => undefined);
      await prisma.crawlSession.update({
        where: { id: session.id },
        data: { status: 'running', startedAt: new Date(), errorMessage: null },
      });
      for (const openPage of context?.pages() ?? []) {
        if (isManualControlPage(openPage)) continue;
        const state = states.get(openPage);
        await state?.recorder?.reset();
        if (state) state.consoleEntries.length = 0;
        scheduleCapture(openPage, 'capture-started');
      }
      progress('capturing', 'Manual capture started');
      logger.info('[Manual] Capture started by user');
    }
    return statusPayload();
  };

  const getAppPage = () =>
    context?.pages().find((p) => !p.isClosed() && !isManualControlPage(p) && /^https?:/i.test(p.url()))
    ?? null;

  const relaunchAppBrowser = async (resumeUrl?: string): Promise<void> => {
    if (relaunchingApp || finishing || endReason) return;
    relaunchingApp = true;
    try {
      logger.warn('[Manual] App Chrome crashed — relaunching with saved session…');
      await controls?.setStatus('App Chrome crashed on a heavy page. Relaunching…', capturing);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);

      browser = await chromium.launch({ headless: false, args: chromeArgs });
      crawlAbortRegistry.registerBrowser(session.id, browser);
      const ctxOpts: Parameters<Browser['newContext']>[0] = { viewport: null };
      if (sessionExists(projectSlug)) ctxOpts.storageState = getSessionPath(projectSlug);
      context = await browser.newContext(ctxOpts);
      await installWindowCloseGuard(context);
      if (capturing) {
        await installSessionEndGuard(context);
        guardInstalled = true;
      }
      context.on('page', (page) => attachPage(page));
      wireAppDisconnect(browser);

      const page = await context.newPage();
      attachPage(page);
      const target =
        resumeUrl ||
        trace[trace.length - 1]?.url ||
        project.loginUrl ||
        project.baseUrl;
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: config.crawler.timeoutMs }).catch(() => undefined);
      await controls?.setStatus(
        `App relaunched at last page. Continue exploring, then Finish & save. (${trace.length} captures kept)`,
        capturing,
      );
      logger.info(`[Manual] App relaunched → ${page.url()}`);
    } catch (err) {
      logger.error(`[Manual] App relaunch failed: ${err instanceof Error ? err.message : String(err)}`);
      await controls?.setStatus('App relaunch failed — click Finish & save to keep captures so far.', capturing);
    } finally {
      relaunchingApp = false;
    }
  };

  const wireAppDisconnect = (appBrowser: Browser) => {
    appBrowser.once('disconnected', () => {
      if (finishing || endReason === 'finish' || endReason === 'aborted') return;
      logger.warn('[Manual] App browser disconnected (crash or quit)');
      void relaunchAppBrowser();
    });
  };

  const handleCapture = async () => {
    const appPage = getAppPage();
    if (appPage) await enqueueCapture(appPage, 'manual', true);
    else await controls?.setStatus('No app page open — wait for relaunch or open the app window.', capturing);
    return statusPayload();
  };

  const handleFinish = async () => {
    finishing = true;
    endReason = 'finish';
    const appPage = getAppPage();
    if (appPage) await enqueueCapture(appPage, 'finish', true);
    logger.info(`[Manual] Finish & save clicked — ${trace.length} capture(s)`);
    finishResolve?.();
    return { capturing: true, message: `Saved ${trace.length} capture(s). Closing…` };
  };

  try {
    // Separate Chromium for controls — survives Application Catalogue / Viewer crashes
    controlBrowser = await chromium.launch({ headless: false, args: chromeArgs });
    controlContext = await controlBrowser.newContext({ viewport: { width: 400, height: 480 } });
    crawlAbortRegistry.registerBrowser(session.id, controlBrowser);

    controls = await openManualControlWindow(controlContext, {
      onStart: handleStart,
      onCapture: handleCapture,
      onFinish: handleFinish,
      getStatus: statusPayload,
    });

    browser = await chromium.launch({ headless: false, args: chromeArgs });
    context = await browser.newContext({ viewport: null });
    crawlAbortRegistry.registerBrowser(session.id, browser);
    await installWindowCloseGuard(context);
    context.on('page', (page) => attachPage(page));
    wireAppDisconnect(browser);

    const page = await context.newPage();
    attachPage(page);

    await prisma.crawlSession.update({
      where: { id: session.id },
      data: { status: 'awaiting_login', errorMessage: 'Manual browser opened — log in, then click Start capture in the control window.' },
    });

    const startUrl = project.loginUrl || project.baseUrl;
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: config.crawler.timeoutMs }).catch(() => undefined);

    await controls.setStatus('Log in on the APP Chrome window, then click ✓ Start capture here.', false);
    await controls.page.bringToFront().catch(() => undefined);
    progress('waiting', 'Two Chrome windows: Controls (this) + App. Start capture after login.', page);
    logger.info('[Manual] Dual Chrome: controls + app (app crashes will auto-relaunch)');

    const controlGone = new Promise<void>((resolve) => {
      controlBrowser!.once('disconnected', () => {
        if (!endReason) endReason = 'browser-closed';
        resolve();
      });
    });
    const aborted = new Promise<void>((resolve) => {
      if (abortSignal?.aborted) {
        endReason = 'aborted';
        return resolve();
      }
      abortSignal?.addEventListener('abort', () => {
        endReason = 'aborted';
        resolve();
      }, { once: true });
    });
    const maxDurationMs = config.crawler.manualMaxDurationMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (!endReason) endReason = 'timeout';
        resolve();
      }, maxDurationMs);
    });
    // Do NOT end on app browser crash — relaunchAppBrowser handles that
    await Promise.race([finished, controlGone, aborted, timedOut]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    finishing = true;
    logger.info(`[Manual] Session ending (${endReason ?? 'unknown'}) — ${trace.length} capture(s)`);
    for (const state of states.values()) {
      if (state.captureTimer) clearTimeout(state.captureTimer);
    }
    await captureQueue;

    if (context && endReason !== 'browser-closed' && endReason !== 'aborted' && context.browser()?.isConnected()) {
      await saveSession(context, projectSlug).catch(() => undefined);
      const currentPage = getAppPage();
      if (currentPage) {
        const websocketCaptures = [...states.values()].flatMap((state) => state.websocketRecorder.getCaptures());
        if (websocketCaptures.length > 0) writeJson(path.join(apiDir, '_websocket-captures.json'), websocketCaptures);
        const sseEndpoints = detectSseEndpoints(allCalls);
        if (sseEndpoints.length > 0) writeJson(path.join(apiDir, '_sse-endpoints.json'), sseEndpoints);
        const cookies = await captureCookieStructure(context).catch(() => []);
        if (cookies.length > 0) writeJson(path.join(pagesDir, '_cookie-structure.json'), cookies);
        const indexedDb = await captureIndexedDbSchema(currentPage).catch(() => []);
        if (indexedDb.length > 0) writeJson(path.join(pagesDir, '_indexeddb-schema.json'), indexedDb);
        const sourceMaps = await fetchSourceMaps(currentPage).catch(() => []);
        if (sourceMaps.length > 0) writeJson(path.join(pagesDir, '_source-maps.json'), sourceMaps);
        const openApi = await fetchOpenApiSpec(currentPage, project.baseUrl).catch(() => null);
        if (openApi) writeJson(path.join(pagesDir, '_openapi-spec.json'), openApi);
        const graphQlCall = allCalls.find((call) => call.isGraphQL || /graphql|gql/i.test(call.url));
        if (graphQlCall) {
          const schema = await fetchGraphQLSchema(currentPage, graphQlCall.url).catch(() => null);
          if (schema) writeJson(path.join(pagesDir, '_graphql-schema.json'), schema);
        }
      }
    }

    if (endReason !== 'aborted') {
      const status =
        endReason === 'finish' && trace.length > 0
          ? 'completed'
          : endReason === 'browser-closed'
            ? 'stopped'
            : trace.length > 0
              ? 'completed'
              : 'stopped';
      const errorMessage =
        endReason === 'browser-closed'
          ? 'Control window was closed before Finish & save — captures so far were kept'
          : endReason === 'timeout'
            ? 'Manual crawl reached max duration and was finalized'
            : trace.length > 0
              ? null
              : 'Manual crawl ended without any captured pages';
      await prisma.crawlSession.update({
        where: { id: session.id },
        data: {
          status,
          pagesCount: trace.length,
          finishedAt: new Date(),
          errorMessage,
        },
      });
      progress('finished', `Manual crawl finished (${endReason ?? 'unknown'}) with ${trace.length} capture(s)`);
    }
  } catch (err) {
    if (!abortSignal?.aborted) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.crawlSession.updateMany({
        where: { id: session.id, status: { not: 'stopped' } },
        data: { status: 'failed', finishedAt: new Date(), errorMessage: message.slice(0, 500) },
      }).catch(() => undefined);
    }
    throw err;
  } finally {
    controls?.dispose();
    for (const state of states.values()) {
      if (state.captureTimer) clearTimeout(state.captureTimer);
      await state.recorder?.stop();
      state.websocketRecorder.stop();
    }
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await controlContext?.close().catch(() => undefined);
    await controlBrowser?.close().catch(() => undefined);
  }
}
