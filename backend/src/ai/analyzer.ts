import fs from 'fs';
import path from 'path';
import { prisma } from '../database/client';
import { config } from '../config';
import { createLLMClient, isLLMConfigured, type LLMConfig, type LLMMessage } from './llm';
import {
  buildPageAnalysisPrompt,
  buildVisualAnalysisPrompt,
  buildArchitectureInferencePrompt,
  buildKnowledgeGraphPrompt,
} from './prompts';
import { logger } from '../utils/logger';
import { sleep, withRetry, isNetworkError, retryUntilSuccess } from '../utils/retry';
import { writeJson } from '../utils/file-system';
import type { PageExtractedData } from '../extractor';

export interface PageAnalysisResult {
  businessModule: string;
  primaryEntity: string;
  relatedEntities: string[];
  pagePurpose: string;
  userActions: string[];
  formPurpose?: string;
  tablePurpose?: string;
  workflowStage: string;
  possibleRoles: string[];
  businessRules: string[];
  nocobaseCollections: string[];
  nocobaseFields: Array<{
    collection: string;
    field: string;
    type: string;
    options?: string[];
  }>;
  relationships: Array<{
    from: string;
    to: string;
    type: string;
  }>;
  pluginSuggestions: string[];
  confidenceScore: number;
}

export async function analyzeSession(
  sessionId: string,
  llmConfig?: LLMConfig,
  appName?: string,
): Promise<void> {
  if (!isLLMConfigured(llmConfig)) {
    logger.warn('LLM not configured, skipping AI analysis');
    return;
  }

  const llm = createLLMClient(llmConfig);
  const pages = await prisma.pageCapture.findMany({
    where: { crawlSessionId: sessionId },
    orderBy: { createdAt: 'asc' },
  });

  type QueueItem = (typeof pages)[number];
  const queue: QueueItem[] = pages.filter((page) => {
    if (page.aiAnalysis) {
      logger.debug(`Skipping already-analyzed page: ${page.url}`);
      return false;
    }
    if (!page.extractedData) return false;
    return true;
  });

  logger.info(`Analyzing ${queue.length} pages with AI (${pages.length} total)`);

  while (queue.length > 0) {
    const page = queue.shift()!;
    let extractedData: PageExtractedData | null = null;
    try {
      extractedData = JSON.parse(page.extractedData!) as PageExtractedData;
    } catch {
      logger.warn(`Skipping page with invalid extractedData: ${page.url}`);
      continue;
    }

    const prompt = buildPageAnalysisPrompt(
      extractedData,
      page.visibleText ?? '',
      appName,
    );

    try {
      const analysis = await withRetry(
        () =>
          llm.chatJson<PageAnalysisResult>([
            {
              role: 'system',
              content:
                'You are an expert enterprise software analyst specializing in reverse-engineering web applications. Analyze page data and return structured JSON insights.',
            },
            { role: 'user', content: prompt },
          ]),
        {
          maxAttempts: 6,
          delayMs: 2000,
          backoffFactor: 2,
          shouldRetry: isTransientAnalysisError,
        },
        `AI analyze ${page.url}`,
      );

      await prisma.pageCapture.update({
        where: { id: page.id },
        data: { aiAnalysis: JSON.stringify(analysis) },
      });

      logger.info(`AI analyzed: ${page.url} -> ${analysis.businessModule}/${analysis.primaryEntity}`);
      await sleep(1200);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (isTransientAnalysisError(err)) {
        queue.push(page);
        logger.warn(`AI analysis exhausted retries for ${page.url} — re-queued (queue=${queue.length})`, {
          error: errMsg,
        });
        await sleep(3000);
        continue;
      }

      // Non-transient (e.g. bad JSON / invalid response shape) — skip permanently
      logger.error(`AI analysis failed for page ${page.url}`, { error: errMsg });
    }
  }
}

function isTransientAnalysisError(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('connection error') ||
    msg.includes('connection') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up') ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('504')
  );
}

export async function getSessionAnalyses(sessionId: string): Promise<PageAnalysisResult[]> {
  const pages = await prisma.pageCapture.findMany({
    where: { crawlSessionId: sessionId, aiAnalysis: { not: null } },
  });

  return pages
    .map((p) => {
      try {
        return JSON.parse(p.aiAnalysis!) as PageAnalysisResult;
      } catch {
        return null;
      }
    })
    .filter((a): a is PageAnalysisResult => a !== null);
}

// ── Visual analysis ────────────────────────────────────────────────────────

export interface VisualAnalysisResult {
  layoutType: string;
  primaryContent: string;
  keyUIComponents: string[];
  dataDisplayed: string[];
  userActions: string[];
  colorScheme: string;
  navigationVisible: boolean;
  estimatedComplexity: string;
  businessContext: string;
}

/**
 * Sends a page screenshot to a vision-capable LLM (e.g. GPT-4o) for
 * visual layout analysis. Skips pages that have no screenshot file.
 */
export async function analyzeSessionVisually(
  sessionId: string,
  llmConfig?: LLMConfig,
  outputDir?: string,
): Promise<void> {
  if (!isLLMConfigured(llmConfig)) return;

  const llm = createLLMClient(llmConfig);
  const pages = await prisma.pageCapture.findMany({
    where: { crawlSessionId: sessionId, screenshotPath: { not: null } },
    select: { id: true, title: true, url: true, screenshotPath: true },
  });

  logger.info(`Running visual analysis on ${pages.length} pages…`);

  for (const page of pages) {
    if (!page.screenshotPath) continue;

    const absPath = path.resolve(process.cwd(), outputDir ?? '.', page.screenshotPath);
    if (!fs.existsSync(absPath)) continue;

    try {
      const imageBase64 = fs.readFileSync(absPath).toString('base64');

      const messages: LLMMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildVisualAnalysisPrompt(page.title ?? '', page.url) },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}`, detail: 'low' } },
          ] as unknown as string,
        },
      ];

      const result = await llm.chatJson<VisualAnalysisResult>(messages, { maxTokens: 1000 });
      logger.info(`Visual analysis: ${page.url} → ${result.layoutType}/${result.estimatedComplexity}`);

      // Merge visual analysis into existing AI analysis
      const existing = await prisma.pageCapture.findUnique({ where: { id: page.id }, select: { aiAnalysis: true } });
      const currentAnalysis = existing?.aiAnalysis ? JSON.parse(existing.aiAnalysis) as Record<string, unknown> : {};
      await prisma.pageCapture.update({
        where: { id: page.id },
        data: { aiAnalysis: JSON.stringify({ ...currentAnalysis, visualAnalysis: result }) },
      });

      await sleep(1500);
    } catch (err) {
      logger.warn(`Visual analysis failed for ${page.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── Architecture inference ─────────────────────────────────────────────────

export interface ArchitectureAnalysis {
  frontendFramework: string;
  frontendLibraries: string[];
  cssFramework: string;
  backendPattern: string;
  apiBaseUrl: string;
  apiVersion: string;
  authMechanism: string;
  dataFormats: string[];
  paginationStyle: string;
  realtime: string;
  fileUpload: boolean;
  multiTenant: boolean;
  i18n: boolean;
  estimatedScale: string;
  unusualPatterns: string[];
  securityObservations: string[];
  migrationChallenges: string[];
}

export async function inferArchitecture(
  sessionId: string,
  llmConfig?: LLMConfig,
  appName?: string,
  analysisOutputPath?: string,
  sourceSessionIds?: string[],
): Promise<ArchitectureAnalysis | null> {
  if (!isLLMConfigured(llmConfig)) return null;

  const session = await prisma.crawlSession.findUnique({
    where: { id: sessionId },
    select: { projectId: true, project: { select: { slug: true } } },
  });
  if (!session) return null;

  const sessionIds = sourceSessionIds?.length ? sourceSessionIds : [sessionId];

  if (config.llm.synthesisAgentEnabled) {
    return retryUntilSuccess(
      async () => {
        const { materializeEvidenceWorkspace } = await import('./synthesis-workspace.js');
        const { runSynthesisAgent } = await import('./synthesis-agent.js');

        const workspace = await materializeEvidenceWorkspace({
          projectId: session.projectId,
          projectSlug: session.project.slug,
          sessionId,
          sourceSessionIds: sessionIds,
          includeNetworkCalls: true,
        });

        if (analysisOutputPath) {
          for (const name of ['entity-model.json', 'workflow-model.json', 'permission-matrix.json'] as const) {
            const src = path.join(analysisOutputPath, '_generation', name);
            const alt = path.join(analysisOutputPath, name);
            const from = fs.existsSync(src) ? src : fs.existsSync(alt) ? alt : null;
            if (from) {
              fs.copyFileSync(from, path.join(workspace.root, name));
            }
          }
        }

        const { artifact, steps, coverage } = await runSynthesisAgent<ArchitectureAnalysis>({
          workspace,
          task: 'architecture',
          expectedArtifact: 'architecture.json',
          appName,
          llmConfig,
          coverage: { requireAllPages: true, requireAllApis: true },
        });

        if (analysisOutputPath) {
          writeJson(path.join(analysisOutputPath, 'architecture.json'), artifact);
        }
        logger.info(
          `Architecture inference (agent, ${steps} steps): ${artifact.frontendFramework} + ${artifact.backendPattern} (${artifact.authMechanism})`,
          coverage,
        );
        return artifact;
      },
      { label: 'Architecture synthesis agent', delayMs: 15_000, maxDelayMs: 180_000 },
    );
  }

  try {
    const llm = createLLMClient(llmConfig);
    const [pages, networkCalls] = await Promise.all([
      prisma.pageCapture.findMany({
        where: { crawlSessionId: { in: sessionIds } },
        select: { url: true, title: true, aiAnalysis: true },
      }),
      prisma.networkCall.findMany({
        where: { crawlSessionId: { in: sessionIds } },
        select: {
          method: true,
          url: true,
          queryParams: true,
          requestPayload: true,
          requestContentType: true,
          responseStatus: true,
          responseBody: true,
          responseContentType: true,
          responseSchemaKeys: true,
          resourceType: true,
          isGraphQL: true,
          graphQLOperationName: true,
        },
      }),
    ]);

    const pageAnalyses = pages
      .filter((p) => p.aiAnalysis)
      .map((p) => ({ url: p.url, title: p.title, ...JSON.parse(p.aiAnalysis!) as Record<string, unknown> }));

    const result = await retryUntilSuccess(
      () =>
        llm.chatJson<ArchitectureAnalysis>(
          [
            {
              role: 'system',
              content: 'You are a senior software architect. Infer the technical architecture from application evidence.',
            },
            { role: 'user', content: buildArchitectureInferencePrompt(pageAnalyses, networkCalls, appName) },
          ],
          { maxTokens: 3000 },
        ),
      { label: 'Architecture chatJson', delayMs: 10_000, maxDelayMs: 180_000 },
    );

    if (analysisOutputPath) {
      writeJson(path.join(analysisOutputPath, 'architecture.json'), result);
    }

    logger.info(`Architecture inference: ${result.frontendFramework} + ${result.backendPattern} (${result.authMechanism})`);
    return result;
  } catch (err) {
    logger.error('Architecture inference failed: ' + (err instanceof Error ? err.message : String(err)));
    return null;
  }
}

// ── Knowledge graph ────────────────────────────────────────────────────────

export async function buildKnowledgeGraph(
  sessionId: string,
  entities: unknown[],
  llmConfig?: LLMConfig,
  appName?: string,
  outputPath?: string,
  sourceSessionIds?: string[],
): Promise<unknown> {
  const sessionIds = sourceSessionIds?.length ? sourceSessionIds : [sessionId];
  const pages = await prisma.pageCapture.findMany({
    where: { crawlSessionId: { in: sessionIds } },
    select: { url: true, title: true, depth: true, extractedData: true, aiAnalysis: true },
  });

  const networkCalls = await prisma.networkCall.findMany({
    where: { crawlSessionId: { in: sessionIds } },
    select: {
      method: true,
      url: true,
      queryParams: true,
      requestPayload: true,
      responseStatus: true,
      responseBody: true,
      responseSchemaKeys: true,
      resourceType: true,
      isGraphQL: true,
      graphQLOperationName: true,
    },
  });

  let graph: unknown;

  if (isLLMConfigured(llmConfig) && config.llm.synthesisAgentEnabled) {
    graph = await retryUntilSuccess(
      async () => {
        const session = await prisma.crawlSession.findUnique({
          where: { id: sessionId },
          select: { projectId: true, project: { select: { slug: true } } },
        });
        if (!session) throw new Error('Session not found for knowledge graph workspace');

        const { materializeEvidenceWorkspace } = await import('./synthesis-workspace.js');
        const { runSynthesisAgent } = await import('./synthesis-agent.js');
        const workspace = await materializeEvidenceWorkspace({
          projectId: session.projectId,
          projectSlug: session.project.slug,
          sessionId,
          sourceSessionIds: sessionIds,
          includeNetworkCalls: true,
        });
        writeJson(path.join(workspace.root, 'entity-model.json'), { entities });

        const { artifact, steps, coverage } = await runSynthesisAgent<Record<string, unknown>>({
          workspace,
          task: 'knowledge-graph',
          expectedArtifact: 'knowledge-graph.json',
          appName,
          llmConfig,
          coverage: { requireAllPages: true, requireAllApis: false },
        });
        logger.info(`[KnowledgeGraph] Synthesis agent completed in ${steps} steps`, coverage);
        return artifact;
      },
      { label: 'Knowledge graph synthesis agent', delayMs: 15_000, maxDelayMs: 180_000 },
    );
  } else if (isLLMConfigured(llmConfig)) {
    const llm = createLLMClient(llmConfig);
    graph = await retryUntilSuccess(
      () =>
        llm.chatJson(
          [
            { role: 'system', content: 'You are a knowledge graph expert. Build a structured graph from application evidence.' },
            { role: 'user', content: buildKnowledgeGraphPrompt(pages, entities, networkCalls, appName) },
          ],
          { maxTokens: 5000 },
        ),
      { label: 'Knowledge graph chatJson', delayMs: 10_000, maxDelayMs: 180_000 },
    );
  }

  // Structural fallback only when LLM is not configured
  if (!graph) {
    graph = {
      nodes: [
        ...pages.map((p, i) => ({ id: `page-${i}`, type: 'page', label: p.title ?? p.url, properties: { url: p.url, depth: p.depth } })),
        ...(entities as Array<{ name: string; primaryModule?: string }>).map((e, i) => ({ id: `entity-${i}`, type: 'entity', label: e.name, properties: { module: e.primaryModule } })),
        ...networkCalls.map((c, i) => ({ id: `api-${i}`, type: 'api', label: `${c.method} ${c.url.slice(0, 60)}`, properties: { method: c.method, status: c.responseStatus } })),
      ],
      edges: [],
      summary: {
        totalPages: pages.length,
        totalEntities: (entities as unknown[]).length,
        totalAPIs: networkCalls.length,
        topModules: [],
        coreEntities: (entities as Array<{ name: string }>).slice(0, 5).map((e) => e.name),
      },
    };
  }

  if (outputPath) {
    writeJson(path.join(outputPath, 'knowledge-graph.json'), graph);
  }

  return graph;
}

/**
 * Returns all AI analyses across ALL completed sessions for a project.
 * This is used by report generation to combine regular + agent crawl results.
 */
export async function getProjectAnalyses(projectId: string): Promise<PageAnalysisResult[]> {
  const pages = await prisma.pageCapture.findMany({
    where: {
      aiAnalysis: { not: null },
      crawlSession: { projectId },
    },
    select: { aiAnalysis: true, url: true },
  });

  const seen = new Set<string>();
  const results: PageAnalysisResult[] = [];

  for (const page of pages) {
    if (seen.has(page.url)) continue; // deduplicate same URL across sessions
    seen.add(page.url);
    try {
      results.push(JSON.parse(page.aiAnalysis!) as PageAnalysisResult);
    } catch {
      // skip malformed
    }
  }

  return results;
}
