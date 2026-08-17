import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { prisma } from '../database/client';
import { writeText, writeJson, getReportsDir, getSessionOutputDir, fileExists, readJson } from '../utils/file-system';
import { permissionMatrixToCsv } from '../inference/permissions';
import { inferArchitecture, buildKnowledgeGraph, type ArchitectureAnalysis } from '../ai/analyzer';
import { runDeepResearch, type DeepResearchReport } from '../ai/deep-research';
import { type HarIntelligenceBriefing } from '../ai/har-intelligence';
import { createLLMClient, isLLMConfigured, resolveSynthesisLlmConfig } from '../ai/llm';
import { buildExpertReportAnalysisPrompt } from '../ai/prompts';
import { buildAnalysisGraph, finalizeAnalysisGraphArtifacts, getAnalysisGraphSnapshot, runSpecialistGraphAgents } from '../analysis/graph';
import { logger } from '../utils/logger';
import { retryUntilSuccess } from '../utils/retry';
import type { EntityModel, Entity } from '../inference/entity';
import type { WorkflowModel, Workflow } from '../inference/workflow';
import type { PermissionMatrix } from '../inference/permissions';
import type { LLMConfig } from '../ai/llm';
import type { GenerationStageId } from './checkpoint';
import { writeRedevelopmentBundle } from './redevelopment-bundle';

type ExpertReportAnalysis = Record<string, unknown>;
type CompletenessAudit = Record<string, unknown>;

export interface ReportContext {
  projectId: string;
  sessionId: string;
  sourceSessionIds?: string[];
  projectSlug: string;
  appName: string;
  entityModel: EntityModel;
  workflowModel: WorkflowModel;
  permissionMatrix: PermissionMatrix;
  llmConfig?: LLMConfig;
}

export interface ReportGenerationHooks {
  resume?: {
    skipGraphBuild?: boolean;
    skipSpecialists?: boolean;
    skipDeepResearch?: boolean;
    skipArchitecture?: boolean;
    skipExpert?: boolean;
  };
  onStageStart?: (stageId: GenerationStageId, message: string) => Promise<void> | void;
  onStageComplete?: (
    stageId: GenerationStageId,
    message: string,
    artifactPatch?: Record<string, string>,
  ) => Promise<void> | void;
  onStageProgress?: (fraction: number, message?: string) => Promise<void> | void;
}

// ── Mermaid diagram generators ────────────────────────────────────────────

function entityModelToErDiagram(entities: Entity[]): string {
  if (entities.length === 0) return '';
  const lines = ['```mermaid', 'erDiagram'];
  for (const entity of entities.slice(0, 20)) {
    const safeName = entity.name.replace(/\s+/g, '_');
    lines.push(`  ${safeName} {`);
    entity.fields.slice(0, 8).forEach((f) => {
      const safeType = f.type.replace(/[^a-zA-Z0-9_]/g, '_');
      const safeFn = f.name.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`    ${safeType} ${safeFn}`);
    });
    lines.push('  }');
  }
  for (const entity of entities.slice(0, 20)) {
    const from = entity.name.replace(/\s+/g, '_');
    for (const rel of entity.relationships.slice(0, 4)) {
      const to = rel.entity.replace(/\s+/g, '_');
      if (!entities.find((e) => e.name.replace(/\s+/g, '_') === to)) continue;
      const arrow = rel.type === 'hasMany' ? '||--o{' : rel.type === 'belongsToMany' ? '}o--o{' : rel.type === 'hasOne' ? '||--||' : '}o--||';
      lines.push(`  ${from} ${arrow} ${to} : "${rel.type}"`);
    }
  }
  lines.push('```');
  return lines.join('\n');
}

function workflowToStateDiagram(workflow: Workflow): string {
  if (workflow.states.length < 2) return '';
  const lines = ['```mermaid', 'stateDiagram-v2'];
  const safe = (s: string) => s.replace(/[\s\-\/()]/g, '_');
  lines.push(`  [*] --> ${safe(workflow.states[0] ?? '')}`);
  for (const t of workflow.transitions) {
    lines.push(`  ${safe(t.from)} --> ${safe(t.to)} : ${t.trigger.slice(0, 30)}`);
  }
  const last = workflow.states[workflow.states.length - 1];
  if (last) lines.push(`  ${safe(last)} --> [*]`);
  lines.push('```');
  return lines.join('\n');
}

function parseJsonSafe<T = unknown>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function chunkString(input: string, maxChars: number): string[] {
  if (input.length <= maxChars) return [input];
  const chunks: string[] = [];
  for (let start = 0; start < input.length; start += maxChars) {
    chunks.push(input.slice(start, start + maxChars));
  }
  return chunks;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function truncateText(value: unknown, maxChars: number): unknown {
  if (typeof value !== 'string') return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

function collectSessionArtifactMeta(projectSlug: string, sourceSessionIds: string[]): Array<Record<string, unknown>> {
  const artifacts: Array<Record<string, unknown>> = [];

  const walk = (sessionId: string, dir: string, root: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (rel === 'reports' || rel.startsWith('reports/')) continue;
        walk(sessionId, abs, root);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(abs);
      artifacts.push({
        sessionId,
        relativePath: rel,
        extension: path.extname(entry.name).toLowerCase(),
        folder: rel.includes('/') ? rel.split('/')[0] : '',
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        sha256: sha256(fs.readFileSync(abs)),
      });
    }
  };

  for (const sessionId of sourceSessionIds) {
    const root = getSessionOutputDir(projectSlug, sessionId);
    walk(sessionId, root, root);
  }

  return artifacts;
}

function buildCompletenessAudit(args: {
  sourceSessionIds: string[];
  pages: unknown[];
  calls: Array<{ requestPayload?: string | null; responseBody?: string | null; requestHeaders?: string | null; responseHeaders?: string | null }>;
  artifactFiles: Array<Record<string, unknown>>;
  evidenceText?: string;
}): CompletenessAudit {
  const artifactBytes = args.artifactFiles.reduce((sum, file) => sum + Number(file['sizeBytes'] ?? 0), 0);
  const artifactsBySession = args.sourceSessionIds.map((sessionId) => ({
    sessionId,
    fileCount: args.artifactFiles.filter((file) => file['sessionId'] === sessionId).length,
    sizeBytes: args.artifactFiles
      .filter((file) => file['sessionId'] === sessionId)
      .reduce((sum, file) => sum + Number(file['sizeBytes'] ?? 0), 0),
  }));

  return {
    generatedAt: new Date().toISOString(),
    guarantee:
      'Expert LLM evidence includes page AI analyses, truncated API payloads, full HAR 1.2 files, inferred models, and artifact metadata/hashes. Raw HTML, full HTML artifact bodies, and the full analysis graph are excluded to keep chunk counts tractable.',
    sourceSessionIds: args.sourceSessionIds,
    sourceSessionCount: args.sourceSessionIds.length,
    dbPagesIncluded: args.pages.length,
    dbNetworkCallsIncluded: args.calls.length,
    requestPayloadsIncluded: args.calls.filter((call) => call.requestPayload).length,
    responseBodiesIncluded: args.calls.filter((call) => call.responseBody).length,
    requestHeadersIncluded: args.calls.filter((call) => call.requestHeaders).length,
    responseHeadersIncluded: args.calls.filter((call) => call.responseHeaders).length,
    rawArtifactFilesIncluded: args.artifactFiles.length,
    rawArtifactBytesIncluded: artifactBytes,
    rawArtifactsBySession: artifactsBySession,
    evidenceCharacters: args.evidenceText?.length ?? null,
    evidenceSha256: args.evidenceText ? sha256(args.evidenceText) : null,
  };
}

async function buildCompleteEvidencePackage(ctx: ReportContext, networkCallsTotal: number): Promise<Record<string, unknown>> {
  const sourceSessionIds = ctx.sourceSessionIds?.length ? ctx.sourceSessionIds : [ctx.sessionId];
  // Metadata/hashes only — embedding full file bodies made 300MB+ / thousands of LLM chunks
  const artifactFiles = collectSessionArtifactMeta(ctx.projectSlug, sourceSessionIds);
  const [pages, calls, findings] = await Promise.all([
    prisma.pageCapture.findMany({
      where: { crawlSessionId: { in: sourceSessionIds } },
      orderBy: [{ depth: 'asc' }, { createdAt: 'asc' }],
      select: {
        url: true,
        title: true,
        depth: true,
        loadTimeMs: true,
        visibleText: true,
        extractedData: true,
        aiAnalysis: true,
        createdAt: true,
      },
    }),
    prisma.networkCall.findMany({
      where: { crawlSessionId: { in: sourceSessionIds } },
      orderBy: { createdAt: 'asc' },
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
        timingMs: true,
        resourceType: true,
        isGraphQL: true,
        graphQLOperationName: true,
        pageCapture: { select: { url: true, title: true } },
      },
    }),
    prisma.analysisFinding.findMany({
      where: { crawlSessionId: ctx.sessionId },
      orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
      take: 200,
      select: {
        agent: true,
        category: true,
        severity: true,
        title: true,
        detail: true,
        recommendation: true,
        evidenceNodeIds: true,
      },
    }),
  ]);
  const completenessAudit = buildCompletenessAudit({ sourceSessionIds, pages, calls, artifactFiles });
  const { loadHarFilesForSessions } = await import('../ai/har-summary.js');
  const harFiles = loadHarFilesForSessions(ctx.projectSlug, sourceSessionIds, 60);
  const harArtifactCount = artifactFiles.filter((f) => f['folder'] === 'har' || String(f['extension']) === '.har').length;

  return {
    project: {
      id: ctx.projectId,
      appName: ctx.appName,
      sessionId: ctx.sessionId,
      sourceSessionIds,
      pagesCaptured: pages.length,
      networkCallsCaptured: networkCallsTotal,
      harFilesCaptured: harArtifactCount,
      harFilesIncluded: harFiles.length,
    },
    pages: pages.map((page) => ({
      url: page.url,
      title: page.title,
      depth: page.depth,
      loadTimeMs: page.loadTimeMs,
      aiAnalysis: parseJsonSafe(page.aiAnalysis),
      createdAt: page.createdAt,
    })),
    api: {
      totalCalls: calls.length,
      callsWithRequestPayload: calls.filter((call) => call.requestPayload).length,
      callsWithResponseBody: calls.filter((call) => call.responseBody).length,
      // Cap API rows for expert LLM — full inventory stays in DB / other report sections
      calls: calls.slice(0, 400).map((call) => ({
        method: call.method,
        url: call.url,
        page: call.pageCapture,
        responseStatus: call.responseStatus,
        responseSchemaKeys: parseJsonSafe(call.responseSchemaKeys) ?? call.responseSchemaKeys,
        requestPayload: truncateText(
          typeof (parseJsonSafe(call.requestPayload) ?? call.requestPayload) === 'string'
            ? (parseJsonSafe(call.requestPayload) ?? call.requestPayload)
            : JSON.stringify(parseJsonSafe(call.requestPayload) ?? call.requestPayload ?? null),
          800,
        ),
        responseBody: truncateText(
          typeof (parseJsonSafe(call.responseBody) ?? call.responseBody) === 'string'
            ? (parseJsonSafe(call.responseBody) ?? call.responseBody)
            : JSON.stringify(parseJsonSafe(call.responseBody) ?? call.responseBody ?? null),
          800,
        ),
        timingMs: call.timingMs,
        resourceType: call.resourceType,
        isGraphQL: call.isGraphQL,
        graphQLOperationName: call.graphQLOperationName,
      })),
    },
    har: {
      totalFiles: harArtifactCount,
      files: harFiles.map((f) => ({
        sourceSessionId: f.sourceSessionId,
        sourceFile: f.sourceFile,
        pageUrl: f.pageUrl,
        entryCount: f.entryCount,
        har: f.har,
      })),
    },
    harIntelligence: readJson(path.join(getReportsDir(ctx.projectSlug, ctx.sessionId), 'har-intelligence.json')),
    deepResearch: readJson(path.join(getReportsDir(ctx.projectSlug, ctx.sessionId), 'deep-research.json')),
    rawArtifactFiles: {
      totalFiles: artifactFiles.length,
      // hashes/paths only — no file bodies; cap listing size
      files: artifactFiles.slice(0, 500),
    },
    completenessAudit,
    inferredModels: {
      entities: ctx.entityModel,
      workflows: ctx.workflowModel,
      permissions: ctx.permissionMatrix,
    },
    specialistFindings: findings.map((f) => ({
      ...f,
      evidenceNodeIds: parseJsonSafe(f.evidenceNodeIds ?? undefined) ?? [],
    })),
  };
}

async function runExpertReportAnalysis(
  ctx: ReportContext,
  networkCallsTotal: number,
  reportsDir: string,
  onChunkProgress?: (fraction: number, message?: string) => Promise<void> | void,
): Promise<ExpertReportAnalysis | null> {
  // Expert is a synthesis stage — use SYNTHESIS_LLM_* (NVIDIA) when configured, not page-analysis OpenAI.
  const expertLlmConfig = resolveSynthesisLlmConfig(ctx.llmConfig);
  if (!expertLlmConfig.apiKey && !isLLMConfigured(ctx.llmConfig)) return null;

  const existingFinal = path.join(reportsDir, 'expert-analysis.json');
  if (fileExists(existingFinal)) {
    const cached = readJson<ExpertReportAnalysis>(existingFinal);
    if (cached) {
      logger.info('Reusing existing expert-analysis.json from checkpoint');
      return cached;
    }
  }

  try {
    const evidence = await buildCompleteEvidencePackage(ctx, networkCallsTotal);
    const sourceSessionIds = ctx.sourceSessionIds?.length ? ctx.sourceSessionIds : [ctx.sessionId];
    const preAuditEvidenceText = JSON.stringify(evidence, null, 2);
    evidence['completenessAudit'] = {
      ...(evidence['completenessAudit'] as Record<string, unknown> | undefined),
      evidenceCharactersBeforeFinalAuditStamp: preAuditEvidenceText.length,
      evidenceSha256BeforeFinalAuditStamp: sha256(preAuditEvidenceText),
    };
    const evidenceText = JSON.stringify(evidence, null, 2);
    const evidenceSha = sha256(evidenceText);
    const completenessAudit = {
      ...(evidence['completenessAudit'] as Record<string, unknown> | undefined),
      completeEvidenceFileCharacters: evidenceText.length,
      completeEvidenceFileSha256: evidenceSha,
    };
    writeJson(path.join(reportsDir, 'complete-analysis-evidence.json'), evidence);
    writeJson(path.join(reportsDir, 'expert-analysis-evidence.json'), evidence);
    writeJson(path.join(reportsDir, 'completeness-audit.json'), completenessAudit);

    // Keep chunk count tractable (smaller chunks → more reliable JSON from synthesis models)
    const targetMaxChunks = 32;
    let chunkSize = 60_000;
    let chunks = chunkString(evidenceText, chunkSize);
    while (chunks.length > targetMaxChunks && chunkSize < 200_000) {
      chunkSize = Math.min(200_000, Math.ceil(evidenceText.length / targetMaxChunks) + 1_000);
      chunks = chunkString(evidenceText, chunkSize);
    }
    logger.info(
      `Expert evidence package: ${evidenceText.length} chars → ${chunks.length} chunks (size=${chunkSize})`,
    );

    writeJson(path.join(reportsDir, 'expert-analysis-chunk-manifest.json'), {
      evidenceFile: 'complete-analysis-evidence.json',
      evidenceSha256: evidenceSha,
      totalCharacters: evidenceText.length,
      chunkSize,
      sourceSessionIds,
      chunks: chunks.map((chunk, index) => ({
        index: index + 1,
        startChar: index * chunkSize,
        endCharExclusive: index * chunkSize + chunk.length,
        charLength: chunk.length,
        sha256: sha256(chunk),
      })),
    });
    const llm = createLLMClient(expertLlmConfig);
    logger.info(
      `Expert report agent using model=${expertLlmConfig.model ?? 'default'} baseUrl=${expertLlmConfig.baseUrl ?? 'default (OpenAI)'}`,
    );
    const chunkAnalyses: ExpertReportAnalysis[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = path.join(reportsDir, `expert-analysis-chunk-${String(i + 1).padStart(3, '0')}.json`);
      const existingChunk = fileExists(chunkPath) ? readJson<ExpertReportAnalysis>(chunkPath) : null;
      if (existingChunk) {
        logger.info(`Reusing expert chunk ${i + 1}/${chunks.length} from checkpoint`);
        chunkAnalyses.push(existingChunk);
        await onChunkProgress?.((i + 1) / chunks.length, `Expert analysis chunk ${i + 1}/${chunks.length} (cached)`);
        continue;
      }

      logger.info(`Expert report agent analyzing evidence chunk ${i + 1}/${chunks.length}`);
      await onChunkProgress?.(i / chunks.length, `Expert analysis chunk ${i + 1}/${chunks.length}`);
      const chunkAnalysis = await retryUntilSuccess(
        () =>
          llm.chatJson<ExpertReportAnalysis>(
            [
              {
                role: 'system',
                content:
                  'You are an expert evidence extraction agent for enterprise reverse engineering. Analyze this raw evidence chunk without ignoring any included content. Return only valid JSON.',
              },
              {
                role: 'user',
                content: `Application: ${ctx.appName}
Evidence chunk ${i + 1} of ${chunks.length}. This is a contiguous raw segment of the complete evidence file. Extract all useful observations for domain, product, architecture, data, API, security, workflows, risks, and report recommendations. Do not summarize away important evidence.

Return JSON:
{
  "chunk": ${i + 1},
  "observations": [{"area": "domain|product|architecture|data|api|security|workflow|ux|operations", "finding": "finding", "evidence": "exact page/api/form/table signal"}],
  "entities": [{"name": "entity", "fields": ["field"], "evidence": "evidence"}],
  "apis": [{"method": "GET", "url": "url", "purpose": "purpose", "payloadFindings": ["finding"], "responseFindings": ["finding"]}],
  "risks": [{"area": "area", "severity": "critical|high|medium|low", "risk": "risk", "evidence": "evidence"}],
  "recommendations": [{"owner": "Architect|Data|Product|Engineering|Security", "priority": "critical|high|medium|low", "recommendation": "recommendation", "evidence": "evidence"}]
}

Raw evidence chunk:
${chunks[i]}`,
              },
            ],
            { maxTokens: 8_000 },
          ),
        { label: `Expert chunk ${i + 1}/${chunks.length}`, delayMs: 10_000, maxDelayMs: 180_000 },
      );
      chunkAnalyses.push(chunkAnalysis);
      writeJson(chunkPath, chunkAnalysis);
      await onChunkProgress?.((i + 1) / chunks.length, `Expert analysis chunk ${i + 1}/${chunks.length} complete`);
    }

    const analysis = await retryUntilSuccess(
      () =>
        llm.chatJson<ExpertReportAnalysis>(
          [
            {
              role: 'system',
              content:
                'You are the final report synthesis orchestrator: chief software engineer, solution architect, data engineer, senior developer, product owner, security reviewer, integration architect, and domain expert. Use every chunk analysis and return only valid JSON.',
            },
            {
              role: 'user',
              content: buildExpertReportAnalysisPrompt(
                { chunkAnalyses, evidenceCoverage: { chunksProcessed: chunks.length, completeEvidenceCharacters: evidenceText.length } },
                ctx.appName,
              ),
            },
          ],
          { maxTokens: 8_000 },
        ),
      { label: 'Expert final synthesis', delayMs: 10_000, maxDelayMs: 180_000 },
    );

    writeJson(path.join(reportsDir, 'expert-analysis.json'), analysis);
    return analysis;
  } catch (err) {
    // Should be rare now — outer safety net keeps retrying the whole expert stage
    logger.warn('Expert report analysis failed, will be retried by caller if wrapped: ' + (err instanceof Error ? err.message : String(err)));
    throw err;
  }
}

function appendExpertAnalysis(reportLines: string[], analysis: ExpertReportAnalysis): void {
  const get = (path: string): unknown => path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, analysis);

  const pushList = (title: string, items: unknown, formatter?: (item: unknown) => string) => {
    if (!Array.isArray(items) || items.length === 0) return;
    reportLines.push(`### ${title}`, '');
    items.slice(0, 30).forEach((item) => {
      reportLines.push(`- ${formatter ? formatter(item) : String(item)}`);
    });
    reportLines.push('');
  };

  reportLines.push('---', '', '## Expert Enterprise Analysis', '');
  const executive = get('executiveAssessment') as Record<string, unknown> | undefined;
  if (executive) {
    reportLines.push('### Executive Assessment', '');
    if (executive['summary']) reportLines.push(String(executive['summary']), '');
    reportLines.push(`- **Business Domain:** ${executive['businessDomain'] ?? 'Unknown'}`);
    reportLines.push(`- **System Purpose:** ${executive['systemPurpose'] ?? 'Unknown'}`);
    reportLines.push(`- **Maturity:** ${executive['maturity'] ?? 'Unknown'}`);
    reportLines.push(`- **Confidence:** ${executive['confidence'] ?? 'Unknown'}`, '');
  }

  pushList('Business Capabilities', get('domainAnalysis.capabilities'), (item) => {
    const row = item as Record<string, unknown>;
    return `**${row['name'] ?? 'Capability'}:** ${row['description'] ?? ''}`;
  });
  pushList('User Journeys', get('productOwnerView.userJourneys'), (item) => {
    const row = item as Record<string, unknown>;
    const steps = Array.isArray(row['steps']) ? (row['steps'] as unknown[]).join(' -> ') : '';
    return `**${row['name'] ?? 'Journey'}:** ${steps}`;
  });
  pushList('API And Integration Findings', get('apiAndIntegrationAnalysis.payloadAndResponseFindings'));
  pushList('Data Flows', get('dataEngineeringAnalysis.dataFlows'), (item) => {
    const row = item as Record<string, unknown>;
    return `**${row['name'] ?? 'Flow'}:** ${row['source'] ?? '?'} -> ${row['destination'] ?? '?'}; ${(row['payloadObservations'] as string[] | undefined)?.join(', ') ?? ''}`;
  });
  pushList('Security Risks', get('securityAndCompliance.risks'), (item) => {
    const row = item as Record<string, unknown>;
    return `**${row['severity'] ?? 'unknown'}:** ${row['risk'] ?? ''} Recommendation: ${row['recommendation'] ?? ''}`;
  });
  pushList('Technical Debt', get('developerView.technicalDebt'), (item) => {
    const row = item as Record<string, unknown>;
    return `**${row['item'] ?? 'Item'}:** ${row['impact'] ?? ''} Recommendation: ${row['recommendation'] ?? ''}`;
  });
  pushList('Priority Recommendations', get('priorityRecommendations'), (item) => {
    const row = item as Record<string, unknown>;
    return `**${row['priority'] ?? 'medium'} / ${row['owner'] ?? 'Owner'}:** ${row['recommendation'] ?? ''} (${row['rationale'] ?? ''})`;
  });

  const coverage = get('evidenceCoverage') as Record<string, unknown> | undefined;
  if (coverage) {
    reportLines.push('### Evidence Coverage', '');
    reportLines.push(`- **Pages analyzed:** ${coverage['pagesAnalyzed'] ?? 'Unknown'}`);
    reportLines.push(`- **API calls analyzed:** ${coverage['apiCallsAnalyzed'] ?? 'Unknown'}`);
    reportLines.push(`- **Payloads analyzed:** ${coverage['payloadsAnalyzed'] ?? 'Unknown'}`);
    reportLines.push(`- **Response bodies analyzed:** ${coverage['responseBodiesAnalyzed'] ?? 'Unknown'}`);
    const gaps = coverage['coverageGaps'];
    if (Array.isArray(gaps) && gaps.length) {
      reportLines.push(`- **Coverage gaps:** ${gaps.join('; ')}`);
    }
    reportLines.push('');
  }
}

async function appendAnalysisGraphFindings(reportLines: string[], sessionId: string): Promise<void> {
  const findings = await prisma.analysisFinding.findMany({
    where: { crawlSessionId: sessionId },
    orderBy: [{ severity: 'desc' }, { agent: 'asc' }, { createdAt: 'asc' }],
  });
  if (findings.length === 0) return;

  reportLines.push('---', '', '## Shared Analysis Graph Findings', '');
  const byAgent = new Map<string, typeof findings>();
  for (const finding of findings) {
    if (!byAgent.has(finding.agent)) byAgent.set(finding.agent, []);
    byAgent.get(finding.agent)!.push(finding);
  }

  for (const [agent, agentFindings] of byAgent) {
    reportLines.push(`### ${agent}`, '');
    for (const finding of agentFindings.slice(0, 40)) {
      const evidence = parseJsonSafe<string[]>(finding.evidenceNodeIds ?? undefined) ?? [];
      reportLines.push(`- **${finding.severity ?? 'info'} / ${finding.category}: ${finding.title}**`);
      reportLines.push(`  ${finding.detail}`);
      if (finding.recommendation) reportLines.push(`  Recommendation: ${finding.recommendation}`);
      if (evidence.length) reportLines.push(`  Evidence nodes: ${evidence.slice(0, 8).join(', ')}`);
    }
    reportLines.push('');
  }
}

function appendDeepResearchSections(
  reportLines: string[],
  briefing: HarIntelligenceBriefing | null,
  research: DeepResearchReport | null,
): void {
  if (!briefing && !research) return;

  reportLines.push('---', '', '## Deep Network Research', '');
  reportLines.push(
    'This section is a production-grade research layer: a **deterministic HAR intelligence briefing** (every captured HAR file, templated endpoints, hosts, auth signals) plus an optional **LLM research dossier** grounded in those facts.',
    '',
  );

  if (briefing) {
    reportLines.push('### Observed HAR intelligence', '');
    for (const fact of briefing.facts) reportLines.push(`- ${fact}`);
    reportLines.push('');
    reportLines.push(
      `| Metric | Value |`,
      `|--------|-------|`,
      `| HAR files | ${briefing.stats.harFiles} |`,
      `| Requests | ${briefing.stats.entries} |`,
      `| Hosts | ${briefing.stats.uniqueHosts} |`,
      `| Templated endpoints | ${briefing.stats.uniqueEndpoints} |`,
      `| XHR/fetch | ${briefing.stats.xhrFetchCount} |`,
      `| HTTP 401 / 403 | ${briefing.auth.status401} / ${briefing.auth.status403} |`,
      `| Authorization header | ${briefing.auth.authorizationHeaderPresent ? 'yes' : 'not observed'} |`,
      `| Set-Cookie | ${briefing.auth.setCookiePresent ? 'yes' : 'not observed'} |`,
      `| CSRF header | ${briefing.auth.csrfHeaderPresent ? 'yes' : 'not observed'} |`,
      '',
    );

    if (briefing.hosts.length) {
      reportLines.push('### Host inventory', '');
      reportLines.push('| Host | Category | Requests |', '|------|----------|----------|');
      for (const host of briefing.hosts.slice(0, 25)) {
        reportLines.push(`| \`${host.host}\` | ${host.category} | ${host.requestCount} |`);
      }
      reportLines.push('');
    }

    const apiEndpoints = briefing.endpoints.slice(0, 40);
    if (apiEndpoints.length) {
      reportLines.push('### Endpoint catalog (templated)', '');
      reportLines.push('| Method | Pattern | Count | p50 ms | p95 ms | Statuses |', '|--------|---------|-------|--------|--------|----------|');
      for (const ep of apiEndpoints) {
        const statuses = Object.entries(ep.statuses).map(([s, n]) => `${s}×${n}`).join(', ');
        reportLines.push(
          `| ${ep.method} | \`${ep.urlPattern.slice(0, 90)}\` | ${ep.count} | ${ep.p50Ms} | ${ep.p95Ms} | ${statuses} |`,
        );
      }
      reportLines.push('');
    }

    if (briefing.slowest.length) {
      reportLines.push('### Slowest API calls', '');
      reportLines.push('| ms | Method | URL | Page |', '|----|--------|-----|------|');
      for (const row of briefing.slowest.slice(0, 12)) {
        reportLines.push(`| ${row.timeMs} | ${row.method} | \`${row.url.slice(0, 70)}\` | ${row.pageUrl.slice(0, 40)} |`);
      }
      reportLines.push('');
    }

    if (briefing.errors.length) {
      reportLines.push('### HTTP errors', '');
      reportLines.push('| Status | Count | Method | Pattern |', '|--------|-------|--------|---------|');
      for (const err of briefing.errors.slice(0, 15)) {
        reportLines.push(`| ${err.status} | ${err.count} | ${err.method} | \`${err.urlPattern.slice(0, 80)}\` |`);
      }
      reportLines.push('');
    }

    const seq = briefing.pageSequences.find((p) => p.calls.some((c) => c.resourceType === 'xhr' || c.resourceType === 'fetch'));
    if (seq && seq.calls.length >= 2) {
      reportLines.push(`### Example page-load sequence — ${seq.pageUrl}`, '');
      reportLines.push('```mermaid', 'sequenceDiagram');
      reportLines.push('  participant Page', '  participant Network');
      for (const call of seq.calls.slice(0, 12)) {
        const label = `${call.method} ${call.url.replace(/https?:\/\/[^/]+/, '').slice(0, 50)} (${call.status})`;
        reportLines.push(`  Page->>Network: ${label.replace(/[:#]/g, ' ')}`);
      }
      reportLines.push('```', '');
    }
  }

  if (research) {
    reportLines.push('### Research dossier', '');
    if (research.researchThesis) {
      reportLines.push(`**Thesis:** ${research.researchThesis}`, '');
      reportLines.push(`**Confidence:** ${research.confidence}`, '');
    }
    if (research.observedFacts?.length) {
      reportLines.push('**Observed facts**', '');
      for (const f of research.observedFacts.slice(0, 20)) reportLines.push(`- ${f}`);
      reportLines.push('');
    }
    if (research.inferences?.length) {
      reportLines.push('**Inferences**', '');
      for (const inf of research.inferences.slice(0, 15)) {
        reportLines.push(`- ${inf.claim} _(confidence ${inf.confidence}; ${inf.evidence?.join(', ') || 'no cite'})_`);
      }
      reportLines.push('');
    }
    if (research.integrationMap?.firstPartyApiFamilies?.length) {
      reportLines.push('**First-party API families**', '');
      for (const fam of research.integrationMap.firstPartyApiFamilies.slice(0, 12)) {
        reportLines.push(`- **${fam.family}** \`${fam.baseUrlHint}\` — ${fam.purpose} (${fam.methods.join(', ')})`);
      }
      reportLines.push('');
    }
    if (research.integrationMap?.thirdParties?.length) {
      reportLines.push('**Third parties**', '');
      for (const tp of research.integrationMap.thirdParties.slice(0, 15)) {
        reportLines.push(`- \`${tp.host}\` (${tp.category}) — ${tp.purpose}. Risk: ${tp.risk}`);
      }
      reportLines.push('');
    }
    if (research.authAndSessionModel) {
      reportLines.push('**Auth / session model**', '');
      reportLines.push(`- Mechanism: ${research.authAndSessionModel.mechanism}`);
      if (research.authAndSessionModel.evidence?.length) {
        reportLines.push(`- Evidence: ${research.authAndSessionModel.evidence.join('; ')}`);
      }
      reportLines.push('');
    }
    if (research.riskRegister?.length) {
      reportLines.push('**Risk register**', '');
      reportLines.push('| Severity | Title | Recommendation |', '|----------|-------|----------------|');
      for (const risk of research.riskRegister.slice(0, 15)) {
        reportLines.push(`| ${risk.severity} | ${risk.title} | ${risk.recommendation} |`);
      }
      reportLines.push('');
    }
    if (research.reconstructionPlaybook) {
      const pb = research.reconstructionPlaybook;
      reportLines.push('**Reconstruction playbook**', '');
      reportLines.push(`- Approach: ${pb.recommendedApproach}`);
      if (pb.modulesToRebuildFirst?.length) reportLines.push(`- Rebuild first: ${pb.modulesToRebuildFirst.join(', ')}`);
      if (pb.dataContractsToClone?.length) reportLines.push(`- Clone contracts: ${pb.dataContractsToClone.join(', ')}`);
      if (pb.unknownsToValidate?.length) reportLines.push(`- Validate: ${pb.unknownsToValidate.join('; ')}`);
      reportLines.push('');
    }
    if (research.openQuestions?.length) {
      reportLines.push('**Open questions**', '');
      for (const q of research.openQuestions.slice(0, 12)) reportLines.push(`- ${q}`);
      reportLines.push('');
    }
  }

  reportLines.push('Artifacts: `har-intelligence.json`, `deep-research.json`, session `har/*.har`.', '');
}

function appendCoverageSection(reportLines: string[], coverage: Record<string, unknown> | null): void {
  if (!coverage) return;
  const counts = (coverage['counts'] ?? {}) as Record<string, unknown>;
  const ratios = (coverage['ratios'] ?? {}) as Record<string, unknown>;
  reportLines.push('---', '', '## Evidence Coverage & Auditability', '');
  reportLines.push(`- **Coverage score:** ${coverage['score'] ?? 'Unknown'} / 100`);
  reportLines.push(`- **Graph nodes:** ${counts['nodes'] ?? 0}`);
  reportLines.push(`- **Graph edges:** ${counts['edges'] ?? 0}`);
  reportLines.push(`- **Findings:** ${counts['findings'] ?? 0}`);
  reportLines.push(`- **Findings with evidence:** ${counts['findingsWithEvidence'] ?? 0}`);
  reportLines.push(`- **Pages with AI analysis:** ${counts['pagesWithAiAnalysis'] ?? 0} / ${counts['pages'] ?? 0}`);
  reportLines.push(`- **API calls with response body:** ${counts['apiCallsWithResponseBody'] ?? 0} / ${counts['networkCalls'] ?? 0}`);
  reportLines.push(`- **Graph connected nodes ratio:** ${typeof ratios['graphConnectedNodes'] === 'number' ? (ratios['graphConnectedNodes'] * 100).toFixed(0) + '%' : 'Unknown'}`);
  reportLines.push('');
  reportLines.push('Supporting audit artifacts: `completeness-audit.json`, `expert-analysis-chunk-manifest.json`, `analysis-coverage.json`, `evidence-citation-map.json`, `analysis-graph-enriched.json`, and `report-run-manifest.json`.', '');
}

function writeReportRunManifest(args: {
  reportsDir: string;
  ctx: ReportContext;
  startedAt: string;
  graphContext: { nodeCount: number; edgeCount: number; findingCount: number };
  graphFinalization: Record<string, unknown> | null;
  rawArtifactFileCount: number;
  architectureAvailable: boolean;
  expertAnalysisAvailable: boolean;
  deepResearchAvailable?: boolean;
  reportPath: string;
}): { status: 'complete' | 'degraded'; missingRequiredArtifacts: string[]; warnings: string[] } {
  const expectedArtifacts = [
    'final-report.md',
    'final-report.pdf',
    'entity-model.json',
    'workflow-model.json',
    'permission-matrix.csv',
    'analysis-graph.json',
    'analysis-graph-enriched.json',
    'analysis-coverage.json',
    'evidence-citation-map.json',
    'finding-dedupe-summary.json',
    'complete-analysis-evidence.json',
    'completeness-audit.json',
    'expert-analysis-evidence.json',
    'expert-analysis-chunk-manifest.json',
    'expert-analysis.json',
    'knowledge-graph.json',
    'architecture.json',
    'har-intelligence.json',
    'deep-research.json',
    'redevelopment-blueprint.json',
    'api-contract-catalog.json',
    'implementation-backlog.json',
    'traceability-matrix.csv',
    'validation-plan.json',
    'REDEVELOPMENT-README.md',
  ];
  const requiredArtifacts = new Set([
    'final-report.md',
    'entity-model.json',
    'workflow-model.json',
    'permission-matrix.csv',
    'analysis-graph.json',
    'analysis-graph-enriched.json',
    'analysis-coverage.json',
    'evidence-citation-map.json',
    'redevelopment-blueprint.json',
    'api-contract-catalog.json',
    'implementation-backlog.json',
    'traceability-matrix.csv',
    'validation-plan.json',
    'REDEVELOPMENT-README.md',
  ]);
  const artifactInventory = expectedArtifacts.map((name) => {
    const abs = path.join(args.reportsDir, name);
    const exists = fileExists(abs);
    const data = exists ? fs.readFileSync(abs) : null;
    return {
      name,
      required: requiredArtifacts.has(name),
      exists,
      sizeBytes: data?.length ?? 0,
      sha256: data ? sha256(data) : null,
    };
  });
  const missingRequired = artifactInventory
    .filter((artifact) => artifact.required && !artifact.exists)
    .map((artifact) => artifact.name);
  const qualityWarnings = [
    ...(args.graphFinalization ? [] : ['Analysis graph finalization failed']),
    ...(args.architectureAvailable ? [] : ['Architecture analysis unavailable']),
    ...(args.expertAnalysisAvailable ? [] : ['Expert evidence analysis unavailable']),
    ...(args.deepResearchAvailable ? [] : ['Deep research unavailable']),
    ...missingRequired.map((name) => `Required artifact missing: ${name}`),
  ];

  const status = qualityWarnings.length === 0 ? 'complete' : 'degraded';
  writeJson(path.join(args.reportsDir, 'report-run-manifest.json'), {
    run: {
      startedAt: args.startedAt,
      finishedAt: new Date().toISOString(),
      projectId: args.ctx.projectId,
      sessionId: args.ctx.sessionId,
      sourceSessionIds: args.ctx.sourceSessionIds?.length ? args.ctx.sourceSessionIds : [args.ctx.sessionId],
      appName: args.ctx.appName,
    },
    stages: [
      'page-analysis',
      'entity-inference',
      'workflow-inference',
      'permission-inference',
      'graph-indexing',
      'specialist-graph-agents',
      'deep-network-research',
      'finding-deduplication',
      'coverage-and-citation-map',
      'architecture-inference',
      'expert-chunk-analysis',
      'final-report-writing',
    ],
    graph: args.graphContext,
    rawArtifactFileCount: args.rawArtifactFileCount,
    graphFinalization: args.graphFinalization,
    architectureAvailable: args.architectureAvailable,
    expertAnalysisAvailable: args.expertAnalysisAvailable,
    deepResearchAvailable: args.deepResearchAvailable ?? false,
    quality: {
      status,
      warnings: qualityWarnings,
      missingRequiredArtifacts: missingRequired,
    },
    artifacts: artifactInventory.filter((artifact) => artifact.exists).map((artifact) => artifact.name),
    artifactInventory,
    reportPath: args.reportPath,
  });
  return { status, missingRequiredArtifacts: missingRequired, warnings: qualityWarnings };
}

export async function generateFullReport(
  ctx: ReportContext,
  hooks: ReportGenerationHooks = {},
): Promise<string> {
  const startedAt = new Date().toISOString();
  const reportsDir = getReportsDir(ctx.projectSlug, ctx.sessionId);
  const sourceSessionIds = ctx.sourceSessionIds?.length ? ctx.sourceSessionIds : [ctx.sessionId];
  const rawArtifactFileCount = collectSessionArtifactMeta(ctx.projectSlug, sourceSessionIds).length;
  const session = await prisma.crawlSession.findUnique({
    where: { id: ctx.sessionId },
    include: { pages: { orderBy: { depth: 'asc' } } },
  });

  if (!session) throw new Error('Crawl session not found');
  const reportPages = await prisma.pageCapture.findMany({
    where: { crawlSessionId: { in: sourceSessionIds } },
    orderBy: [{ depth: 'asc' }, { createdAt: 'asc' }],
  });

  const networkCallCounts = await prisma.networkCall.groupBy({
    by: ['pageCaptureId'],
    where: { crawlSessionId: { in: sourceSessionIds } },
    _count: { id: true },
  });

  const networkCallsTotal = await prisma.networkCall.count({
    where: { crawlSessionId: { in: sourceSessionIds } },
  });

  let graphContext: { nodeCount: number; edgeCount: number; findingCount: number };

  if (hooks.resume?.skipGraphBuild) {
    logger.info('[Generation] Skipping graph-indexing (checkpoint)');
    const snapshot = await getAnalysisGraphSnapshot(ctx.sessionId).catch(() => null);
    const nodes = Array.isArray(snapshot?.['nodes']) ? snapshot['nodes'] as unknown[] : [];
    const edges = Array.isArray(snapshot?.['edges']) ? snapshot['edges'] as unknown[] : [];
    const findings = Array.isArray(snapshot?.['findings']) ? snapshot['findings'] as unknown[] : [];
    graphContext = {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      findingCount: findings.length,
    };
  } else {
    await hooks.onStageStart?.('graph-indexing', 'Report orchestrator: analysis graph indexing');
    graphContext = await buildAnalysisGraph({
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      projectSlug: ctx.projectSlug,
      sourceSessionIds,
      appName: ctx.appName,
      reportsDir,
      entityModel: ctx.entityModel,
      workflowModel: ctx.workflowModel,
      permissionMatrix: ctx.permissionMatrix,
    });
    await hooks.onStageComplete?.('graph-indexing', `Graph indexed (${graphContext.nodeCount} nodes)`);
  }

  if (!hooks.resume?.skipSpecialists) {
    await hooks.onStageStart?.('specialist-agents', 'Specialist graph agents running');
    await runSpecialistGraphAgents({
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      sourceSessionIds,
      appName: ctx.appName,
      reportsDir,
      llmConfig: ctx.llmConfig,
    });
    await hooks.onStageComplete?.('specialist-agents', 'Specialist graph agents complete');
  } else {
    logger.info('[Generation] Skipping specialist-agents (checkpoint)');
  }

  let harBriefing: HarIntelligenceBriefing | null = null;
  let deepResearch: DeepResearchReport | null = null;
  if (!hooks.resume?.skipDeepResearch) {
    await hooks.onStageStart?.('deep-research', 'Deep network research: HAR intelligence + research dossier');
    try {
      const result = await runDeepResearch({
        sessionId: ctx.sessionId,
        projectId: ctx.projectId,
        projectSlug: ctx.projectSlug,
        appName: ctx.appName,
        sourceSessionIds,
        reportsDir,
        llmConfig: ctx.llmConfig,
      });
      harBriefing = result.briefing;
      deepResearch = result.research;
    } catch (err) {
      logger.warn('Deep research skipped/failed: ' + (err instanceof Error ? err.message : String(err)));
      harBriefing = readJson<HarIntelligenceBriefing>(path.join(reportsDir, 'har-intelligence.json'));
    }
    await hooks.onStageComplete?.(
      'deep-research',
      deepResearch ? 'Deep research dossier complete' : 'HAR intelligence captured',
      {
        ...(fileExists(path.join(reportsDir, 'har-intelligence.json'))
          ? { harIntelligencePath: path.join(reportsDir, 'har-intelligence.json') }
          : {}),
        ...(fileExists(path.join(reportsDir, 'deep-research.json'))
          ? { deepResearchPath: path.join(reportsDir, 'deep-research.json') }
          : {}),
      },
    );
  } else {
    logger.info('[Generation] Skipping deep-research (checkpoint)');
    harBriefing = fileExists(path.join(reportsDir, 'har-intelligence.json'))
      ? readJson<HarIntelligenceBriefing>(path.join(reportsDir, 'har-intelligence.json'))
      : null;
    deepResearch = fileExists(path.join(reportsDir, 'deep-research.json'))
      ? readJson<DeepResearchReport>(path.join(reportsDir, 'deep-research.json'))
      : null;
  }

  const graphFinalization = await finalizeAnalysisGraphArtifacts(ctx.sessionId, reportsDir, sourceSessionIds).catch((err) => {
    logger.warn('Graph finalization failed: ' + (err instanceof Error ? err.message : String(err)));
    return null;
  });
  const coverage = (graphFinalization?.['coverage'] ?? null) as Record<string, unknown> | null;

  // Build markdown report
  const reportLines: string[] = [
    `# ReverseForge AI Studio Report`,
    `## ${ctx.appName}`,
    '',
    `> Generated by **ReverseForge AI Studio** on ${new Date().toISOString().split('T')[0]}`,
    '',
    '---',
    '',
    '## Executive Summary',
    '',
    `This report documents the reverse engineering analysis of **${ctx.appName}**. `,
    `The crawler visited **${reportPages.length} pages** across **${sourceSessionIds.length} session(s)**, recorded **${networkCallsTotal} API calls**, `,
    `and identified **${ctx.entityModel.entities.length} entities** and **${ctx.workflowModel.workflows.length} workflows**.`,
    '',
    '### Key Findings',
    '',
    `- **Modules Discovered:** ${[...new Set(ctx.entityModel.entities.map((e) => e.primaryModule).filter(Boolean))].join(', ')}`,
    `- **Total Entities:** ${ctx.entityModel.entities.length}`,
    `- **Total Workflows:** ${ctx.workflowModel.workflows.length}`,
    `- **Roles Identified:** ${ctx.permissionMatrix.roles.length}`,
    `- **API Endpoints Recorded:** ${networkCallsTotal}`,
    `- **Pages Analyzed:** ${reportPages.length}`,
    `- **Source Sessions:** ${sourceSessionIds.length}`,
    `- **Analysis Graph:** ${graphContext.nodeCount} nodes, ${graphContext.edgeCount} edges, ${graphContext.findingCount} initial findings`,
    `- **Raw Artifact Files Fed:** ${rawArtifactFileCount}`,
    ...(harBriefing
      ? [
          `- **HAR files:** ${harBriefing.stats.harFiles} (${harBriefing.stats.entries} requests, ${harBriefing.stats.uniqueEndpoints} templated endpoints)`,
          `- **Hosts:** ${harBriefing.stats.uniqueHosts} · XHR/fetch: ${harBriefing.stats.xhrFetchCount}`,
        ]
      : []),
    '',
    '---',
    '',
    '## Application Sitemap',
    '',
  ];

  // Group pages by depth/module
  const pagesByDepth = new Map<number, typeof reportPages>();
  for (const page of reportPages) {
    const key = page.depth;
    if (!pagesByDepth.has(key)) pagesByDepth.set(key, []);
    pagesByDepth.get(key)!.push(page);
  }

  for (const [depth, pages] of [...pagesByDepth.entries()].sort()) {
    reportLines.push(`### Depth ${depth}`, '');
    for (const page of pages) {
      reportLines.push(`- [${page.title || page.url}](${page.url})`);
    }
    reportLines.push('');
  }

  // Module Breakdown
  reportLines.push('---', '', '## Module Breakdown', '');
  const moduleMap = new Map<string, typeof ctx.entityModel.entities>();
  for (const entity of ctx.entityModel.entities) {
    const mod = entity.primaryModule || 'General';
    if (!moduleMap.has(mod)) moduleMap.set(mod, []);
    moduleMap.get(mod)!.push(entity);
  }
  for (const [module, entities] of moduleMap) {
    reportLines.push(`### ${module}`, '');
    reportLines.push('**Entities:** ' + entities.map((e) => e.name).join(', '), '');
  }

  // Page-by-page documentation
  reportLines.push('---', '', '## Page Documentation', '');
  for (const page of reportPages.slice(0, 100)) {
    reportLines.push(`### ${page.title || page.url}`, '');
    reportLines.push(`**URL:** \`${page.url}\`  `);
    reportLines.push(`**Depth:** ${page.depth}  `);
    if (page.loadTimeMs) reportLines.push(`**Load Time:** ${page.loadTimeMs.toFixed(0)}ms  `);
    reportLines.push('');

    if (page.extractedData) {
      try {
        const data = JSON.parse(page.extractedData) as {
          navigation?: { buttons?: string[]; tabs?: string[] };
          forms?: Array<{ title?: string; fields?: Array<{ label: string; type: string; required: boolean }> }>;
          tables?: Array<{ title?: string; columns?: Array<{ header: string }> }>;
        };

        if (data.navigation?.buttons?.length) {
          reportLines.push('**Actions:** ' + data.navigation.buttons.slice(0, 10).join(', '), '');
        }

        if (data.forms?.length) {
          reportLines.push('**Forms:**', '');
          for (const form of data.forms) {
            if (form.fields?.length) {
              reportLines.push(`*${form.title || 'Form'}*`);
              reportLines.push('| Field | Type | Required |', '|-------|------|----------|');
              form.fields.slice(0, 20).forEach((f) => {
                reportLines.push(`| ${f.label || '-'} | ${f.type} | ${f.required ? 'Yes' : 'No'} |`);
              });
              reportLines.push('');
            }
          }
        }

        if (data.tables?.length) {
          reportLines.push('**Tables:**', '');
          for (const table of data.tables) {
            if (table.columns?.length) {
              reportLines.push(`*${table.title || 'Table'}*`);
              reportLines.push('Columns: ' + table.columns.map((c) => c.header).filter(Boolean).join(', '));
              reportLines.push('');
            }
          }
        }
      } catch {
        // skip
      }
    }

    if (page.aiAnalysis) {
      try {
        const ai = JSON.parse(page.aiAnalysis) as {
          businessModule?: string;
          primaryEntity?: string;
          pagePurpose?: string;
          workflowStage?: string;
        };
        reportLines.push(
          `**AI Analysis:** ${ai.businessModule} / ${ai.primaryEntity} — ${ai.pagePurpose}  `,
          `**Workflow Stage:** ${ai.workflowStage}`,
          '',
        );
      } catch {
        // skip
      }
    }
  }

  // API Inventory
  reportLines.push('---', '', '## API Inventory', '');
  const topApiCalls = await prisma.networkCall.findMany({
    where: { crawlSessionId: { in: sourceSessionIds } },
    take: 100,
    orderBy: { createdAt: 'asc' },
  });
  reportLines.push(`Total API calls recorded: **${networkCallsTotal}**`, '');
  reportLines.push('| Method | URL | Status | Time (ms) |', '|--------|-----|--------|-----------|');
  for (const call of topApiCalls) {
    const url = call.url.length > 80 ? call.url.slice(0, 77) + '...' : call.url;
    reportLines.push(`| ${call.method ?? ''} | \`${url}\` | ${call.responseStatus ?? ''} | ${call.timingMs?.toFixed(0) ?? ''} |`);
  }
  if (networkCallsTotal > 100) {
    reportLines.push(`\n*... and ${networkCallsTotal - 100} more (see api/ directory for full list)*`);
  }
  reportLines.push('');

  appendDeepResearchSections(reportLines, harBriefing, deepResearch);

  // Entity Relationship Model — with Mermaid ER diagram
  reportLines.push('---', '', '## Entity Relationship Model', '');

  const erDiagram = entityModelToErDiagram(ctx.entityModel.entities);
  if (erDiagram) {
    reportLines.push('### Entity Diagram', '', erDiagram, '');
  }

  for (const entity of ctx.entityModel.entities) {
    reportLines.push(`### ${entity.name}`, '');
    reportLines.push(`*${entity.description}*`, '');
    if (entity.fields.length > 0) {
      reportLines.push('| Field | Type | Required |', '|-------|------|----------|');
      entity.fields.forEach((f) => {
        reportLines.push(`| ${f.name} | ${f.type} | ${f.required ? 'Yes' : 'No'} |`);
      });
      reportLines.push('');
    }
    if (entity.relationships.length > 0) {
      reportLines.push('**Relationships:**');
      entity.relationships.forEach((r) => {
        reportLines.push(`- ${r.type} → **${r.entity}**`);
      });
      reportLines.push('');
    }
    if (entity.hasStatus && entity.statusValues.length > 0) {
      reportLines.push('**Status Values:** ' + entity.statusValues.join(', '), '');
    }
  }

  // Workflow Model — with Mermaid state diagrams
  reportLines.push('---', '', '## Workflow Model', '');
  for (const workflow of ctx.workflowModel.workflows) {
    reportLines.push(`### ${workflow.name}`, '');
    reportLines.push(`*${workflow.description}*  `);
    reportLines.push(`**Entity:** ${workflow.entityName}  `);
    reportLines.push(`**Actors:** ${workflow.actors.join(', ')}  `);
    reportLines.push(`**States:** ${workflow.states.join(' → ')}`, '');

    const stateDiagram = workflowToStateDiagram(workflow);
    if (stateDiagram) {
      reportLines.push(stateDiagram, '');
    }

    if (workflow.transitions.length > 0) {
      reportLines.push('**Transitions:**', '');
      reportLines.push('| From | To | Trigger | Actor | Approval |', '|------|-----|---------|-------|----------|');
      workflow.transitions.forEach((t) => {
        reportLines.push(`| ${t.from} | ${t.to} | ${t.trigger} | ${t.actor} | ${t.approvalRequired ? 'Yes' : 'No'} |`);
      });
      reportLines.push('');
    }
  }

  // Permission Matrix
  reportLines.push('---', '', '## Permission Matrix', '');
  reportLines.push('| Role | Module | View | Create | Edit | Delete | Approve | Export |', '|------|--------|------|--------|------|--------|---------|--------|');
  for (const role of ctx.permissionMatrix.roles) {
    for (const perm of (role.permissions ?? []).slice(0, 5)) {
      reportLines.push(
        `| ${role.name} | ${perm.module} | ${perm.view ? '✓' : '✗'} | ${perm.create ? '✓' : '✗'} | ${perm.edit ? '✓' : '✗'} | ${perm.delete ? '✓' : '✗'} | ${perm.approve ? '✓' : '✗'} | ${perm.export ? '✓' : '✗'} |`,
      );
    }
  }
  reportLines.push('');

  // ── Architecture inference & knowledge graph ─────────────────────────────
  let architectureAnalysis: ArchitectureAnalysis | null = null;
  if (!hooks.resume?.skipArchitecture) {
    await hooks.onStageStart?.('architecture-and-kg', 'Architecture inference & knowledge graph');
    if (ctx.llmConfig) {
      architectureAnalysis = await inferArchitecture(
        ctx.sessionId, ctx.llmConfig, ctx.appName, reportsDir, sourceSessionIds,
      ).catch(() => null);

      await buildKnowledgeGraph(
        ctx.sessionId, ctx.entityModel.entities, ctx.llmConfig, ctx.appName, reportsDir, sourceSessionIds,
      ).catch(() => undefined);
    } else {
      await buildKnowledgeGraph(
        ctx.sessionId, ctx.entityModel.entities, undefined, ctx.appName, reportsDir, sourceSessionIds,
      ).catch(() => undefined);
    }
    await hooks.onStageComplete?.(
      'architecture-and-kg',
      architectureAnalysis ? 'Architecture & knowledge graph complete' : 'Knowledge graph complete',
      architectureAnalysis ? { architecturePath: path.join(reportsDir, 'architecture.json') } : undefined,
    );
  } else {
    logger.info('[Generation] Skipping architecture-and-kg (checkpoint)');
    architectureAnalysis = fileExists(path.join(reportsDir, 'architecture.json'))
      ? readJson<ArchitectureAnalysis>(path.join(reportsDir, 'architecture.json'))
      : null;
  }

  // Append architecture section if available
  if (architectureAnalysis) {
    reportLines.push('---', '', '## Technical Architecture', '');
    reportLines.push(`| Property | Value |`, `|----------|-------|`);
    Object.entries(architectureAnalysis).forEach(([k, v]) => {
      if (Array.isArray(v)) reportLines.push(`| ${k} | ${v.join(', ')} |`);
      else reportLines.push(`| ${k} | ${String(v)} |`);
    });
    reportLines.push('');
  }

  appendCoverageSection(reportLines, coverage);
  await appendAnalysisGraphFindings(reportLines, ctx.sessionId);

  let expertAnalysis: ExpertReportAnalysis | null = null;
  if (!hooks.resume?.skipExpert) {
    await hooks.onStageStart?.('expert-analysis', 'Expert evidence analysis');
    expertAnalysis = await retryUntilSuccess(
      () => runExpertReportAnalysis(ctx, networkCallsTotal, reportsDir, hooks.onStageProgress),
      { label: 'Expert report analysis stage', delayMs: 15_000, maxDelayMs: 180_000 },
    );
    await hooks.onStageComplete?.(
      'expert-analysis',
      expertAnalysis ? 'Expert analysis complete' : 'Expert analysis skipped/failed',
      expertAnalysis ? { expertAnalysisPath: path.join(reportsDir, 'expert-analysis.json') } : undefined,
    );
  } else {
    logger.info('[Generation] Skipping expert-analysis (checkpoint)');
    expertAnalysis = fileExists(path.join(reportsDir, 'expert-analysis.json'))
      ? readJson<ExpertReportAnalysis>(path.join(reportsDir, 'expert-analysis.json'))
      : null;
  }

  if (expertAnalysis) {
    appendExpertAnalysis(reportLines, expertAnalysis);
  }

  await hooks.onStageStart?.('final-report', 'Writing final report');

  const reportContent = reportLines.join('\n');

  // Write main report
  const reportPath = path.join(reportsDir, 'final-report.md');
  writeText(reportPath, reportContent);

  // Write supporting files
  writeJson(path.join(reportsDir, 'entity-model.json'), ctx.entityModel);
  writeJson(path.join(reportsDir, 'workflow-model.json'), ctx.workflowModel);
  writeText(path.join(reportsDir, 'permission-matrix.csv'), permissionMatrixToCsv(ctx.permissionMatrix));

  await writeRedevelopmentBundle({
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    sourceSessionIds,
    appName: ctx.appName,
    reportsDir,
    entityModel: ctx.entityModel,
    workflowModel: ctx.workflowModel,
    permissionMatrix: ctx.permissionMatrix,
    architectureAvailable: Boolean(architectureAnalysis),
    deepResearchAvailable: Boolean(deepResearch || harBriefing),
  });

  // Generate PDF placeholder using Playwright
  await generatePdf(reportPath, path.join(reportsDir, 'final-report.pdf')).catch((err) => {
    logger.warn('PDF generation skipped: ' + (err instanceof Error ? err.message : String(err)));
  });

  // Record in DB
  await prisma.report.create({
    data: {
      projectId: ctx.projectId,
      crawlSessionId: ctx.sessionId,
      type: 'full',
      filePath: path.relative(process.cwd(), reportPath),
    },
  });

  const runManifest = writeReportRunManifest({
    reportsDir,
    ctx,
    startedAt,
    graphContext,
    graphFinalization,
    rawArtifactFileCount,
    architectureAvailable: Boolean(architectureAnalysis),
    expertAnalysisAvailable: Boolean(expertAnalysis),
    deepResearchAvailable: Boolean(deepResearch || harBriefing),
    reportPath,
  });

  if (runManifest.missingRequiredArtifacts.length > 0) {
    throw new Error(`Required report artifacts missing: ${runManifest.missingRequiredArtifacts.join(', ')}`);
  }

  await hooks.onStageComplete?.('final-report', 'Final report written');

  logger.info(`Report generated: ${reportPath}`);
  return reportPath;
}

async function generatePdf(markdownPath: string, pdfPath: string): Promise<void> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const markdownContent = fs.readFileSync(markdownPath, 'utf-8');
  const { marked } = await import('marked');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; font-size: 12px; }
  h1 { color: #1a1a2e; border-bottom: 2px solid #1a1a2e; }
  h2 { color: #16213e; border-bottom: 1px solid #ddd; }
  h3 { color: #0f3460; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  th, td { border: 1px solid #ddd; padding: 6px; text-align: left; font-size: 11px; }
  th { background: #f4f4f4; }
  code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; }
  pre { background: #f4f4f4; padding: 10px; overflow: auto; }
</style>
</head>
<body>${await marked(markdownContent)}</body>
</html>`;

  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.pdf({ path: pdfPath, format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' } });
  await browser.close();
}
