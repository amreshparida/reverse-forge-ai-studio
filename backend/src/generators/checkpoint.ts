import path from 'path';
import { ensureDir, fileExists, readJson, writeJson, getProjectOutputDir, getReportsDir } from '../utils/file-system';
import type { EntityModel } from '../inference/entity';
import type { WorkflowModel } from '../inference/workflow';
import type { PermissionMatrix } from '../inference/permissions';

export const GENERATION_STAGES = [
  { id: 'page-analysis', label: 'Page AI analysis', progress: 12 },
  { id: 'entity-inference', label: 'Entity inference', progress: 26 },
  { id: 'workflow-inference', label: 'Workflow inference', progress: 38 },
  { id: 'permission-inference', label: 'Permission inference', progress: 48 },
  { id: 'graph-indexing', label: 'Analysis graph indexing', progress: 56 },
  { id: 'specialist-agents', label: 'Specialist graph agents', progress: 66 },
  { id: 'deep-research', label: 'Deep network research', progress: 76 },
  { id: 'architecture-and-kg', label: 'Architecture & knowledge graph', progress: 84 },
  { id: 'expert-analysis', label: 'Expert evidence analysis', progress: 94 },
  { id: 'final-report', label: 'Final report writing', progress: 100 },
] as const;

export type GenerationStageId = (typeof GENERATION_STAGES)[number]['id'];
export type GenerationStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed';

export interface GenerationCheckpoint {
  version: 1;
  projectId: string;
  projectSlug: string;
  appName: string;
  sessionId: string;
  sourceSessionIds: string[];
  status: GenerationStatus;
  currentStage: GenerationStageId | null;
  completedStages: GenerationStageId[];
  progress: number;
  stageLabel: string;
  message: string;
  error?: string | null;
  reportPath?: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string | null;
  /** Relative progress within the current stage (0–1), used for expert chunks etc. */
  stageFraction?: number;
  artifacts: {
    entityModelPath?: string;
    workflowModelPath?: string;
    permissionMatrixPath?: string;
    architecturePath?: string;
    expertAnalysisPath?: string;
    harIntelligencePath?: string;
    deepResearchPath?: string;
  };
}

export interface GenerationProgressEvent {
  projectId: string;
  status: GenerationStatus;
  progress: number;
  currentStage: GenerationStageId | null;
  stageLabel: string;
  message: string;
  completedStages: GenerationStageId[];
  error?: string | null;
  canResume: boolean;
  jobActive: boolean;
  updatedAt: string;
  reportPath?: string | null;
}

const CHECKPOINT_FILENAME = 'generation-checkpoint.json';
const STALE_RUNNING_MS = 90_000;

export function getCheckpointPath(projectSlug: string): string {
  return path.join(getProjectOutputDir(projectSlug), CHECKPOINT_FILENAME);
}

export function getStageCheckpointDir(projectSlug: string, sessionId: string): string {
  return ensureDir(path.join(getReportsDir(projectSlug, sessionId), '_generation'));
}

export function stageArtifactPath(projectSlug: string, sessionId: string, name: string): string {
  return path.join(getStageCheckpointDir(projectSlug, sessionId), name);
}

export function readCheckpoint(projectSlug: string): GenerationCheckpoint | null {
  return readJson<GenerationCheckpoint>(getCheckpointPath(projectSlug));
}

export function writeCheckpoint(checkpoint: GenerationCheckpoint): GenerationCheckpoint {
  const next: GenerationCheckpoint = {
    ...checkpoint,
    updatedAt: new Date().toISOString(),
  };
  writeJson(getCheckpointPath(next.projectSlug), next);
  // Mirror into the session reports folder for auditability
  try {
    writeJson(path.join(getReportsDir(next.projectSlug, next.sessionId), CHECKPOINT_FILENAME), next);
  } catch {
    // non-fatal
  }
  return next;
}

export function createFreshCheckpoint(args: {
  projectId: string;
  projectSlug: string;
  appName: string;
  sessionId: string;
  sourceSessionIds: string[];
}): GenerationCheckpoint {
  const now = new Date().toISOString();
  return {
    version: 1,
    projectId: args.projectId,
    projectSlug: args.projectSlug,
    appName: args.appName,
    sessionId: args.sessionId,
    sourceSessionIds: args.sourceSessionIds,
    status: 'running',
    currentStage: null,
    completedStages: [],
    progress: 0,
    stageLabel: 'Starting',
    message: 'Report generation started',
    error: null,
    reportPath: null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    stageFraction: 0,
    artifacts: {},
  };
}

export function isStageCompleted(checkpoint: GenerationCheckpoint, stageId: GenerationStageId): boolean {
  return checkpoint.completedStages.includes(stageId);
}

export function markStageStarted(
  checkpoint: GenerationCheckpoint,
  stageId: GenerationStageId,
  message?: string,
): GenerationCheckpoint {
  const stage = GENERATION_STAGES.find((s) => s.id === stageId)!;
  const prevIdx = GENERATION_STAGES.findIndex((s) => s.id === stageId);
  const prevProgress = prevIdx <= 0 ? 0 : GENERATION_STAGES[prevIdx - 1]!.progress;
  return writeCheckpoint({
    ...checkpoint,
    status: 'running',
    currentStage: stageId,
    progress: Math.max(checkpoint.progress, prevProgress),
    stageLabel: stage.label,
    message: message ?? `Running: ${stage.label}`,
    error: null,
    stageFraction: 0,
  });
}

export function markStageCompleted(
  checkpoint: GenerationCheckpoint,
  stageId: GenerationStageId,
  message?: string,
  artifactPatch?: Partial<GenerationCheckpoint['artifacts']>,
): GenerationCheckpoint {
  const stage = GENERATION_STAGES.find((s) => s.id === stageId)!;
  const completed = checkpoint.completedStages.includes(stageId)
    ? checkpoint.completedStages
    : [...checkpoint.completedStages, stageId];
  return writeCheckpoint({
    ...checkpoint,
    status: 'running',
    currentStage: stageId,
    completedStages: completed,
    progress: stage.progress,
    stageLabel: stage.label,
    message: message ?? `Completed: ${stage.label}`,
    stageFraction: 1,
    artifacts: { ...checkpoint.artifacts, ...artifactPatch },
  });
}

export function markGenerationCompleted(
  checkpoint: GenerationCheckpoint,
  reportPath: string,
): GenerationCheckpoint {
  return writeCheckpoint({
    ...checkpoint,
    status: 'completed',
    currentStage: 'final-report',
    completedStages: GENERATION_STAGES.map((s) => s.id),
    progress: 100,
    stageLabel: 'Final report writing',
    message: 'Report generation completed',
    reportPath,
    finishedAt: new Date().toISOString(),
    error: null,
    stageFraction: 1,
  });
}

export function markGenerationFailed(
  checkpoint: GenerationCheckpoint,
  error: string,
): GenerationCheckpoint {
  return writeCheckpoint({
    ...checkpoint,
    status: 'failed',
    message: 'Report generation failed',
    error,
    finishedAt: new Date().toISOString(),
  });
}

export function markGenerationPaused(
  checkpoint: GenerationCheckpoint,
  reason?: string,
): GenerationCheckpoint {
  return writeCheckpoint({
    ...checkpoint,
    status: 'paused',
    message: reason ?? 'Generation paused — resume to continue from the last checkpoint',
    finishedAt: null,
  });
}

export function updateStageFraction(
  checkpoint: GenerationCheckpoint,
  fraction: number,
  message?: string,
): GenerationCheckpoint {
  const stage = checkpoint.currentStage
    ? GENERATION_STAGES.find((s) => s.id === checkpoint.currentStage)
    : null;
  if (!stage) return checkpoint;
  const idx = GENERATION_STAGES.findIndex((s) => s.id === stage.id);
  const prev = idx <= 0 ? 0 : GENERATION_STAGES[idx - 1]!.progress;
  const span = stage.progress - prev;
  const progress = Math.min(stage.progress, prev + span * Math.max(0, Math.min(1, fraction)));
  return writeCheckpoint({
    ...checkpoint,
    progress,
    stageFraction: fraction,
    message: message ?? checkpoint.message,
  });
}

export function toProgressEvent(
  checkpoint: GenerationCheckpoint | null,
  jobActive: boolean,
): GenerationProgressEvent {
  if (!checkpoint) {
    return {
      projectId: '',
      status: 'idle',
      progress: 0,
      currentStage: null,
      stageLabel: 'Idle',
      message: 'No generation in progress',
      completedStages: [],
      canResume: false,
      jobActive: false,
      updatedAt: new Date().toISOString(),
    };
  }

  let status = checkpoint.status;
  if (status === 'running' && !jobActive) {
    const age = Date.now() - new Date(checkpoint.updatedAt).getTime();
    if (age > STALE_RUNNING_MS) {
      status = 'paused';
    }
  }

  return {
    projectId: checkpoint.projectId,
    status,
    progress: checkpoint.progress,
    currentStage: checkpoint.currentStage,
    stageLabel: checkpoint.stageLabel,
    message: checkpoint.message,
    completedStages: checkpoint.completedStages,
    error: checkpoint.error,
    canResume: status === 'paused' || status === 'failed',
    jobActive,
    updatedAt: checkpoint.updatedAt,
    reportPath: checkpoint.reportPath,
  };
}

/** On server boot: any "running" checkpoint becomes paused so the UI can offer Resume. */
export function reconcileStaleCheckpoints(projectSlug: string): GenerationCheckpoint | null {
  const checkpoint = readCheckpoint(projectSlug);
  if (!checkpoint) return null;
  if (checkpoint.status === 'running') {
    return markGenerationPaused(checkpoint, 'Backend stopped while generation was running — click Resume to continue');
  }
  return checkpoint;
}

export function loadEntityModelArtifact(projectSlug: string, sessionId: string, checkpoint: GenerationCheckpoint): EntityModel | null {
  const p = checkpoint.artifacts.entityModelPath
    ?? stageArtifactPath(projectSlug, sessionId, 'entity-model.json');
  return fileExists(p) ? readJson<EntityModel>(p) : null;
}

export function loadWorkflowModelArtifact(projectSlug: string, sessionId: string, checkpoint: GenerationCheckpoint): WorkflowModel | null {
  const p = checkpoint.artifacts.workflowModelPath
    ?? stageArtifactPath(projectSlug, sessionId, 'workflow-model.json');
  return fileExists(p) ? readJson<WorkflowModel>(p) : null;
}

export function loadPermissionMatrixArtifact(projectSlug: string, sessionId: string, checkpoint: GenerationCheckpoint): PermissionMatrix | null {
  const p = checkpoint.artifacts.permissionMatrixPath
    ?? stageArtifactPath(projectSlug, sessionId, 'permission-matrix.json');
  return fileExists(p) ? readJson<PermissionMatrix>(p) : null;
}

export function saveStageArtifact(projectSlug: string, sessionId: string, name: string, data: unknown): string {
  const filePath = stageArtifactPath(projectSlug, sessionId, name);
  writeJson(filePath, data);
  return filePath;
}
