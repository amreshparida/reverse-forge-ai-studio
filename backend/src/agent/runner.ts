import { BrowserContext, chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { prisma } from '../database/client';
import { createLLMClient, isLLMConfigured, type LLMConfig } from '../ai/llm';
import { observePage } from './observer';
import { executeAction } from './action-builder';
import { buildNavigatorMessages, buildPlannerMessages, buildValidatorMessages, validateAction, type PlannerOutput, type ValidatorOutput } from './navigator';
import { captureNavigatorVision } from './vision';
import { extractPageData } from '../extractor';
import { createNetworkRecorder } from '../recorder';
import {
  getScreenshotsDir,
  getHtmlDir,
  getPagesDir,
  getApiDir,
  getHarDir,
  writeJson,
  writeText,
  urlToFilename,
} from '../utils/file-system';
import { sleep } from '../utils/retry';
import { logger } from '../utils/logger';
import { isUrlSafe } from '../crawler/safety';
import { browserClosedMessage, isBrowserClosedError } from '../crawler/browser-closed';
import { sessionExists, getSessionPath, waitForLoginAndSaveSession } from '../crawler/session';
import { attachLiveLogOverlay, hideLiveLogOverlay, showLiveLogOverlay, isLiveLogOverlayPage, type LogOverlayHandle } from '../crawler/log-overlay';
import { installSessionEndGuard } from '../crawler/session-end-guard';
import { crawlAbortRegistry } from '../crawler/crawl-abort';
import { emitCrawlLog } from '../crawler/live-log';
import { config } from '../config';
import type { Project, CrawlSession } from '@prisma/client';
import type { AgentAction, AgentMemory, AgentStep } from './types';

export interface AgentCrawlOptions {
  project: Project;
  session: CrawlSession;
  projectSlug: string;
  llmConfig: LLMConfig;
  maxSteps?: number;
  onProgress?: (info: { step: number; url: string; action: string }) => void;
  existingContext?: { browser: import('playwright').Browser; context: BrowserContext };
  abortSignal?: AbortSignal;
}

/** Absolute output dir for resolving screenshot paths */
const outputAbsDir = path.resolve(process.cwd(), process.env['OUTPUT_DIR'] ?? './project-output');

/**
 * Agentic crawl loop:
 * Planner → Navigator → observe DOM → LLM selects action JSON → ActionBuilder executes → repeat
 */
export async function runAgentCrawl(options: AgentCrawlOptions): Promise<void> {
  const {
    project,
    session,
    projectSlug,
    llmConfig,
    maxSteps = config.crawler.agentMaxSteps,
    onProgress,
    existingContext,
    abortSignal,
  } = options;

  if (!isLLMConfigured(llmConfig)) {
    throw new Error('Agent crawl requires LLM configuration (LLM_API_KEY must be set)');
  }

  const allowedDomains: string[] = JSON.parse(project.allowedDomains || '[]') as string[];
  const excludedUrls: string[] = JSON.parse(project.excludedUrls || '[]') as string[];

  try {
    const baseHostname = new URL(project.baseUrl).hostname;
    if (allowedDomains.length === 0) allowedDomains.push(baseHostname);
  } catch { /* ignore */ }

  const llm = createLLMClient(llmConfig);
  const memory: AgentMemory = {
    visitedUrls: new Set(),
    visitedFeatures: new Set(),
    discoveredEntities: [],
    explorationGoals: [`Explore all modules in ${project.name}`, 'Document all forms and tables', 'Discover workflows'],
    currentDepth: 0,
  };

  let browser = existingContext?.browser ?? null;
  let context: BrowserContext | null = existingContext?.context ?? null;
  let agentStartUrl = project.baseUrl; // updated below after login
  let logOverlay: LogOverlayHandle | null = null;
  let headed = false;
  let networkRecorder: ReturnType<typeof createNetworkRecorder> | null = null;

  const steps: AgentStep[] = [];
  const visitedPageMeta: Array<{ url: string; title: string; pageType: string }> = [];
  const visitedActionKeys = new Set<string>();

  try {
    // ── Login if required (same flow as BFS crawler) ─────────────────────
    if (project.loginRequired && !context) {
      await prisma.crawlSession.update({
        where: { id: session.id },
        data: { status: 'awaiting_login', errorMessage: 'Browser opened — please log in to continue.' },
      }).catch(() => undefined);

      const loginUrl = project.loginUrl || project.baseUrl;
      const liveSession = await waitForLoginAndSaveSession(loginUrl, projectSlug, (msg) => {
        logger.info(msg);
        onProgress?.({ step: 0, url: loginUrl, action: msg });
      });

      browser = liveSession.browser;
      context = liveSession.context;
      headed = true;
      agentStartUrl = liveSession.postLoginUrl; // start from exact post-login URL
      logger.info(`[Agent] Starting from post-login URL: ${agentStartUrl}`);

      await prisma.crawlSession.update({
        where: { id: session.id },
        data: { status: 'running', errorMessage: null },
      }).catch(() => undefined);
    }

    // ── Launch fresh browser if no context yet ────────────────────────────
    if (!context) {
      const headless = process.env['CRAWL_HEADLESS'] !== 'false';
      headed = !headless;
      browser = await chromium.launch({ headless, slowMo: headless ? 0 : 200 });

      const contextOptions: Record<string, unknown> = {};
      if (sessionExists(projectSlug)) {
        contextOptions['storageState'] = getSessionPath(projectSlug);
        logger.info('[Agent] Loaded saved session');
      }

      context = await browser.newContext({
        ...contextOptions,
        viewport: { width: 1440, height: 900 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      // Block all form submissions — read-only guarantee
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
    const harDir = getHarDir(projectSlug, session.id);

    // Start from post-login URL (if loginRequired) or baseUrl
    // For login sessions: reuse the existing post-login page; for fresh: navigate
    const existingPage = context.pages().filter((p) => !p.isClosed() && !isLiveLogOverlayPage(p)).slice(-1)[0];
    let page = existingPage ?? await context.newPage();

    await installSessionEndGuard(context);

    if (headed) {
      logOverlay = attachLiveLogOverlay(context, session.id);
      emitCrawlLog(session.id, 'info', 'Live crawl log overlay attached to browser window');
    }

    // Persistent recorder so page-load traffic is included in HAR / API capture
    networkRecorder = project.networkCaptureEnabled ? createNetworkRecorder(page) : null;

    const alreadyOnStartUrl = page.url() === agentStartUrl || page.url().startsWith(agentStartUrl.split('?')[0] ?? '');
    if (!alreadyOnStartUrl) {
      await networkRecorder?.reset();
      await page.goto(agentStartUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    } else {
      logger.info(`[Agent] Already on start URL: ${agentStartUrl}`);
    }
    await sleep(1000);

    let consecutiveDones = 0;
    let plannerCallCount = 0;

    for (let step = 0; step < maxSteps; step++) {
      if (abortSignal?.aborted) {
        logger.info('[Agent] Crawl aborted by stop signal');
        break;
      }

      if (page.isClosed() || !context?.browser()?.isConnected()) {
        throw new Error(browserClosedMessage());
      }

      const currentUrl = page.url();

      if (!isUrlSafe(currentUrl, allowedDomains, excludedUrls)) {
        logger.warn(`[Agent] Unsafe URL, navigating back: ${currentUrl}`);
        if (page.isClosed() || !context?.browser()?.isConnected()) {
          throw new Error(browserClosedMessage());
        }
        await page.goto(project.baseUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch((err) => {
          if (isBrowserClosedError(err)) throw new Error(browserClosedMessage(err));
        });
        continue;
      }

      // ── OBSERVE: capture page state ──────────────────────────────────────
      const pageState = await observePage(page).catch((err) => {
        if (isBrowserClosedError(err) || page.isClosed()) {
          throw new Error(browserClosedMessage(err));
        }
        return null;
      });
      if (!pageState) {
        logger.warn(`[Agent] Failed to observe page ${currentUrl}, skipping`);
        continue;
      }
      pageState.interactiveElements = pageState.interactiveElements.filter((el) => {
        const key = el.actionKey ?? `${el.actionKind}:${el.text.toLowerCase()}`;
        return !visitedActionKeys.has(key);
      });

      const isNewUrl = !memory.visitedUrls.has(pageState.url);
      memory.visitedUrls.add(pageState.url);

      onProgress?.({ step, url: currentUrl, action: 'observing' });
      logger.info(`[Agent] Step ${step + 1}/${maxSteps} | ${pageState.pageType} | ${pageState.title}`);

      // Capture page if it's new
      if (isNewUrl) {
        await sleep(200); // brief pause for in-flight network calls to settle

        // Full-page screenshot only (no separate viewport shot)
        let screenshotPath: string | undefined;
        let fullScreenshotPath: string | undefined;
        if (project.screenshotEnabled) {
          const fname = urlToFilename(currentUrl, '.png');
          const absShot = path.join(screenshotsDir, fname);

          await hideLiveLogOverlay(page);
          await page.screenshot({ path: absShot, fullPage: true, timeout: 15_000 }).catch(() => undefined);
          await showLiveLogOverlay(page);

          const rel = path.relative(outputAbsDir, absShot).replace(/\\/g, '/');
          screenshotPath = rel;
          fullScreenshotPath = rel;
        }

        // HTML + extraction
        const html = await page.content().catch(() => '');
        writeText(path.join(htmlDir, urlToFilename(currentUrl, '.html')), html);

        const extractedData = await extractPageData(page, currentUrl, []).catch(() => null);
        if (extractedData) {
          writeJson(path.join(pagesDir, urlToFilename(currentUrl, '.json')), extractedData);
        }

        const visibleText = await page.evaluate(() => document.body.innerText.slice(0, 10000)).catch(() => '');

        // Persist
        const dbPage = await prisma.pageCapture.create({
          data: {
            crawlSessionId: session.id,
            url: currentUrl,
            title: pageState.title,
            depth: memory.currentDepth,
            html: html.slice(0, 500_000),
            visibleText: visibleText.slice(0, 20_000),
            breadcrumbs: JSON.stringify(pageState.breadcrumbs),
            screenshotPath: screenshotPath ?? null,
            fullScreenshotPath: fullScreenshotPath ?? null,
            extractedData: extractedData ? JSON.stringify(extractedData) : null,
          },
        });

        // Save network calls + HAR (same recorder window as page activity)
        if (project.networkCaptureEnabled && networkRecorder) {
          await networkRecorder.flush();
          const calls = networkRecorder.getCalls();
          writeJson(path.join(apiDir, urlToFilename(currentUrl, '-api.json')), calls);
          writeJson(path.join(harDir, urlToFilename(currentUrl, '.har')), networkRecorder.getHar(currentUrl));
          if (calls.length > 0) {
            await prisma.networkCall.createMany({
              data: calls.map((c) => ({
                crawlSessionId: session.id,
                pageCaptureId: dbPage.id,
                method: c.method,
                url: c.url,
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
            });
          }
          await networkRecorder.reset();
        }

        visitedPageMeta.push({ url: currentUrl, title: pageState.title, pageType: pageState.pageType });
        await prisma.crawlSession.update({
          where: { id: session.id },
          data: { pagesCount: memory.visitedUrls.size },
        }).catch(() => undefined);

        memory.visitedFeatures.add(`${pageState.pageType}: ${pageState.title}`);
      }

      // ── PLAN: every 15 steps, re-evaluate goals ──────────────────────────
      if (step % 15 === 0 && step > 0 && visitedPageMeta.length >= 3) {
        plannerCallCount++;
        try {
          const plan = await llm.chatJson<PlannerOutput>(
            buildPlannerMessages(project.name, visitedPageMeta, [...memory.visitedFeatures]),
            { maxTokens: 1500 },
          );
          memory.explorationGoals = plan.explorationGoals ?? memory.explorationGoals;
          logger.info(`[Planner] Coverage ~${(plan.coverageEstimate * 100).toFixed(0)}% | Missing: ${plan.missingModules.join(', ')}`);

          // If planner says coverage > 90%, we can stop
          if (plan.coverageEstimate >= 0.9) {
            logger.info('[Agent] Planner estimates >90% coverage. Stopping.');
            break;
          }

          // Navigate to planner's suggested priority if it's new
          if (plan.nextPriorityUrl && plan.nextPriorityUrl.startsWith('http') && !memory.visitedUrls.has(plan.nextPriorityUrl)) {
            logger.info(`[Planner] Redirecting to priority: ${plan.nextPriorityUrl}`);
            await page.goto(plan.nextPriorityUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
            await sleep(800);
            continue;
          }
        } catch (err) {
          logger.warn('[Planner] Failed: ' + (err instanceof Error ? err.message : String(err)));
        }
      }

      // ── NAVIGATE: LLM decides next action ─────────────────────────────────
      let action: AgentAction;
      try {
        const vision = await captureNavigatorVision(page, pageState);
        if (vision) {
          logger.debug(`[Navigator] Vision attached (${vision.labeledCount} labeled elements)`);
        }

        let rawAction: AgentAction;
        try {
          rawAction = await llm.chatJson<AgentAction>(
            buildNavigatorMessages(pageState, memory, project.name, vision?.dataUrl),
            { maxTokens: 500 },
          );
        } catch (visionErr) {
          if (!vision) throw visionErr;
          logger.warn(`[Navigator] Vision LLM failed, retrying text-only: ${visionErr instanceof Error ? visionErr.message : String(visionErr)}`);
          rawAction = await llm.chatJson<AgentAction>(
            buildNavigatorMessages(pageState, memory, project.name),
            { maxTokens: 500 },
          );
        }
        action = validateAction(rawAction, pageState);
      } catch (err) {
        logger.warn(`[Navigator] LLM failed: ${err instanceof Error ? err.message : String(err)}`);
        action = { type: 'done', reason: 'LLM failed', confidence: 1 };
      }

      logger.info(`[Navigator] Action: ${action.type}${action.elementIndex !== undefined ? ` [${action.elementIndex}]` : ''}${action.url ? ` → ${action.url}` : ''} | ${action.reason}`);

      steps.push({
        stepNumber: step,
        url: currentUrl,
        pageTitle: pageState.title,
        action,
        resultUrl: currentUrl,
        timestamp: new Date(),
      });

      // If done, go back or try a new area
      if (action.type === 'done') {
        consecutiveDones++;
        if (consecutiveDones >= 3) {
          // Try to navigate to an unvisited navigation item
          const unvisitedNav = pageState.navigationItems.find(
            (n) => !memory.visitedFeatures.has(n),
          );
          if (unvisitedNav) {
            logger.info(`[Agent] 3x done — trying unvisited nav item: ${unvisitedNav}`);
            const navLink = await page
              .locator(`text="${unvisitedNav}"`)
              .first()
              .getAttribute('href')
              .catch(() => null);
            if (navLink) {
              await page.goto(navLink, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
              consecutiveDones = 0;
            } else {
              logger.info('[Agent] No more unvisited navigation. Ending agent crawl.');
              break;
            }
          } else {
            logger.info('[Agent] All navigation explored. Ending agent crawl.');
            break;
          }
        } else {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(async () => {
            await page.goto(project.baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
          });
          await sleep(500);
        }
        continue;
      }

      consecutiveDones = 0;

      // ── ACTION: execute the chosen action ─────────────────────────────────
      const result = await executeAction(page, action, pageState);
      if (result.page) {
        page = result.page;
      }
      if (action.type === 'click') {
        const el = pageState.interactiveElements.find((item) => item.index === action.elementIndex);
        if (el) visitedActionKeys.add(el.actionKey ?? `${el.actionKind}:${el.text.toLowerCase()}`);
      }
      steps[steps.length - 1].resultUrl = result.newUrl;

      if (!result.success) {
        logger.warn(`[ActionBuilder] Failed: ${result.error}`);
        if (result.error && isBrowserClosedError(result.error)) {
          throw new Error(browserClosedMessage(result.error));
        }
        if (page.isClosed() || !context?.browser()?.isConnected()) {
          throw new Error(browserClosedMessage());
        }
        await page.goBack({ timeout: 8_000 }).catch((err) => {
          if (isBrowserClosedError(err)) throw new Error(browserClosedMessage(err));
        });
        await sleep(500);
      } else {
        const afterState = await observePage(page).catch(() => null);
        if (afterState) {
          try {
            const validatorVision = await captureNavigatorVision(page, afterState);
            const validation = await llm.chatJson<ValidatorOutput>(
              buildValidatorMessages(project.name, pageState, afterState, action, validatorVision?.dataUrl),
              { maxTokens: 500 },
            );
            logger.info(`[Validator] ${validation.success ? 'ok' : 'issue'} | newInfo=${validation.newInfoFound} | ${validation.observation}`);
            steps[steps.length - 1].notes = validation.observation;

            if (validation.shouldBacktrack) {
              logger.info(`[Validator] Backtracking: ${validation.retryReason || validation.observation}`);
              await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => undefined);
              await sleep(500);
            }
          } catch (err) {
            logger.warn(`[Validator] Failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      await sleep(800); // polite delay between actions
    }

    // Save agent execution trace
    writeJson(path.join(getAnalysisOutputDir(projectSlug, session.id), 'agent-trace.json'), steps);

    await prisma.crawlSession.update({
      where: { id: session.id },
      data: {
        status: abortSignal?.aborted ? 'stopped' : 'completed',
        finishedAt: new Date(),
        pagesCount: memory.visitedUrls.size,
        errorMessage: abortSignal?.aborted ? 'Stopped by user' : null,
      },
    }).catch(() => undefined);

    logger.info(`[Agent] Crawl complete. ${memory.visitedUrls.size} pages, ${steps.length} steps, ${plannerCallCount} planner calls.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[Agent] Crawl failed: ${msg}`);
    await prisma.crawlSession.updateMany({
      where: { id: session.id, status: { not: 'stopped' } },
      data: { status: 'failed', finishedAt: new Date(), errorMessage: msg },
    }).catch(() => undefined);
    throw err;
  } finally {
    await networkRecorder?.stop();
    logOverlay?.dispose();
    if (!existingContext || abortSignal?.aborted) {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }
}

function getAnalysisOutputDir(projectSlug: string, sessionId: string): string {
  const dir = path.join(process.env['OUTPUT_DIR'] ?? './project-output', projectSlug, sessionId, 'analysis');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
