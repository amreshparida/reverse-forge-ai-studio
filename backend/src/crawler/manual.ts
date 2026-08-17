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
import { getSessionPath, saveSession, sessionExists } from './session';
import { installSessionEndGuard } from './session-end-guard';
import { crawlAbortRegistry } from './crawl-abort';

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

const MANUAL_OVERLAY_ID = '__reverse-forge-manual-controls__';

function manualOverlayScript(): void {
  const bindingName = '__reverseForgeManualCommand';
  const overlayId = '__reverse-forge-manual-controls__';
  const globalState = window as unknown as Record<string, unknown>;
  if (globalState['__reverseForgeManualInstalled']) return;
  globalState['__reverseForgeManualInstalled'] = true;

  const command = async (action: string) => {
    const binding = globalState[bindingName] as ((value: string) => Promise<{ capturing: boolean; message: string }>) | undefined;
    if (!binding) return { capturing: false, message: 'Recorder connection unavailable' };
    return binding(action);
  };

  const install = async () => {
    if (!document.body || document.getElementById(overlayId)) return;
    const panel = document.createElement('div');
    panel.id = overlayId;
    panel.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
      'width:280px', 'padding:12px', 'border-radius:12px',
      'background:rgba(17,24,39,.96)', 'color:#fff',
      'box-shadow:0 8px 32px rgba(0,0,0,.4)',
      'font:13px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    ].join(';');
    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:7px">🧭 ReverseForge Manual Capture</div>
      <div data-rf-status style="color:#cbd5e1;margin-bottom:9px">Connecting…</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button data-rf-start style="display:none;background:#16a34a;color:white;border:0;border-radius:7px;padding:7px 10px;cursor:pointer">Start capture</button>
        <button data-rf-capture style="background:#4f46e5;color:white;border:0;border-radius:7px;padding:7px 10px;cursor:pointer">Capture current state</button>
        <button data-rf-finish style="background:#dc2626;color:white;border:0;border-radius:7px;padding:7px 10px;cursor:pointer">Finish & save</button>
      </div>`;
    document.body.appendChild(panel);

    const status = panel.querySelector<HTMLElement>('[data-rf-status]')!;
    const start = panel.querySelector<HTMLButtonElement>('[data-rf-start]')!;
    const capture = panel.querySelector<HTMLButtonElement>('[data-rf-capture]')!;
    const finish = panel.querySelector<HTMLButtonElement>('[data-rf-finish]')!;
    let lastUrl = location.href;
    let capturing = false;

    const render = (state: { capturing: boolean; message: string }) => {
      capturing = state.capturing;
      status.textContent = state.message;
      start.style.display = capturing ? 'none' : 'inline-block';
      capture.disabled = !capturing;
      capture.style.opacity = capturing ? '1' : '.45';
    };
    render(await command('status'));

    start.onclick = async () => render(await command('start'));
    capture.onclick = async () => {
      status.textContent = 'Capturing current state…';
      render(await command('capture'));
    };
    finish.onclick = async () => {
      start.disabled = true;
      capture.disabled = true;
      finish.disabled = true;
      status.textContent = 'Saving final capture…';
      render(await command('finish'));
    };

    window.setInterval(() => {
      if (!capturing || location.href === lastUrl) return;
      lastUrl = location.href;
      void command('navigated').then(render);
    }, 600);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void install(); }, { once: true });
  } else {
    void install();
  }
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
  let context: BrowserContext | null = null;
  let capturing = !project.loginRequired;
  let guardInstalled = false;
  let finishing = false;
  let captureSequence = 0;
  let captureQueue = Promise.resolve();
  let finishResolve: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => { finishResolve = resolve; });

  const progress = (status: ManualCrawlProgressInfo['status'], message: string, page?: Page) => {
    onProgress?.({ capturedCount: trace.length, currentUrl: page?.url() ?? '', status, message });
  };

  const hideControls = async (page: Page) => {
    await page.evaluate((id) => {
      const element = document.getElementById(id);
      if (element) element.style.display = 'none';
    }, MANUAL_OVERLAY_ID).catch(() => undefined);
  };
  const showControls = async (page: Page) => {
    await page.evaluate((id) => {
      const element = document.getElementById(id);
      if (element) element.style.display = 'block';
    }, MANUAL_OVERLAY_ID).catch(() => undefined);
  };

  const capturePage = async (page: Page, reason: string, force = false): Promise<void> => {
    if (!capturing || page.isClosed()) return;
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
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    await sleep(300);
    if (page.isClosed()) return;

    captureSequence += 1;
    const sequence = captureSequence;
    progress('capturing', `Capturing ${url}`, page);
    await hideControls(page);
    try {
      const capturedAt = new Date().toISOString();
      const startedAt = Date.now();
      const [title, html, visibleText] = await Promise.all([
        page.title().catch(() => ''),
        page.evaluate((overlayId) => {
          const clone = document.documentElement.cloneNode(true) as HTMLElement;
          clone.querySelector(`#${overlayId}`)?.remove();
          return `<!DOCTYPE html>\n${clone.outerHTML}`;
        }, MANUAL_OVERLAY_ID).catch(() => ''),
        page.evaluate(() => document.body?.innerText?.slice(0, 20_000) ?? '').catch(() => ''),
      ]);
      const extractedData = await extractPageData(page, url, [], [...state.consoleEntries]).catch(() => null);
      const screenshotName = manualCaptureFilename(sequence, url, '.png');
      const htmlName = manualCaptureFilename(sequence, url, '.html');
      const pageName = manualCaptureFilename(sequence, url, '.json');
      const apiName = manualCaptureFilename(sequence, url, '-api.json');
      const harName = manualCaptureFilename(sequence, url, '.har');
      let screenshotPath: string | null = null;
      if (project.screenshotEnabled) {
        const screenshotAbs = path.join(screenshotsDir, screenshotName);
        await page.screenshot({ path: screenshotAbs, fullPage: true, timeout: 20_000 }).catch(() => undefined);
        screenshotPath = path.relative(outputRoot, screenshotAbs).replace(/\\/g, '/');
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
    } finally {
      await showControls(page);
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
    if (states.has(page)) return;
    const state: ManualPageState = {
      recorder: project.networkCaptureEnabled ? createNetworkRecorder(page) : null,
      websocketRecorder: createWebSocketRecorder(page),
      consoleEntries: [],
      lastCapturedUrl: null,
      captureTimer: null,
    };
    states.set(page, state);
    page.on('console', (message) => {
      const type = message.type();
      if (type === 'error' || type === 'warning') {
        state.consoleEntries.push({ type, text: message.text().slice(0, 500) });
      }
    });
    page.on('domcontentloaded', () => scheduleCapture(page, 'navigation'));
    page.on('close', () => {
      if (state.captureTimer) clearTimeout(state.captureTimer);
    });
    if (capturing) scheduleCapture(page, 'page-opened');
  };

  try {
    browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
    const contextOptions: Parameters<Browser['newContext']>[0] = { viewport: null };
    if (sessionExists(projectSlug)) contextOptions.storageState = getSessionPath(projectSlug);
    context = await browser.newContext(contextOptions);
    crawlAbortRegistry.registerBrowser(session.id, browser);

    await context.exposeBinding('__reverseForgeManualCommand', async ({ page }, rawAction: unknown) => {
      const action = String(rawAction);
      if (action === 'status') {
        return {
          capturing,
          message: capturing
            ? `Recording enabled · ${trace.length} capture(s)`
            : 'Log in, then click Start capture',
        };
      }
      if (action === 'start') {
        if (!capturing) {
          capturing = true;
          if (!guardInstalled) {
            await installSessionEndGuard(context!);
            guardInstalled = true;
          }
          await saveSession(context!, projectSlug).catch(() => undefined);
          await prisma.crawlSession.update({
            where: { id: session.id },
            data: { status: 'running', startedAt: new Date(), errorMessage: null },
          });
          // Discard login traffic and console output before recording application evidence.
          for (const openPage of context!.pages()) {
            const state = states.get(openPage);
            await state?.recorder?.reset();
            if (state) state.consoleEntries.length = 0;
            scheduleCapture(openPage, 'capture-started');
          }
          progress('capturing', 'Manual capture started', page);
        }
      } else if (action === 'capture') {
        await enqueueCapture(page, 'manual', true);
      } else if (action === 'navigated') {
        scheduleCapture(page, 'spa-navigation');
      } else if (action === 'finish') {
        finishing = true;
        await enqueueCapture(page, 'finish', true);
        finishResolve?.();
      }
      return { capturing, message: `Recording enabled · ${trace.length} capture(s)` };
    });
    await context.addInitScript(manualOverlayScript);
    context.on('page', (page) => attachPage(page));
    for (const existingPage of context.pages()) attachPage(existingPage);
    const page = context.pages()[0] ?? await context.newPage();

    if (capturing) {
      await installSessionEndGuard(context);
      guardInstalled = true;
      await prisma.crawlSession.update({
        where: { id: session.id },
        data: { status: 'running', startedAt: new Date(), errorMessage: null },
      });
    } else {
      await prisma.crawlSession.update({
        where: { id: session.id },
        data: { status: 'awaiting_login', errorMessage: 'Manual browser opened — log in, then click Start capture.' },
      });
    }

    const startUrl = project.loginRequired ? (project.loginUrl || project.baseUrl) : project.baseUrl;
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: config.crawler.timeoutMs }).catch(() => undefined);
    if (capturing) scheduleCapture(page, 'initial-page');
    progress(capturing ? 'capturing' : 'waiting', capturing
      ? 'Explore normally; pages are captured automatically. Use Capture current state for tabs or modals.'
      : 'Log in, then click Start capture in the browser.', page);

    const disconnected = new Promise<void>((resolve) => browser!.once('disconnected', () => resolve()));
    const aborted = new Promise<void>((resolve) => {
      if (abortSignal?.aborted) return resolve();
      abortSignal?.addEventListener('abort', () => resolve(), { once: true });
    });
    const maxDurationMs = config.crawler.manualMaxDurationMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, maxDurationMs);
    });
    await Promise.race([finished, disconnected, aborted, timedOut]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    finishing = true;
    for (const state of states.values()) {
      if (state.captureTimer) clearTimeout(state.captureTimer);
    }
    await captureQueue;

    if (context && !abortSignal?.aborted && context.browser()?.isConnected()) {
      await saveSession(context, projectSlug).catch(() => undefined);
      const currentPage = context.pages().find((candidate) => !candidate.isClosed());
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

    if (!abortSignal?.aborted) {
      const status = trace.length > 0 ? 'completed' : 'stopped';
      await prisma.crawlSession.update({
        where: { id: session.id },
        data: {
          status,
          pagesCount: trace.length,
          finishedAt: new Date(),
          errorMessage: trace.length > 0 ? null : 'Manual crawl ended without any captured pages',
        },
      });
      progress('finished', `Manual crawl finished with ${trace.length} capture(s)`, page);
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
    for (const state of states.values()) {
      if (state.captureTimer) clearTimeout(state.captureTimer);
      await state.recorder?.stop();
      state.websocketRecorder.stop();
    }
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
