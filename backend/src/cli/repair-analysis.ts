import path from 'path';
import { prisma } from '../database/client';
import { analyzeSession } from '../ai/analyzer';
import { readCheckpoint, writeCheckpoint, type GenerationCheckpoint } from '../generators/checkpoint';
import { logger } from '../utils/logger';
import type { LLMConfig } from '../ai/llm';

export interface AnalysisGapSession {
  sessionId: string;
  status: string;
  totalPages: number;
  withExtract: number;
  withAi: number;
  missingAiCount: number;
  missingUrls: string[];
}

export async function auditProjectAnalysisGaps(
  projectId: string,
  sessionIds?: string[],
): Promise<AnalysisGapSession[]> {
  const sessions = await prisma.crawlSession.findMany({
    where: {
      projectId,
      ...(sessionIds?.length ? { id: { in: sessionIds } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });

  const results: AnalysisGapSession[] = [];

  for (const session of sessions) {
    const totalPages = await prisma.pageCapture.count({ where: { crawlSessionId: session.id } });
    const withExtract = await prisma.pageCapture.count({
      where: { crawlSessionId: session.id, NOT: { extractedData: null } },
    });
    const withAi = await prisma.pageCapture.count({
      where: { crawlSessionId: session.id, NOT: { aiAnalysis: null } },
    });
    const missing = await prisma.pageCapture.findMany({
      where: {
        crawlSessionId: session.id,
        aiAnalysis: null,
        NOT: { extractedData: null },
      },
      select: { url: true },
      orderBy: { createdAt: 'asc' },
    });

    results.push({
      sessionId: session.id,
      status: session.status,
      totalPages,
      withExtract,
      withAi,
      missingAiCount: missing.length,
      missingUrls: missing.map((m) => m.url),
    });
  }

  return results;
}

/**
 * Re-run page AI analysis only for pages that still lack aiAnalysis.
 * analyzeSession already skips completed pages and retries transient failures.
 */
export async function repairMissingPageAnalysis(args: {
  projectId: string;
  projectSlug: string;
  appName: string;
  llmConfig: LLMConfig;
  sessionIds?: string[];
  dryRun?: boolean;
  redoDownstream?: boolean;
}): Promise<{
  gaps: AnalysisGapSession[];
  repairedSessionIds: string[];
  checkpointUpdated: boolean;
}> {
  const checkpoint = readCheckpoint(args.projectSlug);
  const targetSessionIds =
    args.sessionIds?.length
      ? args.sessionIds
      : checkpoint?.sourceSessionIds?.length
        ? checkpoint.sourceSessionIds
        : undefined;

  const gaps = await auditProjectAnalysisGaps(args.projectId, targetSessionIds);
  const needingRepair = gaps.filter((g) => g.missingAiCount > 0);

  if (args.dryRun) {
    return { gaps, repairedSessionIds: [], checkpointUpdated: false };
  }

  const repairedSessionIds: string[] = [];
  for (const gap of needingRepair) {
    logger.info(
      `[Repair] Re-queuing ${gap.missingAiCount} missing AI page(s) for session ${gap.sessionId}`,
    );
    await analyzeSession(gap.sessionId, args.llmConfig, args.appName);
    repairedSessionIds.push(gap.sessionId);
  }

  let checkpointUpdated = false;
  if (args.redoDownstream && checkpoint && repairedSessionIds.length > 0) {
    writeCheckpoint(resetDownstreamInferenceStages(checkpoint));
    checkpointUpdated = true;
    logger.info(
      '[Repair] Cleared entity/workflow/permission checkpoint stages so they re-run with full page AI',
    );
  }

  return { gaps: await auditProjectAnalysisGaps(args.projectId, targetSessionIds), repairedSessionIds, checkpointUpdated };
}

/** Keep page-analysis; force entity → permission to re-run on resume. */
export function resetDownstreamInferenceStages(checkpoint: GenerationCheckpoint): GenerationCheckpoint {
  const keep = new Set(['page-analysis']);
  const completedStages = checkpoint.completedStages.filter((s) => keep.has(s));

  return {
    ...checkpoint,
    status: 'paused',
    currentStage: 'entity-inference',
    completedStages: completedStages as GenerationCheckpoint['completedStages'],
    progress: 12,
    stageLabel: 'Entity inference',
    message: 'Paused after page-analysis repair — resume to redo entity/workflow/permission',
    error: null,
    finishedAt: null,
    stageFraction: 0,
    artifacts: {
      ...checkpoint.artifacts,
      entityModelPath: undefined,
      workflowModelPath: undefined,
      permissionMatrixPath: undefined,
    },
  };
}

export function formatGapsReport(gaps: AnalysisGapSession[]): string {
  const lines: string[] = [];
  let totalMissing = 0;
  for (const g of gaps) {
    totalMissing += g.missingAiCount;
    lines.push(
      `Session ${g.sessionId} [${g.status}]: ${g.withAi}/${g.withExtract} AI-analyzed, ${g.missingAiCount} missing`,
    );
    for (const url of g.missingUrls) {
      lines.push(`  - ${url}`);
    }
  }
  lines.push(`\nTotal pages missing AI analysis: ${totalMissing}`);
  return lines.join('\n');
}

/** Resolve absolute artifact path helper for logging */
export function checkpointSummary(projectSlug: string): string {
  const cp = readCheckpoint(projectSlug);
  if (!cp) return 'No generation checkpoint';
  return [
    `status=${cp.status}`,
    `currentStage=${cp.currentStage}`,
    `completed=[${cp.completedStages.join(', ')}]`,
    `error=${cp.error ?? '(none)'}`,
    `artifacts=${path.basename(cp.artifacts.entityModelPath ?? '') || '—'} / ${path.basename(cp.artifacts.workflowModelPath ?? '') || '—'}`,
  ].join(' | ');
}
