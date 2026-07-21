import { prisma } from '../database/client';
import { config } from '../config';
import { createLLMClient, isLLMConfigured, type LLMConfig } from '../ai/llm';
import { buildWorkflowInferencePrompt } from '../ai/prompts';
import { getSessionAnalyses, getProjectAnalyses } from '../ai/analyzer';
import { materializePageAnalysisWorkspace, getSynthesisWorkspaceDir } from '../ai/synthesis-workspace';
import { runSynthesisAgent } from '../ai/synthesis-agent';
import { writeJson } from '../utils/file-system';
import { logger } from '../utils/logger';
import type { Entity } from './entity';
import path from 'path';

export interface WorkflowTransition {
  from: string;
  to: string;
  trigger: string;
  actor: string;
  conditions: string[];
  notifications: string[];
  approvalRequired: boolean;
}

export interface Workflow {
  name: string;
  description: string;
  entityName: string;
  states: string[];
  transitions: WorkflowTransition[];
  actors: string[];
  autoTransitions: string[];
  slaHours?: number;
  isApprovalWorkflow: boolean;
}

export interface WorkflowModel {
  workflows: Workflow[];
}

async function resolveProjectSlug(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { slug: true },
  });
  return project?.slug ?? null;
}

export async function inferWorkflows(
  sessionId: string,
  projectId: string,
  entities: Entity[],
  llmConfig?: LLMConfig,
  appName?: string,
): Promise<WorkflowModel> {
  const analyses = await getProjectAnalyses(projectId);
  const sessionAnalyses = analyses.length > 0 ? analyses : await getSessionAnalyses(sessionId);
  let workflowModel: WorkflowModel;

  if (isLLMConfigured(llmConfig) && sessionAnalyses.length > 0) {
    try {
      if (config.llm.synthesisAgentEnabled) {
        const projectSlug = await resolveProjectSlug(projectId);
        if (!projectSlug) throw new Error('Project slug not found for synthesis workspace');

        const workspace = await materializePageAnalysisWorkspace({
          projectId,
          projectSlug,
          sessionId,
        });

        // Ensure entity artifact is available for the agent to read
        writeJson(path.join(workspace.root, 'entity-model.json'), { entities });

        const { artifact, steps } = await runSynthesisAgent<WorkflowModel>({
          workspace,
          task: 'workflow',
          expectedArtifact: 'workflow-model.json',
          appName,
          llmConfig,
        });

        if (!artifact.workflows || !Array.isArray(artifact.workflows)) {
          throw new Error('workflow-model.json missing workflows[]');
        }

        logger.info(`[Workflow] Synthesis agent completed in ${steps} steps (${artifact.workflows.length} workflows)`);
        workflowModel = normalizeWorkflowModel(artifact);
      } else {
        const llm = createLLMClient(llmConfig);
        workflowModel = normalizeWorkflowModel(
          await llm.chatJson<WorkflowModel>(
            [
              {
                role: 'system',
                content:
                  'You are an expert business process analyst. Infer detailed workflows from web application page data.',
              },
              {
                role: 'user',
                content: buildWorkflowInferencePrompt(
                  sessionAnalyses,
                  entities.map((e) => ({ name: e.name, fields: e.fields.map((f) => f.name) })),
                  appName,
                ),
              },
            ],
            { maxTokens: 6000 },
          ),
        );
      }
    } catch (err) {
      logger.error('LLM workflow inference failed, using aggregation fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      workflowModel = aggregateWorkflows(sessionAnalyses, entities);
    }
  } else {
    workflowModel = aggregateWorkflows(sessionAnalyses, entities);
  }

  workflowModel = normalizeWorkflowModel(workflowModel);

  for (const workflow of workflowModel.workflows) {
    const id = `${projectId}-${workflow.name}`.toLowerCase().replace(/[\s\/&]/g, '-').slice(0, 100);
    const statesJson = JSON.stringify(workflow.states ?? []);
    const transitionsJson = JSON.stringify(workflow.transitions ?? []);
    const actorsJson = JSON.stringify(workflow.actors ?? []);
    await prisma.workflowModel.upsert({
      where: { id },
      create: {
        id,
        projectId,
        name: workflow.name,
        entityName: workflow.entityName || 'Unknown',
        states: statesJson,
        transitions: transitionsJson,
        actors: actorsJson,
        source: sessionId,
      },
      update: {
        entityName: workflow.entityName || 'Unknown',
        states: statesJson,
        transitions: transitionsJson,
        actors: actorsJson,
        source: sessionId,
      },
    });
  }

  return workflowModel;
}

/** Coerce agent variants (steps/primaryActors) into the canonical WorkflowModel. */
export function normalizeWorkflowModel(raw: WorkflowModel | Record<string, unknown>): WorkflowModel {
  const root = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root['workflows']) ? (root['workflows'] as Record<string, unknown>[]) : [];

  const workflows: Workflow[] = list
    .map((item) => {
      const name = String(item['name'] ?? '').trim();
      if (!name) return null;

      const steps = Array.isArray(item['steps']) ? (item['steps'] as Record<string, unknown>[]) : [];
      let states = Array.isArray(item['states'])
        ? (item['states'] as unknown[]).map(String).filter(Boolean)
        : [];
      if (states.length === 0 && steps.length > 0) {
        states = steps.map((s) => String(s['name'] ?? s['id'] ?? s['state'] ?? '')).filter(Boolean);
      }

      let transitions: WorkflowTransition[] = [];
      if (Array.isArray(item['transitions'])) {
        transitions = (item['transitions'] as Record<string, unknown>[]).map((t) => ({
          from: String(t['from'] ?? ''),
          to: String(t['to'] ?? ''),
          trigger: String(t['trigger'] ?? t['action'] ?? 'Action'),
          actor: String(t['actor'] ?? 'User'),
          conditions: Array.isArray(t['conditions'])
            ? (t['conditions'] as unknown[]).map(String)
            : Array.isArray(t['preconditions'])
              ? (t['preconditions'] as unknown[]).map(String)
              : [],
          notifications: Array.isArray(t['notifications']) ? (t['notifications'] as unknown[]).map(String) : [],
          approvalRequired: Boolean(t['approvalRequired']),
        }));
      } else if (steps.length > 1) {
        transitions = steps.slice(0, -1).map((step, i) => {
          const next = steps[i + 1]!;
          return {
            from: String(step['name'] ?? step['id'] ?? states[i] ?? ''),
            to: String(next['name'] ?? next['id'] ?? states[i + 1] ?? ''),
            trigger: String(step['action'] ?? step['trigger'] ?? 'Continue'),
            actor: String(step['actor'] ?? 'User'),
            conditions: Array.isArray(step['preconditions'])
              ? (step['preconditions'] as unknown[]).map(String)
              : Array.isArray(step['decisions'])
                ? (step['decisions'] as unknown[]).map(String)
                : [],
            notifications: [],
            approvalRequired: /approv/i.test(String(step['name'] ?? '')),
          };
        });
      } else if (states.length > 1) {
        transitions = states.slice(0, -1).map((state, i) => ({
          from: state,
          to: states[i + 1] ?? state,
          trigger: 'Action',
          actor: 'User',
          conditions: [],
          notifications: [],
          approvalRequired: false,
        }));
      }

      const actors = Array.isArray(item['actors'])
        ? (item['actors'] as unknown[]).map(String)
        : Array.isArray(item['primaryActors'])
          ? (item['primaryActors'] as unknown[]).map(String)
          : [
              ...new Set(
                transitions.map((t) => t.actor).concat(steps.map((s) => String(s['actor'] ?? '')).filter(Boolean)),
              ),
            ];

      const entityName =
        String(item['entityName'] ?? '').trim() ||
        (Array.isArray(item['entitiesInvolved']) && item['entitiesInvolved'][0]
          ? String(item['entitiesInvolved'][0])
          : '') ||
        (steps[0] && Array.isArray(steps[0]['entities']) && steps[0]['entities'][0]
          ? String(steps[0]['entities'][0])
          : '') ||
        'Unknown';

      return {
        name,
        description: String(item['description'] ?? ''),
        entityName,
        states: states.length > 0 ? states : ['Start', 'Complete'],
        transitions,
        actors,
        autoTransitions: Array.isArray(item['autoTransitions'])
          ? (item['autoTransitions'] as unknown[]).map(String)
          : [],
        slaHours: typeof item['slaHours'] === 'number' ? item['slaHours'] : undefined,
        isApprovalWorkflow: Boolean(
          item['isApprovalWorkflow'] ??
            (states.some((s) => /approv|review/i.test(s)) ||
              transitions.some((t) => t.approvalRequired)),
        ),
      } satisfies Workflow;
    })
    .filter((w): w is Workflow => w != null);

  return { workflows };
}

function aggregateWorkflows(
  analyses: Awaited<ReturnType<typeof getSessionAnalyses>>,
  entities: Entity[],
): WorkflowModel {
  const workflows: Workflow[] = [];
  const entityStages = new Map<string, Set<string>>();
  const entityActions = new Map<string, Set<string>>();
  const entityRoles = new Map<string, Set<string>>();

  for (const analysis of analyses) {
    if (!analysis.primaryEntity) continue;
    const entity = analysis.primaryEntity;

    if (!entityStages.has(entity)) {
      entityStages.set(entity, new Set());
      entityActions.set(entity, new Set());
      entityRoles.set(entity, new Set());
    }

    if (analysis.workflowStage) entityStages.get(entity)!.add(analysis.workflowStage);
    (analysis.userActions ?? []).forEach((a) => entityActions.get(entity)!.add(a));
    (analysis.possibleRoles ?? []).forEach((r) => entityRoles.get(entity)!.add(r));
  }

  for (const entity of entities) {
    const stages = Array.from(entityStages.get(entity.name) ?? []);
    if (stages.length < 2) continue;

    const statusField = entity.fields.find((f) => f.name.toLowerCase().includes('status'));
    const states = statusField?.options ?? stages;

    workflows.push({
      name: `${entity.name} Lifecycle`,
      description: `Lifecycle management for ${entity.name} records`,
      entityName: entity.name,
      states,
      transitions: states.slice(0, -1).map((state, i) => ({
        from: state,
        to: states[i + 1] ?? state,
        trigger: 'Action button',
        actor: Array.from(entityRoles.get(entity.name) ?? [])[0] ?? 'User',
        conditions: [],
        notifications: [],
        approvalRequired: false,
      })),
      actors: Array.from(entityRoles.get(entity.name) ?? []),
      autoTransitions: [],
      isApprovalWorkflow: stages.some((s) => /approv|review/i.test(s)),
    });
  }

  return { workflows };
}

/** Re-export for tests / debugging */
export { getSynthesisWorkspaceDir };
