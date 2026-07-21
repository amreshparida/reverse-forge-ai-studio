import { analyzeSession } from '../ai/analyzer';
import { inferEntities, type EntityModel } from '../inference/entity';
import { inferWorkflows, type WorkflowModel } from '../inference/workflow';
import { inferPermissions, type PermissionMatrix } from '../inference/permissions';
import { generateFullReport } from './report';
import { generationProgressBus } from './progress-bus';
import {
  createFreshCheckpoint,
  isStageCompleted,
  loadEntityModelArtifact,
  loadPermissionMatrixArtifact,
  loadWorkflowModelArtifact,
  markGenerationCompleted,
  markGenerationFailed,
  markGenerationPaused,
  markStageCompleted,
  markStageStarted,
  readCheckpoint,
  saveStageArtifact,
  toProgressEvent,
  updateStageFraction,
  writeCheckpoint,
  type GenerationCheckpoint,
  type GenerationStageId,
} from './checkpoint';
import type { LLMConfig } from '../ai/llm';
import { logger } from '../utils/logger';
import { jobQueue } from '../queue/job-queue';

export interface RunGenerationArgs {
  projectId: string;
  projectSlug: string;
  appName: string;
  sessionId: string;
  sourceSessionIds: string[];
  llmConfig: LLMConfig;
  /** When true, continue from existing checkpoint instead of starting fresh */
  resume?: boolean;
  /** Job id used to detect whether generation is actively running */
  jobId?: string;
  updateProgress?: (progress: number) => void;
}

function emit(checkpoint: GenerationCheckpoint, jobId?: string): void {
  const jobActive = Boolean(jobId && jobQueue.getJob(jobId)?.status === 'active');
  generationProgressBus.emitProgress(toProgressEvent(checkpoint, jobActive));
}

function syncJobProgress(checkpoint: GenerationCheckpoint, updateProgress?: (n: number) => void): void {
  updateProgress?.(checkpoint.progress);
}

async function beginStage(
  checkpoint: GenerationCheckpoint,
  stageId: GenerationStageId,
  message: string,
  args: RunGenerationArgs,
): Promise<GenerationCheckpoint> {
  const next = markStageStarted(checkpoint, stageId, message);
  syncJobProgress(next, args.updateProgress);
  emit(next, args.jobId);
  return next;
}

async function completeStage(
  checkpoint: GenerationCheckpoint,
  stageId: GenerationStageId,
  message: string,
  args: RunGenerationArgs,
  artifactPatch?: Partial<GenerationCheckpoint['artifacts']>,
): Promise<GenerationCheckpoint> {
  const next = markStageCompleted(checkpoint, stageId, message, artifactPatch);
  syncJobProgress(next, args.updateProgress);
  emit(next, args.jobId);
  return next;
}

export function getProjectGenerationStatus(projectId: string, projectSlug: string, jobId = `project-report-${projectId}`) {
  const checkpoint = readCheckpoint(projectSlug);
  const job = jobQueue.getJob(jobId);
  const jobActive = job?.status === 'active' || job?.status === 'waiting';

  // If checkpoint says running but no live job, treat as paused for the API response
  // (without rewriting disk until reconcile/resume).
  const event = toProgressEvent(
    checkpoint
      ? {
          ...checkpoint,
          projectId: checkpoint.projectId || projectId,
        }
      : null,
    Boolean(jobActive),
  );

  if (!checkpoint) {
    return { ...event, projectId };
  }

  return {
    ...event,
    projectId,
    checkpoint,
  };
}

export async function runReportGeneration(args: RunGenerationArgs): Promise<string> {
  const {
    projectId,
    projectSlug,
    appName,
    sessionId,
    sourceSessionIds,
    llmConfig,
    resume = false,
  } = args;

  let checkpoint: GenerationCheckpoint;

  if (resume) {
    const existing = readCheckpoint(projectSlug);
    if (!existing) {
      throw new Error('No generation checkpoint found to resume');
    }
    if (existing.status === 'completed') {
      throw new Error('Generation already completed — start a new extract to regenerate');
    }
    checkpoint = writeCheckpoint({
      ...existing,
      status: 'running',
      message: `Resuming from ${existing.currentStage ?? 'start'}`,
      error: null,
      finishedAt: null,
    });
  } else {
    checkpoint = createFreshCheckpoint({
      projectId,
      projectSlug,
      appName,
      sessionId,
      sourceSessionIds,
    });
    checkpoint = writeCheckpoint(checkpoint);
  }

  emit(checkpoint, args.jobId);
  syncJobProgress(checkpoint, args.updateProgress);

  let entityModel: EntityModel | null = null;
  let workflowModel: WorkflowModel | null = null;
  let permissionMatrix: PermissionMatrix | null = null;

  try {
    // ── 1. Page analysis ────────────────────────────────────────────────
    if (!isStageCompleted(checkpoint, 'page-analysis')) {
      checkpoint = await beginStage(checkpoint, 'page-analysis', 'Analysis agent: page-by-page AI analysis', args);
      for (const sourceSessionId of sourceSessionIds) {
        await analyzeSession(sourceSessionId, llmConfig, appName);
      }
      checkpoint = await completeStage(checkpoint, 'page-analysis', 'Page AI analysis complete', args);
    } else {
      logger.info('[Generation] Skipping page-analysis (checkpoint)');
    }

    // ── 2. Entity inference ─────────────────────────────────────────────
    if (!isStageCompleted(checkpoint, 'entity-inference')) {
      checkpoint = await beginStage(checkpoint, 'entity-inference', 'Data model agent: entity inference', args);
      entityModel = await inferEntities(sourceSessionIds[0] ?? sessionId, projectId, llmConfig, appName);
      const entityPath = saveStageArtifact(projectSlug, sessionId, 'entity-model.json', entityModel);
      checkpoint = await completeStage(
        checkpoint,
        'entity-inference',
        `Entity inference complete (${entityModel.entities.length} entities)`,
        args,
        { entityModelPath: entityPath },
      );
    } else {
      entityModel = loadEntityModelArtifact(projectSlug, sessionId, checkpoint);
      if (!entityModel) {
        entityModel = await inferEntities(sourceSessionIds[0] ?? sessionId, projectId, llmConfig, appName);
        const entityPath = saveStageArtifact(projectSlug, sessionId, 'entity-model.json', entityModel);
        checkpoint = writeCheckpoint({
          ...checkpoint,
          artifacts: { ...checkpoint.artifacts, entityModelPath: entityPath },
        });
      }
      logger.info('[Generation] Skipping entity-inference (checkpoint)');
    }

    // ── 3. Workflow inference ───────────────────────────────────────────
    if (!isStageCompleted(checkpoint, 'workflow-inference')) {
      checkpoint = await beginStage(checkpoint, 'workflow-inference', 'Workflow agent: business workflow inference', args);
      workflowModel = await inferWorkflows(
        sourceSessionIds[0] ?? sessionId,
        projectId,
        entityModel!.entities,
        llmConfig,
        appName,
      );
      const workflowPath = saveStageArtifact(projectSlug, sessionId, 'workflow-model.json', workflowModel);
      checkpoint = await completeStage(
        checkpoint,
        'workflow-inference',
        `Workflow inference complete (${workflowModel.workflows.length} workflows)`,
        args,
        { workflowModelPath: workflowPath },
      );
    } else {
      workflowModel = loadWorkflowModelArtifact(projectSlug, sessionId, checkpoint);
      if (!workflowModel) {
        workflowModel = await inferWorkflows(
          sourceSessionIds[0] ?? sessionId,
          projectId,
          entityModel!.entities,
          llmConfig,
          appName,
        );
        const workflowPath = saveStageArtifact(projectSlug, sessionId, 'workflow-model.json', workflowModel);
        checkpoint = writeCheckpoint({
          ...checkpoint,
          artifacts: { ...checkpoint.artifacts, workflowModelPath: workflowPath },
        });
      }
      logger.info('[Generation] Skipping workflow-inference (checkpoint)');
    }

    // ── 4. Permission inference ─────────────────────────────────────────
    if (!isStageCompleted(checkpoint, 'permission-inference')) {
      checkpoint = await beginStage(checkpoint, 'permission-inference', 'Security/product agent: permission inference', args);
      permissionMatrix = await inferPermissions(
        sourceSessionIds[0] ?? sessionId,
        entityModel!.entities,
        llmConfig,
        appName,
        projectId,
      );
      const permPath = saveStageArtifact(projectSlug, sessionId, 'permission-matrix.json', permissionMatrix);
      checkpoint = await completeStage(
        checkpoint,
        'permission-inference',
        `Permission inference complete (${permissionMatrix.roles.length} roles)`,
        args,
        { permissionMatrixPath: permPath },
      );
    } else {
      permissionMatrix = loadPermissionMatrixArtifact(projectSlug, sessionId, checkpoint);
      if (!permissionMatrix) {
        permissionMatrix = await inferPermissions(
          sourceSessionIds[0] ?? sessionId,
          entityModel!.entities,
          llmConfig,
          appName,
          projectId,
        );
        const permPath = saveStageArtifact(projectSlug, sessionId, 'permission-matrix.json', permissionMatrix);
        checkpoint = writeCheckpoint({
          ...checkpoint,
          artifacts: { ...checkpoint.artifacts, permissionMatrixPath: permPath },
        });
      }
      logger.info('[Generation] Skipping permission-inference (checkpoint)');
    }

    // ── 5–9. Report assembly (graph → specialists → architecture → expert → write)
    const skipGraph = isStageCompleted(checkpoint, 'graph-indexing');
    const skipSpecialists = isStageCompleted(checkpoint, 'specialist-agents');
    const skipArchitecture = isStageCompleted(checkpoint, 'architecture-and-kg');
    const skipExpert = isStageCompleted(checkpoint, 'expert-analysis');
    const skipFinal = isStageCompleted(checkpoint, 'final-report');

    if (skipFinal && checkpoint.reportPath) {
      const donePath = checkpoint.reportPath;
      checkpoint = markGenerationCompleted(checkpoint, donePath);
      emit(checkpoint, args.jobId);
      syncJobProgress(checkpoint, args.updateProgress);
      return donePath;
    }

    const reportPath = await generateFullReport(
      {
        projectId,
        sessionId,
        sourceSessionIds,
        projectSlug,
        appName,
        entityModel: entityModel!,
        workflowModel: workflowModel!,
        permissionMatrix: permissionMatrix!,
        llmConfig,
      },
      {
        resume: {
          skipGraphBuild: skipGraph,
          skipSpecialists,
          skipArchitecture,
          skipExpert,
        },
        onStageStart: async (stageId, message) => {
          checkpoint = await beginStage(checkpoint, stageId, message, args);
        },
        onStageComplete: async (stageId, message, artifactPatch) => {
          checkpoint = await completeStage(checkpoint, stageId, message, args, artifactPatch);
        },
        onStageProgress: async (fraction, message) => {
          checkpoint = updateStageFraction(checkpoint, fraction, message);
          syncJobProgress(checkpoint, args.updateProgress);
          emit(checkpoint, args.jobId);
        },
      },
    );

    checkpoint = markGenerationCompleted(checkpoint, reportPath);
    emit(checkpoint, args.jobId);
    syncJobProgress(checkpoint, args.updateProgress);
    return reportPath;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[Generation] Failed: ' + message);
    checkpoint = markGenerationFailed(checkpoint, message);
    emit(checkpoint, args.jobId);
    throw err;
  }
}

/** Mark any in-flight generation as paused when the process is shutting down / starting up. */
export function pauseRunningGeneration(projectSlug: string, reason?: string): void {
  const checkpoint = readCheckpoint(projectSlug);
  if (checkpoint?.status === 'running') {
    const paused = markGenerationPaused(checkpoint, reason);
    emit(paused);
  }
}
