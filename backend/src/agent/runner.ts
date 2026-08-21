import { BrowserContext, chromium, type Page } from 'playwright';
import path from 'path';
import { prisma } from '../database/client';
import { createLLMClient, isLLMConfigured, type LLMConfig } from '../ai/llm';
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
import { isUrlSafe } from '../crawler/safety';
import { browserClosedMessage, isBrowserClosedError } from '../crawler/browser-closed';
import { sessionExists, getSessionPath, waitForLoginAndSaveSession } from '../crawler/session';
import { attachLiveLogOverlay, hideLiveLogOverlay, showLiveLogOverlay, isLiveLogOverlayPage, type LogOverlayHandle } from '../crawler/log-overlay';
import { installSessionEndGuard } from '../crawler/session-end-guard';
import { crawlAbortRegistry } from '../crawler/crawl-abort';
import { installNewPageFollower, waitForPageSettled } from '../crawler/new-page-follower';
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
const outputAbsDir = path.resolve(config.outputDir);

function looksLikeAuthPage(url: string, pageType?: string, title?: string): boolean {
  if (pageType === 'login') return true;
  const blob = `${url} ${title ?? ''}`.toLowerCase();
  return /\/login|signin|sign-in|forgot.?password|reset.?password|\/auth\b|log\s*in/.test(blob);
}

async function recoverToAuthenticatedUrl(page: Page, safeUrl: string, reason: string): Promise<void> {
  logger.warn(`[Agent] Session/auth recovery — ${reason}. Returning to ${safeUrl}`);
  await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch((err) => {
    if (isBrowserClosedError(err)) throw new Error(browserClosedMessage(err));
  });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await sleep(400);
}

/** GPT-5-class models spend completion budget on hidden reasoning — keep headroom for JSON. */
const NAVIGATOR_MAX_TOKENS = 4_096;
const VALIDATOR_MAX_TOKENS = 2_048;

/** When the LLM returns empty JSON, keep exploring via the first safe unvisited control. */
function pickHeuristicAction(pageState: import('./types').PageState): AgentAction | null {
  const preferred = pageState.interactiveElements.find(
    (e) =>
      e.isSafe
      && (e.isNavigation
        || e.actionKind === 'navigation'
        || e.actionKind === 'modal'
        || e.actionKind === 'toggle'
        || e.tag === 'a'),
  );
  const el = preferred ?? pageState.interactiveElements.find((e) => e.isSafe);
  if (!el) return null;
  return {
    type: 'click',
    elementIndex: el.index,
    reason: `Heuristic fallback: explore "${el.text}" after navigator LLM failure`,
    confidence: 0.35,
  };
}

/**
 * Never use raw history.back() after login — history often points at the login page.
 * Prefer staying put on failed actions; only navigate back to the post-login start URL.
 *
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
  const memory: AgentMemory = createEmptyAgentMemory([
    `Explore all modules in ${project.name}`,
    'Document all forms and tables',
    'Discover workflows',
  ]);

  let browser = existingContext?.browser ?? null;
  let context: BrowserContext | null = existingContext?.context ?? null;
  let agentStartUrl = project.baseUrl; // updated below after login
  let logOverlay: LogOverlayHandle | null = null;
  let headed = false;
  let networkRecorder: ReturnType<typeof createNetworkRecorder> | null = null;
  let newPageFollower: ReturnType<typeof installNewPageFollower> | null = null;

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

    const pageRecorders = new WeakMap<Page, ReturnType<typeof createNetworkRecorder> | null>();

    const attachAgentRecorder = (target: typeof page) => {
      if (pageRecorders.has(target)) return pageRecorders.get(target) ?? null;
      const recorder = project.networkCaptureEnabled ? createNetworkRecorder(target) : null;
      pageRecorders.set(target, recorder);
      return recorder;
    };

    const bindAgentPage = (next: typeof page) => {
      newPageFollower?.claimPage(next);
      if (next === page) return;
      page = next;
      networkRecorder = attachAgentRecorder(page);
    };

    newPageFollower = installNewPageFollower(context, {
      onPageCreated: (opened) => {
        attachAgentRecorder(opened);
      },
      onNewPage: (_opened, openedUrl) => {
        emitCrawlLog(session.id, 'info', `Followed new tab/window: ${openedUrl}`);
      },
    });

    if (headed) {
      logOverlay = attachLiveLogOverlay(context, session.id);
      emitCrawlLog(session.id, 'info', 'Live crawl log overlay attached to browser window');
    }

    // Persistent recorder so page-load traffic is included in HAR / API capture
    networkRecorder = attachAgentRecorder(page);
    newPageFollower.claimPage(page);

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
        const pending = newPageFollower?.takePending();
        if (pending && !pending.isClosed()) {
          bindAgentPage(pending);
        } else {
          throw new Error(browserClosedMessage());
        }
      }

      const pendingTab = newPageFollower?.takePending();
      if (pendingTab && !pendingTab.isClosed() && pendingTab !== page) {
        bindAgentPage(pendingTab);
        await waitForPageSettled(pendingTab);
        await pendingTab.bringToFront().catch(() => undefined);
        logger.info(`[Agent] Switched to new tab/window: ${page.url()}`);
      }

      const currentUrl = page.url();

      if (!isUrlSafe(currentUrl, allowedDomains, excludedUrls)) {
        logger.warn(`[Agent] Unsafe URL, navigating back: ${currentUrl}`);
        if (page.isClosed() || !context?.browser()?.isConnected()) {
          throw new Error(browserClosedMessage());
        }
        await recoverToAuthenticatedUrl(page, agentStartUrl, 'unsafe URL');
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

      // Accidental navigation to login/forgot-password after a failed click+goBack, etc.
      if (
        looksLikeAuthPage(pageState.url, pageState.pageType, pageState.title)
        && !looksLikeAuthPage(agentStartUrl)
      ) {
        await recoverToAuthenticatedUrl(page, agentStartUrl, `landed on auth page (${pageState.title})`);
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
            buildPlannerMessages(project.name, visitedPageMeta, [...memory.visitedFeatures], memory),
            { maxTokens: 1500 },
          );
          memory.explorationGoals = plan.explorationGoals?.length
            ? plan.explorationGoals
            : memory.explorationGoals;
          memory.activeInstructions = [
            ...memory.explorationGoals.slice(0, 5),
            ...(plan.recommendation ? [`Planner: ${plan.recommendation}`] : []),
            ...memory.activeInstructions.filter((i) => i.startsWith('Continue:') || i.startsWith('Avoid re-doing:')).slice(0, 8),
          ];
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
        // Text-first: vision + reasoning models often burn the whole token budget with empty JSON.
        let rawAction: AgentAction;
        try {
          rawAction = await llm.chatJson<AgentAction>(
            buildNavigatorMessages(pageState, memory, project.name),
            { maxTokens: NAVIGATOR_MAX_TOKENS },
          );
        } catch (textErr) {
          const vision = await captureNavigatorVision(page, pageState);
          if (!vision) throw textErr;
          logger.warn(
            `[Navigator] Text LLM failed, retrying with vision: ${textErr instanceof Error ? textErr.message : String(textErr)}`,
          );
          logger.debug(`[Navigator] Vision attached (${vision.labeledCount} labeled elements)`);
          rawAction = await llm.chatJson<AgentAction>(
            buildNavigatorMessages(pageState, memory, project.name, vision.dataUrl),
            { maxTokens: NAVIGATOR_MAX_TOKENS },
          );
        }
        action = validateAction(rawAction, pageState);
      } catch (err) {
        logger.warn(`[Navigator] LLM failed: ${err instanceof Error ? err.message : String(err)}`);
        const fallback = pickHeuristicAction(pageState);
        if (fallback) {
          logger.info(`[Navigator] Using heuristic fallback → click [${fallback.elementIndex}] ${fallback.reason}`);
          action = fallback;
        } else {
          action = { type: 'done', reason: 'LLM failed', confidence: 1 };
        }
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

      // If done, try another area — do NOT bounce to MainDashboard (that stalls exploration).
      if (action.type === 'done') {
        consecutiveDones++;
        if (consecutiveDones >= 3) {
          const unvisitedNav = pageState.navigationItems.find(
            (n) => !memory.visitedFeatures.has(n) && !/^production$/i.test(n.trim()),
          ) ?? pageState.navigationItems.find((n) => !memory.visitedFeatures.has(n));
          if (unvisitedNav) {
            logger.info(`[Agent] 3x done — clicking unvisited nav item: ${unvisitedNav}`);
            const clicked = await page
              .locator(`a:visible, button:visible, [role="link"]:visible, [role="menuitem"]:visible`, {
                hasText: unvisitedNav,
              })
              .first()
              .click({ timeout: 8_000 })
              .then(() => true)
              .catch(() => false);
            if (clicked) {
              await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
              consecutiveDones = 0;
              memory.visitedFeatures.add(unvisitedNav);
            } else {
              const fallback = pickHeuristicAction(pageState);
              if (fallback) {
                action = fallback;
                consecutiveDones = 0;
              } else {
                logger.info('[Agent] No more unvisited navigation. Ending agent crawl.');
                break;
              }
            }
          } else {
            logger.info('[Agent] All navigation explored. Ending agent crawl.');
            break;
          }
          if (action.type === 'done') {
            continue;
          }
        } else {
          const fallback = pickHeuristicAction(pageState);
          if (fallback) {
            logger.info(`[Agent] Soft-done — trying heuristic click [${fallback.elementIndex}]`);
            action = fallback;
          } else {
            await sleep(500);
            continue;
          }
        }
      }

      if (action.type === 'done') {
        continue;
      }

      consecutiveDones = 0;

      // ── ACTION: execute the chosen action ─────────────────────────────────
      const result = await executeAction(page, action, pageState);
      if (result.page && result.page !== page) {
        bindAgentPage(result.page);
      } else {
        const extraTab = newPageFollower?.takePending();
        if (extraTab && extraTab !== page && !extraTab.isClosed()) {
          bindAgentPage(extraTab);
        }
      }
      if (action.type === 'click') {
        const el = pageState.interactiveElements.find((item) => item.index === action.elementIndex);
        if (el) visitedActionKeys.add(el.actionKey ?? `${el.actionKind}:${el.text.toLowerCase()}`);
      }
      steps[steps.length - 1].resultUrl = result.newUrl;

      const clickLabel = (() => {
        if (action.type !== 'click' || action.elementIndex === undefined) return describeAction(action);
        const el = pageState.interactiveElements.find((item) => item.index === action.elementIndex);
        return el ? `click [${el.index}] "${el.text}"` : describeAction(action);
      })();

      let outcomeNote = result.success ? undefined : (result.error ?? 'action failed');

      // Tab closed by a bad click (e.g. window.close) — recover if browser still alive
      if (page.isClosed() && context?.browser()?.isConnected()) {
        const ctx = context;
        const survivor =
          ctx.pages().find((p) => !p.isClosed() && !isLiveLogOverlayPage(p))
          ?? await (newPageFollower
            ? newPageFollower.runWithoutFollowing(() => ctx.newPage())
            : ctx.newPage());
        bindAgentPage(survivor);
        appendInteraction(memory, {
          url: currentUrl,
          title: pageState.title,
          pageType: pageState.pageType,
          actionType: action.type,
          actionDetail: clickLabel,
          reason: action.reason,
          resultUrl: result.newUrl,
          outcome: 'active tab closed — recovered',
        });
        await maybeCreateRollingSummary(llm, memory, project.name);
        await recoverToAuthenticatedUrl(survivor, agentStartUrl, 'active tab closed after action');
        await sleep(500);
        continue;
      }

      if (!result.success) {
        logger.warn(`[ActionBuilder] Failed: ${result.error}`);
        if (result.error && isBrowserClosedError(result.error)) {
          throw new Error(browserClosedMessage(result.error));
        }
        if (page.isClosed() || !context?.browser()?.isConnected()) {
          throw new Error(browserClosedMessage());
        }
        // Do NOT history.back() — that often returns to the pre-login page and looks like a logout.
        if (looksLikeAuthPage(page.url())) {
          await recoverToAuthenticatedUrl(page, agentStartUrl, 'failed action left auth page');
        }
        await sleep(500);
      } else {
        const afterState = await observePage(page).catch(() => null);
        if (afterState) {
          try {
            const validatorVision = await captureNavigatorVision(page, afterState);
            const validation = await llm.chatJson<ValidatorOutput>(
              buildValidatorMessages(project.name, pageState, afterState, action, validatorVision?.dataUrl),
              { maxTokens: VALIDATOR_MAX_TOKENS },
            );
            logger.info(`[Validator] ${validation.success ? 'ok' : 'issue'} | newInfo=${validation.newInfoFound} | ${validation.observation}`);
            steps[steps.length - 1].notes = validation.observation;
            outcomeNote = validation.observation;

            if (validation.shouldBacktrack) {
              logger.info(`[Validator] Backtracking: ${validation.retryReason || validation.observation}`);
              await recoverToAuthenticatedUrl(
                page,
                agentStartUrl,
                'validator requested backtrack (avoid history.back to login)',
              );
            } else if (looksLikeAuthPage(afterState.url, afterState.pageType, afterState.title)) {
              await recoverToAuthenticatedUrl(page, agentStartUrl, 'action landed on auth page');
            }
          } catch (err) {
            logger.warn(`[Validator] Failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      appendInteraction(memory, {
        url: currentUrl,
        title: pageState.title,
        pageType: pageState.pageType,
        actionType: action.type,
        actionDetail: clickLabel,
        reason: action.reason,
        resultUrl: page.isClosed() ? result.newUrl : page.url(),
        outcome: outcomeNote,
      });
      await maybeCreateRollingSummary(llm, memory, project.name);

      await sleep(800); // polite delay between actions
    }

    // Save agent execution trace + rolling context under project-output/<slug>/<session>/analysis/
    writeJson(path.join(getAnalysisDir(projectSlug, session.id), 'agent-trace.json'), steps);
    writeJson(path.join(getAnalysisDir(projectSlug, session.id), 'rolling-context.json'), rollingContextSnapshot(memory));

    await prisma.crawlSession.update({
      where: { id: session.id },
      data: {
        status: abortSignal?.aborted ? 'stopped' : 'completed',
        finishedAt: new Date(),
        pagesCount: memory.visitedUrls.size,
        errorMessage: abortSignal?.aborted ? 'Stopped by user' : null,
      },
    }).catch(() => undefined);

    logger.info(`[Agent] Crawl complete. ${memory.visitedUrls.size} pages, ${steps.length} steps, ${plannerCallCount} planner calls, interactions: ${memory.interactionHistory.length}, summaries: ${memory.rollingSummaries.length}.`);
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
    newPageFollower?.dispose();
    logOverlay?.dispose();
    if (!existingContext || abortSignal?.aborted) {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }
}
