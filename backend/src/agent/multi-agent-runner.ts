import { chromium, BrowserContext, Browser, Page } from 'playwright';
import path from 'path';
import { prisma } from '../database/client';
import { createLLMClient, isLLMConfigured, type LLMConfig } from '../ai/llm';
import { SharedCrawlState } from './shared-state';
import { observePage } from './observer';
import { executeAction } from './action-builder';
import { buildNavigatorMessages, buildPlannerMessages, buildValidatorMessages, validateAction, type PlannerOutput, type ValidatorOutput } from './navigator';
import { captureNavigatorVision } from './vision';
import {
  appendInteraction,
  createEmptyAgentMemory,
  describeAction,
  maybeCreateRollingSummary,
  rollingContextSnapshot,
} from './rolling-context';
import { extractPageData } from '../extractor';
import { exploreSafeInteractions } from '../crawler/interaction-explorer';
import { createNetworkRecorder } from '../recorder';
import {
  getScreenshotsDir,
  getHtmlDir,
  getPagesDir,
  getApiDir,
  getHarDir,
  getAnalysisDir,
  writeJson,
  writeText,
  urlToFilename,
} from '../utils/file-system';
import { sleep } from '../utils/retry';
import { logger } from '../utils/logger';
import { sessionExists, getSessionPath, waitForLoginAndSaveSession, saveSession } from '../crawler/session';
import { isUrlSafe, SAFETY_SUMMARY } from '../crawler/safety';
import { browserClosedMessage, isBrowserClosedError } from '../crawler/browser-closed';
import { attachLiveLogOverlay, hideLiveLogOverlay, showLiveLogOverlay, isLiveLogOverlayPage, type LogOverlayHandle } from '../crawler/log-overlay';
import { installSessionEndGuard } from '../crawler/session-end-guard';
import { crawlAbortRegistry } from '../crawler/crawl-abort';
import { emitCrawlLog } from '../crawler/live-log';
import { config } from '../config';
import { installNewPageFollower, waitForPageSettled, isBlankOrNewTabUrl, type NewPageFollower } from '../crawler/new-page-follower';
import type { Project, CrawlSession } from '@prisma/client';
import type { AgentAction } from './types';
import fs from 'fs';

export interface CollaborativeCrawlOptions {
  project: Project;
  session: CrawlSession;
  projectSlug: string;
  llmConfig?: LLMConfig;
  onProgress?: (info: { visitedCount: number; queuedCount: number; summary: string }) => void;
  existingContext?: { browser: Browser; context: BrowserContext };
  abortSignal?: AbortSignal;
}

const outputAbsDir = path.resolve(process.cwd(), config.outputDir);

/**
 * Runs both the BFS Explorer and the LLM Navigator as concurrent agents,
 * sharing a live SharedCrawlState so they complement rather than duplicate.
 *
 *  BFS Explorer  →  fast, discovers all <a href> links, flags complex pages
 *  LLM Navigator →  smart, explores tabs/dynamic content, finds hidden pages
 *
 * Both write discovered URLs into the shared queue and read from it.
 * The LLM Navigator prefers pages flagged needsDeep=true by the BFS agent.
 */
export async function runCollaborativeCrawl(options: CollaborativeCrawlOptions): Promise<void> {
  const { project, session, projectSlug, llmConfig, onProgress, existingContext, abortSignal } = options;

  const allowedDomains: string[] = JSON.parse(project.allowedDomains || '[]') as string[];
  const excludedUrls: string[] = JSON.parse(project.excludedUrls || '[]') as string[];
  const maxDepth = project.crawlDepth;

  if (allowedDomains.length === 0) {
    try { allowedDomains.push(new URL(project.baseUrl).hostname); } catch { /* ignore */ }
  }

  // State will be seeded with the correct start URL after login (postLoginUrl replaces baseUrl below)
  const state = new SharedCrawlState(project.baseUrl, maxDepth, allowedDomains, excludedUrls);

  const onAbort = () => {
    state.abort(abortSignal?.reason ? String(abortSignal.reason) : 'Stopped by user');
  };
  abortSignal?.addEventListener('abort', onAbort);
  if (abortSignal?.aborted) onAbort();

  // ── Browser setup (two Chromium windows: BFS + LLM) ───────────────────
  let bfsBrowser: Browser | null = existingContext?.browser ?? null;
  let bfsContext: BrowserContext | null = existingContext?.context ?? null;
  let llmBrowser: Browser | null = null;
  let llmContext: BrowserContext | null = null;
  let ownBrowser = false;
  let postLoginUrl = project.baseUrl; // overridden after login
  let logOverlay: LogOverlayHandle | null = null;
  let headed = false;
  let bfsPageFollower: NewPageFollower | null = null;
  let llmPageFollower: NewPageFollower | null = null;

  try {
    // ── Step 1: Login if required (same flow as BFS + Agentic crawlers) ──
    if (project.loginRequired && !bfsContext) {
      await prisma.crawlSession.update({
        where: { id: session.id },
        data: { status: 'awaiting_login', errorMessage: 'Browser opened — please log in to continue.' },
      }).catch(() => undefined);

      const loginUrl = project.loginUrl || project.baseUrl;
      const liveSession = await waitForLoginAndSaveSession(loginUrl, projectSlug, (msg) => {
        logger.info(`[Collab] ${msg}`);
        onProgress?.({ visitedCount: 0, queuedCount: 0, summary: msg });
      });

      // Window 1 (BFS): keep the already-authenticated login browser
      bfsBrowser = liveSession.browser;
      bfsContext = liveSession.context;
      ownBrowser = true;
      headed = true;

      // Both agents start from the exact URL captured at Done click
      postLoginUrl = liveSession.postLoginUrl;
      logger.info(`[Collab] Post-login URL: ${postLoginUrl}`);

      // Fresh session.json so Window 2 can clone cookies/localStorage
      await saveSession(bfsContext, projectSlug);

      // Re-seed the shared queue with the actual post-login URL
      state.reseed(postLoginUrl);

      await prisma.crawlSession.update({
        where: { id: session.id },
        data: { status: 'running', errorMessage: null },
      }).catch(() => undefined);
    }

    if (!bfsContext) {
      const headless = config.crawler.headless;
      headed = !headless;
      bfsBrowser = await chromium.launch({
        headless,
        slowMo: headless ? 0 : 200,
        args: headed ? ['--start-maximized'] : undefined,
      });
      ownBrowser = true;

      const ctxOpts: Record<string, unknown> = {
        viewport: { width: 1440, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      };
      if (sessionExists(projectSlug)) {
        ctxOpts['storageState'] = getSessionPath(projectSlug);
        logger.info('[Collab] Loaded saved session for BFS window');
      }

      bfsContext = await bfsBrowser.newContext(ctxOpts);
    }

    // Window 2 (LLM): separate Chromium process with copied session — no shared tabs
    if (isLLMConfigured(llmConfig)) {
      if (!sessionExists(projectSlug) && bfsContext) {
        await saveSession(bfsContext, projectSlug);
      }
      const headless = !headed;
      llmBrowser = await chromium.launch({
        headless,
        slowMo: headless ? 0 : 200,
        args: headed ? ['--start-maximized'] : undefined,
      });
      const llmCtxOpts: Record<string, unknown> = {
        viewport: { width: 1440, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      };
      if (sessionExists(projectSlug)) {
        llmCtxOpts['storageState'] = getSessionPath(projectSlug);
        logger.info('[Collab] Copied login session into LLM window');
      }
      llmContext = await llmBrowser.newContext(llmCtxOpts);
      logger.info('[Collab] Opened separate Chromium window for LLM navigator');
    }

    // Block form submissions + session-end nav on both windows
    for (const ctx of [bfsContext, llmContext].filter(Boolean) as BrowserContext[]) {
      ctx.on('page', (p) => {
        p.addInitScript(() => {
          document.addEventListener('submit', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
        }).catch(() => undefined);
      });
      await installSessionEndGuard(ctx);
    }

  const collabDepth = { current: 0 };
    const sharedPageRecorders = new WeakMap<Page, ReturnType<typeof createNetworkRecorder> | null>();
    const attachSharedRecorder = (target: Page) => {
      if (sharedPageRecorders.has(target)) return sharedPageRecorders.get(target) ?? null;
      const recorder = project.networkCaptureEnabled ? createNetworkRecorder(target) : null;
      sharedPageRecorders.set(target, recorder);
      return recorder;
    };

    bfsPageFollower = installNewPageFollower(bfsContext, {
      onPageCreated: (opened) => {
        attachSharedRecorder(opened);
      },
      onNewPage: (_opened, openedUrl) => {
        if (isBlankOrNewTabUrl(openedUrl)) return;
        const depth = Math.min(collabDepth.current + 1, maxDepth);
        if (state.addUrl(openedUrl, depth, false, 'bfs')) {
          logger.info(`[Collab][BFS] Followed new tab/window (depth ${depth}): ${openedUrl}`);
          emitCrawlLog(session.id, 'info', `BFS followed new tab: ${openedUrl}`);
        }
      },
    });

    if (llmContext) {
      llmPageFollower = installNewPageFollower(llmContext, {
        onPageCreated: (opened) => {
          attachSharedRecorder(opened);
        },
        onNewPage: (_opened, openedUrl) => {
          if (isBlankOrNewTabUrl(openedUrl)) return;
          const depth = Math.min(collabDepth.current + 1, maxDepth);
          if (state.addUrl(openedUrl, depth, false, 'llm')) {
            logger.info(`[Collab][LLM] Followed new tab/window (depth ${depth}): ${openedUrl}`);
            emitCrawlLog(session.id, 'info', `LLM followed new tab: ${openedUrl}`);
          }
        },
      });
    }

    await prisma.crawlSession.update({
      where: { id: session.id },
      data: { status: 'running', startedAt: new Date() },
    }).catch(() => undefined);

    crawlAbortRegistry.registerBrowser(session.id, bfsBrowser);
    crawlAbortRegistry.registerBrowser(session.id, llmBrowser);

    const screenshotsDir = getScreenshotsDir(projectSlug, session.id);
    const htmlDir = getHtmlDir(projectSlug, session.id);
    const pagesDir = getPagesDir(projectSlug, session.id);
    const apiDir = getApiDir(projectSlug, session.id);
    const harDir = getHarDir(projectSlug, session.id);

    logger.info('[Collab] Starting collaborative crawl — BFS + LLM agents in separate Chromium windows');

    if (!headed) headed = !config.crawler.headless;

    if (headed && bfsContext) {
      logOverlay = attachLiveLogOverlay(bfsContext, session.id);
      emitCrawlLog(session.id, 'info', 'Live crawl log overlay attached to BFS window');
    }

    const progressTimer = setInterval(() => {
      const summary = state.getSummary();
      logger.info(`[Collab] ${summary}`);
      onProgress?.({
        visitedCount: state.totalPagesVisited,
        queuedCount: state.urlQueue.length,
        summary,
      });
      prisma.crawlSession.update({
        where: { id: session.id },
        data: { pagesCount: state.totalPagesVisited },
      }).catch(() => undefined);
    }, 5000);

    // ── Run both agents concurrently ──────────────────────────────────────
    logger.info(`[Collab] Starting both agents from: ${postLoginUrl}`);

    await Promise.all([
      runBfsAgent(state, bfsContext!, session.id, projectSlug, screenshotsDir, htmlDir, pagesDir, apiDir, harDir, project, bfsPageFollower, collabDepth, attachSharedRecorder),
      isLLMConfigured(llmConfig) && llmContext
        ? runLlmAgent(state, llmContext, session.id, projectSlug, screenshotsDir, htmlDir, pagesDir, apiDir, harDir, project, llmConfig!, postLoginUrl, llmPageFollower, collabDepth, attachSharedRecorder)
        : Promise.resolve(),
    ]);

    clearInterval(progressTimer);

    if (state.aborted) {
      const reason = state.abortReason ?? 'Crawl aborted';
      logger.warn(`[Collab] Crawl stopped early: ${reason}`);
      // Don't overwrite status if Stop Crawl already set "stopped"
      await prisma.crawlSession.updateMany({
        where: { id: session.id, status: { not: 'stopped' } },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          pagesCount: state.totalPagesVisited,
          errorMessage: reason.slice(0, 500),
        },
      }).catch(() => undefined);
      return;
    }

    logger.info(`[Collab] Both agents finished. ${state.getSummary()}`);
    logger.info(`[Collab] Modules discovered: ${[...state.discoveredModules].join(', ')}`);
    logger.info(`[Collab] Entities discovered: ${[...state.discoveredEntities].join(', ')}`);

    await prisma.crawlSession.update({
      where: { id: session.id },
      data: { status: 'completed', finishedAt: new Date(), pagesCount: state.totalPagesVisited },
    }).catch(() => undefined);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[Collab] Crawl failed: ${msg}`);
    await prisma.crawlSession.update({
      where: { id: session.id },
      data: { status: 'failed', finishedAt: new Date(), errorMessage: msg },
    }).catch(() => undefined);
    throw err;
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    bfsPageFollower?.dispose();
    llmPageFollower?.dispose();
    logOverlay?.dispose();
    if (ownBrowser || abortSignal?.aborted) {
      await llmContext?.close().catch(() => undefined);
      await llmBrowser?.close().catch(() => undefined);
      await bfsContext?.close().catch(() => undefined);
      await bfsBrowser?.close().catch(() => undefined);
    } else if (llmContext && llmContext !== bfsContext) {
      await llmContext.close().catch(() => undefined);
      await llmBrowser?.close().catch(() => undefined);
    }
  }
}

// ── BFS Agent ─────────────────────────────────────────────────────────────────

async function runBfsAgent(
  state: SharedCrawlState,
  context: BrowserContext,
  sessionId: string,
  projectSlug: string,
  screenshotsDir: string,
  htmlDir: string,
  pagesDir: string,
  apiDir: string,
  harDir: string,
  project: Project,
  newPageFollower: NewPageFollower | null,
  collabDepth: { current: number },
  attachSharedRecorder?: (target: Page) => ReturnType<typeof createNetworkRecorder> | null,
): Promise<void> {
  let page =
    context.pages().filter((p) => !p.isClosed() && !isLiveLogOverlayPage(p)).slice(-1)[0]
    ?? await context.newPage();

  const pageRecorders = new WeakMap<Page, ReturnType<typeof createNetworkRecorder> | null>();
  const attachRecorder = attachSharedRecorder ?? ((target: Page) => {
    if (pageRecorders.has(target)) return pageRecorders.get(target) ?? null;
    const recorder = project.networkCaptureEnabled ? createNetworkRecorder(target) : null;
    pageRecorders.set(target, recorder);
    return recorder;
  });

  let networkRecorder = attachRecorder(page);
  newPageFollower?.claimPage(page);
  const bindPage = (next: Page) => {
    newPageFollower?.claimPage(next);
    if (next === page) return;
    page = next;
    networkRecorder = attachRecorder(page);
  };
  const consoleErrors: Array<{ type: 'error' | 'warning'; text: string }> = [];
  page.on('console', (msg) => {
    const t = msg.type() as 'error' | 'warning';
    if (t === 'error' || t === 'warning') consoleErrors.push({ type: t, text: msg.text().slice(0, 300) });
  });

  logger.info('[BFS] Agent started');
  let idleCount = 0;
  const visitedActionKeys = new Set<string>();
  const allowedDomains = JSON.parse(project.allowedDomains || '[]') as string[];
  const excludedUrls = JSON.parse(project.excludedUrls || '[]') as string[];
  if (allowedDomains.length === 0) {
    try { allowedDomains.push(new URL(project.baseUrl).hostname); } catch { /* ignore */ }
  }

  while (true) {
    if (state.aborted) break;

    const entry = state.claimUrl('bfs');

    if (!entry) {
      // Stay alive while the sibling agent may still discover URLs (SPA crawls need patience)
      if (state.aborted) break;
      if (state.llmDone && state.urlQueue.length === 0 && state.inProgressUrls.size === 0) break;
      if (idleCount > 60) break; // ~60s empty-queue patience
      idleCount++;
      await sleep(1000);
      continue;
    }

    idleCount = 0;
    consoleErrors.length = 0;

    const { url, depth } = entry;
    collabDepth.current = Math.max(collabDepth.current, depth);
    if (!isUrlSafe(url, allowedDomains, excludedUrls)) {
      logger.warn(`[BFS] Skipping unsafe/session-end URL: ${url}`);
      state.releaseUrl(url, true);
      continue;
    }
    logger.info(`[BFS] [${depth}] ${url}`);

    const live = newPageFollower?.consumeLivePage(url);
    const adoptedExistingTab = Boolean(live && !live.isClosed());
    if (live && !live.isClosed()) {
      bindPage(live);
      await waitForPageSettled(live);
      await live.bringToFront().catch(() => undefined);
    } else if (page.isClosed()) {
      const fallback =
        context.pages().filter((candidate) => !candidate.isClosed() && !isLiveLogOverlayPage(candidate))[0]
        ?? await context.newPage();
      bindPage(fallback);
    }

    if (!adoptedExistingTab) {
      await networkRecorder?.reset();
    }

    const pageCapture = await prisma.pageCapture.create({
      data: { crawlSessionId: sessionId, url, depth },
    }).catch(() => null);

    let success = false;
    try {
      if (page.isClosed() || !context.browser()?.isConnected()) {
        throw new Error('Target page, context or browser has been closed');
      }
      const alreadyThere = adoptedExistingTab || state.normalizeUrl(page.url()) === state.normalizeUrl(url);
      if (!alreadyThere) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.crawler.timeoutMs });
        const spawned = newPageFollower?.takePendingForUrl(url);
        if (spawned && !spawned.isClosed()) {
          bindPage(spawned);
          await waitForPageSettled(spawned);
          await spawned.bringToFront().catch(() => undefined);
        }
      }
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      await sleep(800);

      const title = await page.title().catch(() => '');

      // Detect if this page warrants deep LLM exploration
      const tabCount = await page.evaluate(() =>
        document.querySelectorAll('[role="tab"], [class*="tab-item"], .nav-tabs a').length
      ).catch(() => 0);

      if (tabCount >= 2 && depth < project.crawlDepth) {
        state.flagForDeepExplore(url, depth);
        logger.info(`[BFS] Flagged for deep explore (${tabCount} tabs): ${url}`);
      }

      // Full-page screenshot
      let screenshotPath: string | undefined;
      if (project.screenshotEnabled) {
        const fname = urlToFilename(url, '.png');
        const absShot = path.join(screenshotsDir, fname);
        await hideLiveLogOverlay(page);
        await page.screenshot({ path: absShot, fullPage: true, timeout: 20_000 }).catch(() => undefined);
        await showLiveLogOverlay(page);
        screenshotPath = path.relative(outputAbsDir, absShot).replace(/\\/g, '/');
      }

      const html = await page.content().catch(() => '');
      writeText(path.join(htmlDir, urlToFilename(url, '.html')), html);

      const browserScript = getBrowserScript();
      await page.evaluate(browserScript).catch(() => undefined);
      const extractedData = await extractPageData(page, url, [], [...consoleErrors]).catch(() => null);
      let interactionLinks: string[] = [];
      if (depth < project.crawlDepth) {
        const interactionResult = await exploreSafeInteractions(page, url, {
          allowedDomains,
          excludedUrls,
          visitedActionKeys,
          maxClicks: 10,
        }).catch((err) => {
          logger.debug(`[BFS] Interaction exploration skipped: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        });
        if (interactionResult) {
          interactionLinks = interactionResult.links;
          if (extractedData && interactionResult.snapshots.length > 0) {
            (extractedData as unknown as Record<string, unknown>)['interactionExploration'] = interactionResult.snapshots;
            logger.info(`[BFS] Opened ${interactionResult.snapshots.length} safe modal/form interaction(s), found ${interactionLinks.length} link(s)`);
          }
        }
      }
      if (extractedData) writeJson(path.join(pagesDir, urlToFilename(url, '.json')), extractedData);

      const visibleText = await page.evaluate(() => document.body?.innerText?.slice(0, 10000) ?? '').catch(() => '');

      // Expand navbar dropdowns so SPA/hash menu links become visible in the DOM
      await expandNavDropdowns(page);
      let newCount = await enqueueDiscoveredLinks(page, url, depth, state, allowedDomains, excludedUrls, 'bfs');
      for (const link of interactionLinks) {
        if (isUrlSafe(link, allowedDomains, excludedUrls) && state.addUrl(link, depth + 1, false, 'bfs')) {
          newCount += 1;
        }
      }
      if (newCount === 0) logger.debug(`[BFS] No new URLs from ${url}`);

      await networkRecorder?.flush();

      // Record knowledge for LLM agent to learn from
      state.recordPage(url, {
        title,
        pageType: extractedData?.pageType ?? 'unknown',
        formCount: extractedData?.forms?.length ?? 0,
        tableCount: extractedData?.tables?.length ?? 0,
        tabCount,
        hasModal: extractedData?.modals?.some(m => m.isVisible) ?? false,
        features: [
          ...(extractedData?.navigation?.currentModule ? [extractedData.navigation.currentModule] : []),
          ...extractedData?.navigation?.breadcrumbs ?? [],
        ].filter(Boolean),
        capturedBy: 'bfs',
      }, networkRecorder?.getCalls().length ?? 0);

      if (extractedData?.techStack?.frameworks?.length) {
        extractedData.techStack.frameworks.forEach(f => state.recordModule(f));
      }
      if (extractedData?.navigation?.currentModule) {
        state.recordModule(extractedData.navigation.currentModule);
      }

      // Save network calls + per-page HAR
      const calls = networkRecorder?.getCalls() ?? [];
      if (networkRecorder) {
        writeJson(path.join(apiDir, urlToFilename(url, '-api.json')), calls);
        writeJson(path.join(harDir, urlToFilename(url, '.har')), networkRecorder.getHar(url));
      }
      if (calls.length > 0) {
        await prisma.networkCall.createMany({
          data: calls.map(c => ({
            crawlSessionId: sessionId,
            pageCaptureId: pageCapture?.id,
            method: c.method, url: c.url,
            queryParams: JSON.stringify(c.queryParams),
            requestPayload: c.requestPayload,
            requestContentType: c.requestContentType,
            responseStatus: c.responseStatus,
            responseBody: c.responseBody,
            responseContentType: c.responseContentType,
            responseSchemaKeys: c.responseSchemaKeys ? JSON.stringify(c.responseSchemaKeys) : null,
            requestHeaders: c.requestHeaders,
            responseHeaders: c.responseHeaders,
            timingMs: c.timingMs,
            resourceType: c.resourceType,
            isGraphQL: c.isGraphQL,
            graphQLOperationName: c.graphQLOperationName,
          })),
        }).catch(() => undefined);
      }

      if (pageCapture) {
        await prisma.pageCapture.update({
          where: { id: pageCapture.id },
          data: {
            title,
            html: html.slice(0, 500_000),
            visibleText: visibleText.slice(0, 20_000),
            breadcrumbs: JSON.stringify(extractedData?.breadcrumbs ?? []),
            screenshotPath: screenshotPath ?? null,
            fullScreenshotPath: screenshotPath ?? null,
            extractedData: extractedData ? JSON.stringify(extractedData) : null,
          },
        }).catch(() => undefined);
      }

      success = true;
      logger.info(`[BFS] ✓ "${title}"`);
    } catch (err) {
      logger.warn(`[BFS] Failed ${url}: ${err instanceof Error ? err.message : String(err)}`);
      // Remove the placeholder row so failed navigations don't inflate page counts
      if (pageCapture) {
        await prisma.pageCapture.delete({ where: { id: pageCapture.id } }).catch(() => undefined);
      }
      if (isBrowserClosedError(err) || page.isClosed() || !context.browser()?.isConnected()) {
        state.abort(browserClosedMessage(err));
        state.releaseUrl(url, false);
        break;
      }
    }

    state.releaseUrl(url, success);
    if (state.aborted) break;
    await sleep(config.crawler.delayMs);
  }

  state.bfsDone = true;
  await networkRecorder?.stop();
  logger.info(`[BFS] Agent finished. Pages: ${state.stats.bfsPages}`);
}

// ── LLM Navigator Agent ───────────────────────────────────────────────────────

async function runLlmAgent(
  state: SharedCrawlState,
  context: BrowserContext,
  sessionId: string,
  projectSlug: string,
  screenshotsDir: string,
  htmlDir: string,
  pagesDir: string,
  apiDir: string,
  harDir: string,
  project: Project,
  llmConfig: LLMConfig,
  startUrl?: string,
  newPageFollower?: NewPageFollower | null,
  collabDepth?: { current: number },
  attachSharedRecorder?: (target: Page) => ReturnType<typeof createNetworkRecorder> | null,
): Promise<void> {
  const llm = createLLMClient(llmConfig);
  // Dual windows — no need to wait for BFS; LLM has its own seed claim
  await sleep(500);

  // Open LLM window and navigate to the same page the user was on after login
  // (the dashboard, NOT back to the login page / baseUrl from scratch)
  const targetUrl = startUrl ?? project.baseUrl;
  let page = newPageFollower
    ? await newPageFollower.runWithoutFollowing(() => context.newPage())
    : await context.newPage();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  logger.info(`[LLM] Window started at: ${page.url()}`);

  const pageRecorders = new WeakMap<Page, ReturnType<typeof createNetworkRecorder> | null>();
  const attachRecorder = attachSharedRecorder ?? ((target: Page) => {
    if (pageRecorders.has(target)) return pageRecorders.get(target) ?? null;
    const recorder = project.networkCaptureEnabled ? createNetworkRecorder(target) : null;
    pageRecorders.set(target, recorder);
    return recorder;
  });

  let networkRecorder = attachRecorder(page);
  newPageFollower?.claimPage(page);
  const bindPage = (next: Page) => {
    newPageFollower?.claimPage(next);
    if (next === page) return;
    page = next;
    networkRecorder = attachRecorder(page);
  };

  logger.info('[LLM] Navigator agent started');
  let idleCount = 0;
  let consecutiveDones = 0;
  const visitedActionKeys = new Set<string>();
  const visitedPageMeta: Array<{ url: string; title: string; pageType: string }> = [];
  let plannerCallCount = 0;
  const memory = createEmptyAgentMemory([
    `Explore all modules of ${project.name}`,
    'Document forms, tables, editors, and catalogues',
    'Discover workflows without submitting destructive actions',
  ]);
  // Keep visited sets synced with shared collab state
  memory.visitedUrls = state.visitedUrls;
  memory.visitedFeatures = state.discoveredFeatures;
  const allowedDomains = JSON.parse(project.allowedDomains || '[]') as string[];
  const excludedUrls = JSON.parse(project.excludedUrls || '[]') as string[];
  if (allowedDomains.length === 0) {
    try { allowedDomains.push(new URL(project.baseUrl).hostname); } catch { /* ignore */ }
  }

  while (true) {
    if (state.aborted) break;

    const entry = state.claimUrl('llm');

    if (!entry) {
      if (state.aborted) break;
      if (
        state.bfsDone &&
        state.urlQueue.length === 0 &&
        state.inProgressUrls.size === 0 &&
        !state.hasPendingLlmWork()
      ) {
        break;
      }
      if (idleCount > 60) break;
      idleCount++;
      await sleep(1500);
      continue;
    }

    idleCount = 0;
    const { url, depth, needsDeep } = entry;
    if (collabDepth) collabDepth.current = Math.max(collabDepth.current, depth);

    if (!isUrlSafe(url, allowedDomains, excludedUrls)) {
      logger.warn(`[LLM] Skipping unsafe/session-end URL: ${url}`);
      state.releaseUrl(url, true, 'llm');
      continue;
    }

    logger.info(`[LLM] [${depth}${needsDeep ? ' DEEP' : ''}] ${url}`);

    const live = newPageFollower?.consumeLivePage(url);
    const adoptedExistingTab = Boolean(live && !live.isClosed());
    if (live && !live.isClosed()) {
      bindPage(live);
      await waitForPageSettled(live);
      await live.bringToFront().catch(() => undefined);
    } else if (page.isClosed()) {
      const fallback =
        context.pages().filter((candidate) => !candidate.isClosed() && !isLiveLogOverlayPage(candidate)).slice(-1)[0]
        ?? await context.newPage();
      bindPage(fallback);
    }

    if (!adoptedExistingTab) {
      await networkRecorder?.reset();
    }

    const pageCapture = await prisma.pageCapture.create({
      data: { crawlSessionId: sessionId, url, depth },
    }).catch(() => null);

    let success = false;
    try {
      if (page.isClosed() || !context.browser()?.isConnected()) {
        throw new Error('Target page, context or browser has been closed');
      }
      const alreadyThere = adoptedExistingTab || state.normalizeUrl(page.url()) === state.normalizeUrl(url);
      if (!alreadyThere) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.crawler.timeoutMs });
        const spawned = newPageFollower?.takePendingForUrl(url);
        if (spawned && !spawned.isClosed()) {
          bindPage(spawned);
          await waitForPageSettled(spawned);
          await spawned.bringToFront().catch(() => undefined);
        }
      }
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      await sleep(1200);

      const title = await page.title().catch(() => '');

      // Capture base state of the page
      await capturePage(page, url, title, sessionId, pageCapture?.id, screenshotsDir, htmlDir, pagesDir, apiDir, harDir, project, networkRecorder, state);

      // Harvest links immediately (SPA hash routes included)
      await enqueueDiscoveredLinks(page, url, depth, state, allowedDomains, excludedUrls, 'llm');

      // Optional tab pass, then ALWAYS multi-step navigator (menus / SPA routes).
      // needsDeep-only used to skip multi-step → 0 interactions on Essential Cloud.
      if (needsDeep) {
        await deepExplore(page, url, depth, state, llm, project.name, sessionId, pageCapture?.id, screenshotsDir, htmlDir, pagesDir, apiDir, harDir, project, networkRecorder);
        state.markDeepCompleted(url);
        await enqueueDiscoveredLinks(page, page.url(), depth, state, allowedDomains, excludedUrls, 'llm');
      }

      {
        const maxPageSteps = Math.min(12, Math.max(4, Math.floor(config.crawler.agentMaxSteps / 10)));
        let pageDones = 0;
        for (let pageStep = 0; pageStep < maxPageSteps; pageStep++) {
          if (state.aborted || page.isClosed()) break;

          const pageState = await observePage(page).catch(() => null);
          if (!pageState) break;
          pageState.interactiveElements = pageState.interactiveElements.filter((el) => {
            const key = el.actionKey ?? `${el.actionKind}:${el.text.toLowerCase()}`;
            return !visitedActionKeys.has(key);
          });
          if (pageState.interactiveElements.length === 0) {
            logger.info(`[LLM] No more safe unvisited controls on ${page.url()}`);
            break;
          }

          let action: AgentAction;
          try {
            memory.currentDepth = depth;
            memory.discoveredEntities = [...state.discoveredEntities];
            let raw: AgentAction;
            try {
              raw = await llm.chatJson<AgentAction>(
                buildNavigatorMessages(pageState, memory, project.name),
                { maxTokens: 4_096 },
              );
            } catch (textErr) {
              const vision = await captureNavigatorVision(page, pageState);
              if (!vision) throw textErr;
              logger.warn(`[LLM] Text navigation failed, retrying with vision: ${textErr instanceof Error ? textErr.message : String(textErr)}`);
              raw = await llm.chatJson<AgentAction>(
                buildNavigatorMessages(pageState, memory, project.name, vision.dataUrl),
                { maxTokens: 4_096 },
              );
            }
            action = validateAction(raw, pageState);
          } catch {
            const preferred = pageState.interactiveElements.find(
              (e) => e.isSafe && (e.isNavigation || e.actionKind === 'navigation' || e.tag === 'a'),
            ) ?? pageState.interactiveElements.find((e) => e.isSafe);
            action = preferred
              ? {
                  type: 'click',
                  elementIndex: preferred.index,
                  reason: `Heuristic fallback: explore "${preferred.text}"`,
                  confidence: 0.35,
                }
              : { type: 'done', reason: 'LLM failed', confidence: 1 };
          }

          logger.info(
            `[LLM] Step ${pageStep + 1}/${maxPageSteps}: ${action.type}` +
              `${action.elementIndex !== undefined ? ` [${action.elementIndex}]` : ''} | ${action.reason}`,
          );

          if (action.type === 'done') {
            pageDones++;
            consecutiveDones++;
            if (pageDones >= 2) break;
            continue;
          }
          pageDones = 0;
          consecutiveDones = 0;

          const result = await executeAction(page, action, pageState);
          if (result.page && result.page !== page) {
            bindPage(result.page);
          } else {
            const extraTab = newPageFollower?.takePending();
            if (extraTab && extraTab !== page && !extraTab.isClosed()) {
              bindPage(extraTab);
            }
          }
          if (action.type === 'click') {
            const el = pageState.interactiveElements.find((item) => item.index === action.elementIndex);
            if (el) visitedActionKeys.add(el.actionKey ?? `${el.actionKind}:${el.text.toLowerCase()}`);
          }

          let outcomeNote = result.success ? undefined : (result.error ?? 'action failed');
          if (result.success) {
            if (result.newUrl && result.newUrl !== url) {
              state.addUrl(result.newUrl, depth + 1, false, 'llm');
            }
            const afterState = await observePage(page).catch(() => null);
            if (afterState) {
              try {
                const validation = await llm.chatJson<ValidatorOutput>(
                  buildValidatorMessages(project.name, pageState, afterState, action),
                  { maxTokens: 2_048 },
                );
                logger.info(`[LLM][Validator] ${validation.success ? 'ok' : 'check'} | new info: ${validation.newInfoFound ? 'yes' : 'no'} | ${validation.observation}`);
                outcomeNote = validation.observation;
                if (validation.shouldBacktrack) {
                  logger.info(`[LLM][Validator] Backtracking: ${validation.retryReason || validation.observation}`);
                  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
                  await sleep(400);
                }
              } catch (err) {
                logger.warn(`[LLM][Validator] Failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }

          const clickLabel = (() => {
            if (action.type !== 'click' || action.elementIndex === undefined) return describeAction(action);
            const el = pageState.interactiveElements.find((item) => item.index === action.elementIndex);
            return el ? `click [${el.index}] "${el.text}"` : describeAction(action);
          })();
          appendInteraction(memory, {
            url: pageState.url,
            title: pageState.title,
            pageType: pageState.pageType,
            actionType: action.type,
            actionDetail: clickLabel,
            reason: action.reason,
            resultUrl: page.isClosed() ? result.newUrl : page.url(),
            outcome: outcomeNote,
          });
          await maybeCreateRollingSummary(llm, memory, project.name);

          // Critical: after opening dropdowns/menus, harvest newly revealed hash links into the shared queue
          await enqueueDiscoveredLinks(page, page.url(), depth, state, allowedDomains, excludedUrls, 'llm');
          await sleep(500);
        }
      }

      await networkRecorder?.flush();

      // Record knowledge
      const extractedData = await extractPageData(page, url, []).catch(() => null);
      state.recordPage(url, {
        title,
        pageType: extractedData?.pageType ?? 'unknown',
        formCount: extractedData?.forms?.length ?? 0,
        tableCount: extractedData?.tables?.length ?? 0,
        tabCount: extractedData?.navigation?.tabs?.length ?? 0,
        hasModal: false,
        features: [title, ...(extractedData?.navigation?.breadcrumbs ?? [])].filter(Boolean),
        capturedBy: 'llm',
      }, networkRecorder?.getCalls().length ?? 0);
      visitedPageMeta.push({ url, title, pageType: extractedData?.pageType ?? 'unknown' });

      // Extract entity/module hints from breadcrumbs and headings
      (extractedData?.navigation?.breadcrumbs ?? []).forEach((b: string) => state.recordModule(b));
      (extractedData?.headings ?? []).slice(0, 3).forEach((h: { text: string }) => {
        if (h.text) state.recordEntity(h.text);
      });

      if (visitedPageMeta.length >= 3 && visitedPageMeta.length % 12 === 0) {
        plannerCallCount++;
        try {
          const plan = await llm.chatJson<PlannerOutput>(
            buildPlannerMessages(project.name, visitedPageMeta, [...state.discoveredFeatures], memory),
            { maxTokens: 1200 },
          );
          if (plan.explorationGoals?.length) {
            memory.explorationGoals = plan.explorationGoals;
            memory.activeInstructions = [
              ...plan.explorationGoals.slice(0, 5),
              ...(plan.recommendation ? [`Planner: ${plan.recommendation}`] : []),
              ...memory.activeInstructions.filter((i) => i.startsWith('Continue:') || i.startsWith('Avoid re-doing:')).slice(0, 8),
            ];
          }
          logger.info(`[LLM][Planner] Coverage ~${(plan.coverageEstimate * 100).toFixed(0)}% | Missing: ${(plan.missingModules ?? []).join(', ') || 'none listed'}`);
          if (plan.nextPriorityUrl?.startsWith('http') && !state.visitedUrls.has(plan.nextPriorityUrl)) {
            logger.info(`[LLM][Planner] Queuing priority URL: ${plan.nextPriorityUrl}`);
            state.addUrl(plan.nextPriorityUrl, depth + 1, true, 'llm');
          }
        } catch (err) {
          logger.warn(`[LLM][Planner] Failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      success = true;
    } catch (err) {
      logger.warn(`[LLM] Failed ${url}: ${err instanceof Error ? err.message : String(err)}`);
      if (pageCapture) {
        await prisma.pageCapture.delete({ where: { id: pageCapture.id } }).catch(() => undefined);
      }
      if (isBrowserClosedError(err) || page.isClosed() || !context.browser()?.isConnected()) {
        state.abort(browserClosedMessage(err));
        state.releaseUrl(url, false, 'llm');
        break;
      }
    }

    state.releaseUrl(url, success, 'llm');
    if (state.aborted) break;
    await sleep(800);

    if (consecutiveDones >= 5 && state.urlQueue.length === 0 && state.bfsDone && !state.hasPendingLlmWork()) break;
  }

  state.llmDone = true;
  await networkRecorder?.stop();
  await page.close().catch(() => undefined);
  writeJson(path.join(getAnalysisDir(projectSlug, sessionId), 'rolling-context.json'), rollingContextSnapshot(memory));
  logger.info(`[LLM] Agent finished. Pages: ${state.stats.llmPages}, LLM-discovered URLs: ${state.stats.urlsAddedByLLM}, planner calls: ${plannerCallCount}, interactions: ${memory.interactionHistory.length}, summaries: ${memory.rollingSummaries.length}`);
}

// ── Deep exploration: click through all tabs/panels on a page ────────────────

async function deepExplore(
  page: Page,
  pageUrl: string,
  depth: number,
  state: SharedCrawlState,
  llm: ReturnType<typeof createLLMClient>,
  appName: string,
  sessionId: string,
  pageCaptureId: string | undefined,
  screenshotsDir: string,
  htmlDir: string,
  pagesDir: string,
  apiDir: string,
  harDir: string,
  project: Project,
  networkRecorder: ReturnType<typeof createNetworkRecorder> | null,
): Promise<void> {
  logger.info(`[LLM] Deep exploring tabs/panels on: ${pageUrl}`);

  const allowedDomains = JSON.parse(project.allowedDomains || '[]') as string[];
  const excludedUrls = JSON.parse(project.excludedUrls || '[]') as string[];
  if (allowedDomains.length === 0) {
    try { allowedDomains.push(new URL(project.baseUrl).hostname); } catch { /* ignore */ }
  }

  // Find all tabs on the page
  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="tab"], [class*="tab-item"], .nav-tabs a, [class*="Tab"]'))
      .map(el => ({ text: (el.textContent || '').trim(), selector: el.id ? `#${el.id}` : el.tagName.toLowerCase() }))
      .filter(t => t.text && t.text.length < 50)
  ).catch(() => []) as Array<{ text: string; selector: string }>;

  for (let i = 0; i < Math.min(tabs.length, 8); i++) {
    const tab = tabs[i]!;
    try {
      // Click the tab
      await page.getByRole('tab', { name: new RegExp(tab.text, 'i') }).first().click({ timeout: 5000 }).catch(async () => {
        await page.locator(`text="${tab.text}"`).first().click({ timeout: 3000 }).catch(() => undefined);
      });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      await sleep(600);

      // Capture what's now visible under this tab
      const tabData = await extractPageData(page, pageUrl, []).catch(() => null);
      if (tabData) {
        writeJson(path.join(pagesDir, urlToFilename(`${pageUrl}#tab-${tab.text}`, '.json')), { ...tabData, tabName: tab.text });
      }

      // Check if tab revealed new links
      const newLinks = await discoverLinks(page, pageUrl, allowedDomains, excludedUrls);
      for (const link of newLinks) {
        state.addUrl(link, depth + 1, false, 'llm');
      }

      logger.debug(`[LLM] Deep: tab "${tab.text}" → ${newLinks.length} new links`);
    } catch {
      // Tab click failed — skip
    }
  }

  // Also try accordion/collapse items
  const accordions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[class*="accordion-button"], details > summary, [data-toggle="collapse"]'))
      .map(el => (el.textContent || '').trim())
      .filter(t => t.length > 0 && t.length < 50)
      .slice(0, 5)
  ).catch(() => []) as string[];

  for (const acc of accordions) {
    try {
      await page.locator(`text="${acc}"`).first().click({ timeout: 3000 });
      await sleep(400);
      const newLinks = await discoverLinks(page, pageUrl, allowedDomains, excludedUrls);
      for (const link of newLinks) state.addUrl(link, depth + 1, false, 'llm');
    } catch { /* skip */ }
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function capturePage(
  page: Page,
  url: string,
  title: string,
  sessionId: string,
  pageCaptureId: string | undefined,
  screenshotsDir: string,
  htmlDir: string,
  pagesDir: string,
  apiDir: string,
  harDir: string,
  project: Project,
  networkRecorder: ReturnType<typeof createNetworkRecorder> | null,
  _state: SharedCrawlState,
): Promise<void> {
  let screenshotPath: string | undefined;
  if (project.screenshotEnabled) {
    const absShot = path.join(screenshotsDir, urlToFilename(url, '.png'));
    await hideLiveLogOverlay(page);
    await page.screenshot({ path: absShot, fullPage: true, timeout: 20_000 }).catch(() => undefined);
    await showLiveLogOverlay(page);
    screenshotPath = path.relative(outputAbsDir, absShot).replace(/\\/g, '/');
  }

  const html = await page.content().catch(() => '');
  writeText(path.join(htmlDir, urlToFilename(url, '.html')), html);
  const extractedData = await extractPageData(page, url, []).catch(() => null);
  if (extractedData) writeJson(path.join(pagesDir, urlToFilename(url, '.json')), extractedData);
  const visibleText = await page.evaluate(() => document.body?.innerText?.slice(0, 10000) ?? '').catch(() => '');

  if (pageCaptureId) {
    await prisma.pageCapture.update({
      where: { id: pageCaptureId },
      data: {
        title, html: html.slice(0, 500_000),
        visibleText: visibleText.slice(0, 20_000),
        breadcrumbs: JSON.stringify(extractedData?.breadcrumbs ?? []),
        screenshotPath: screenshotPath ?? null,
        fullScreenshotPath: screenshotPath ?? null,
        extractedData: extractedData ? JSON.stringify(extractedData) : null,
      },
    }).catch(() => undefined);
  }

  await networkRecorder?.flush();
  const calls = networkRecorder?.getCalls() ?? [];
  if (networkRecorder) {
    writeJson(path.join(apiDir, urlToFilename(url, '-api.json')), calls);
    writeJson(path.join(harDir, urlToFilename(url, '.har')), networkRecorder.getHar(url));
  }
  if (calls.length > 0 && pageCaptureId) {
    await prisma.networkCall.createMany({
      data: calls.map(c => ({
        crawlSessionId: sessionId, pageCaptureId,
        method: c.method, url: c.url,
        queryParams: JSON.stringify(c.queryParams),
        requestPayload: c.requestPayload, requestContentType: c.requestContentType,
        responseStatus: c.responseStatus, responseBody: c.responseBody,
        responseContentType: c.responseContentType,
        responseSchemaKeys: c.responseSchemaKeys ? JSON.stringify(c.responseSchemaKeys) : null,
        requestHeaders: c.requestHeaders, responseHeaders: c.responseHeaders,
        timingMs: c.timingMs, resourceType: c.resourceType,
        isGraphQL: c.isGraphQL, graphQLOperationName: c.graphQLOperationName,
      })),
    }).catch(() => undefined);
  }
}

async function expandNavDropdowns(page: Page): Promise<void> {
  await page.evaluate(() => {
    const toggles = Array.from(document.querySelectorAll(
      '[data-toggle="dropdown"], [data-bs-toggle="dropdown"], .dropdown-toggle, ' +
      '.nav-link.dropdown-toggle, [aria-haspopup="menu"], [aria-haspopup="true"]',
    )).slice(0, 16) as HTMLElement[];
    for (const el of toggles) {
      try {
        el.click();
      } catch { /* ignore */ }
    }
  }).catch(() => undefined);
  await sleep(500);
}

async function enqueueDiscoveredLinks(
  page: Page,
  currentUrl: string,
  depth: number,
  state: SharedCrawlState,
  allowedDomains: string[],
  excludedUrls: string[],
  addedBy: 'bfs' | 'llm',
): Promise<number> {
  const links = await discoverLinks(page, currentUrl, allowedDomains, excludedUrls);
  let added = 0;
  for (const link of links) {
    if (state.addUrl(link, Math.min(depth + 1, 50), false, addedBy)) added += 1;
  }
  if (added > 0) {
    logger.info(`[${addedBy.toUpperCase()}] Discovered +${added} URL(s) from ${currentUrl.slice(0, 80)} (queue ${state.urlQueue.length})`);
  }
  return added;
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
      const push = (raw: string | null | undefined) => {
        if (!raw) return;
        const h = raw.trim();
        if (!h || h === '#' || /^javascript:/i.test(h)) return;
        if (seen.has(h)) return;
        seen.add(h);
        results.push(h);
      };

      document.querySelectorAll('a[href]').forEach((el) => {
        const a = el as HTMLAnchorElement;
        const text = (a.textContent || a.getAttribute('aria-label') || a.title || '').trim();
        if (/log[\s_-]*out|sign[\s_-]*out|signout|sign[\s_-]*off|log[\s_-]*off/i.test(text)) return;
        // Prefer absolute href (preserves #/spa routes)
        push(a.href || a.getAttribute('href'));
      });

      document.querySelectorAll(
        'nav a[href], [class*="sidebar"] a[href], [class*="menu"] a[href], [class*="nav"] a[href], ' +
        '.dropdown-menu a[href], .dropdown-item[href], a.dropdown-item, ' +
        '[routerlink], [ng-reflect-router-link]',
      ).forEach((el) => {
        const a = el as HTMLAnchorElement;
        push(a.href || el.getAttribute('href') || el.getAttribute('routerLink') || el.getAttribute('ng-reflect-router-link'));
      });

      document.querySelectorAll('[data-href],[data-url],[data-route],[data-link]').forEach((el) => {
        push(
          el.getAttribute('data-href')
          || el.getAttribute('data-url')
          || el.getAttribute('data-route')
          || el.getAttribute('data-link'),
        );
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
      } catch { /* invalid */ }
    }
    return [...new Set(result)];
  } catch {
    return [];
  }
}

// Cache the browser script content
let _browserScript: string | null = null;
function getBrowserScript(): string {
  if (!_browserScript) {
    const scriptPath = path.join(__dirname, '../extractor/browser-extract.js');
    _browserScript = fs.readFileSync(scriptPath, 'utf-8');
  }
  return _browserScript;
}
