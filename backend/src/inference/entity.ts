import { prisma } from '../database/client';
import { config } from '../config';
import { createLLMClient, isLLMConfigured, type LLMConfig } from '../ai/llm';
import { buildEntityInferencePrompt } from '../ai/prompts';
import { getSessionAnalyses, getProjectAnalyses, getAnalysesForSessions, type PageAnalysisResult } from '../ai/analyzer';
import { materializePageAnalysisWorkspace } from '../ai/synthesis-workspace';
import { runSynthesisAgent } from '../ai/synthesis-agent';
import { logger } from '../utils/logger';

export interface EntityField {
  name: string;
  type: string;
  label: string;
  required: boolean;
  unique: boolean;
  defaultValue: unknown;
  options?: string[];
  relatedEntity?: string;
}

export interface EntityRelationship {
  type: 'hasMany' | 'belongsTo' | 'belongsToMany' | 'hasOne';
  entity: string;
  foreignKey?: string;
  through?: string;
}

export interface Entity {
  name: string;
  pluralName: string;
  description: string;
  fields: EntityField[];
  relationships: EntityRelationship[];
  primaryModule: string;
  hasStatus: boolean;
  statusValues: string[];
  hasAuditFields: boolean;
  isLookup: boolean;
  estimatedRecordCount?: string;
}

export interface EntityModel {
  entities: Entity[];
}

async function resolveProjectSlug(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { slug: true },
  });
  return project?.slug ?? null;
}

/**
 * Infer entities from AI page analyses. Uses a local file-tool agent when enabled,
 * otherwise one-shot chatJson, then aggregation fallback.
 */
export async function inferEntities(
  sessionId: string,
  projectId: string,
  llmConfig?: LLMConfig,
  appName?: string,
  sourceSessionIds?: string[],
): Promise<EntityModel> {
  const analyses = sourceSessionIds?.length
    ? await getAnalysesForSessions(sourceSessionIds)
    : await getProjectAnalyses(projectId);
  const sessionAnalyses = analyses.length > 0 ? analyses : await getSessionAnalyses(sessionId);

  let entityModel: EntityModel;

  if (isLLMConfigured(llmConfig) && sessionAnalyses.length > 0) {
    try {
      if (config.llm.synthesisAgentEnabled) {
        const projectSlug = await resolveProjectSlug(projectId);
        if (!projectSlug) throw new Error('Project slug not found for synthesis workspace');

        const workspace = await materializePageAnalysisWorkspace({
          projectId,
          projectSlug,
          sessionId,
          sourceSessionIds,
        });

        const { artifact, steps } = await runSynthesisAgent<EntityModel>({
          workspace,
          task: 'entity',
          expectedArtifact: 'entity-model.json',
          appName,
          llmConfig,
        });

        if (!artifact.entities || !Array.isArray(artifact.entities)) {
          throw new Error('entity-model.json missing entities[]');
        }

        logger.info(`[Entity] Synthesis agent completed in ${steps} steps (${artifact.entities.length} entities)`);
        entityModel = normalizeEntityModel(artifact);
      } else {
        const llm = createLLMClient(llmConfig);
        entityModel = normalizeEntityModel(
          await llm.chatJson<EntityModel>(
            [
              {
                role: 'system',
                content:
                  'You are an expert enterprise data modeler. Infer a complete, de-duplicated entity model from web application page analyses.',
              },
              { role: 'user', content: buildEntityInferencePrompt(sessionAnalyses, appName) },
            ],
            { maxTokens: 6000 },
          ),
        );
      }
    } catch (err) {
      logger.error('LLM entity inference failed, using aggregation fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      entityModel = aggregateEntities(sessionAnalyses);
    }
  } else {
    entityModel = aggregateEntities(sessionAnalyses);
  }

  entityModel = normalizeEntityModel(entityModel);

  for (const entity of entityModel.entities) {
    const fieldsJson = JSON.stringify(entity.fields ?? []);
    const relationshipsJson = JSON.stringify(entity.relationships ?? []);
    await prisma.entityModel.upsert({
      where: {
        id: `${projectId}-${entity.name}`.toLowerCase().replace(/\s/g, '-'),
      },
      create: {
        id: `${projectId}-${entity.name}`.toLowerCase().replace(/\s/g, '-'),
        projectId,
        name: entity.name,
        fields: fieldsJson,
        relationships: relationshipsJson,
        source: sessionId,
      },
      update: {
        fields: fieldsJson,
        relationships: relationshipsJson,
        source: sessionId,
      },
    });
  }

  return entityModel;
}

/** Coerce agent/LLM variants (attributes, from/to edges) into the canonical EntityModel. */
export function normalizeEntityModel(raw: EntityModel | Record<string, unknown>): EntityModel {
  const root = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root['entities']) ? (root['entities'] as Record<string, unknown>[]) : [];

  const entities: Entity[] = list.flatMap((item) => {
      const name = String(item['name'] ?? '').trim();
      if (!name) return [];

      const rawFields = Array.isArray(item['fields'])
        ? item['fields']
        : Array.isArray(item['attributes'])
          ? item['attributes']
          : [];

      const fields: EntityField[] = (rawFields as Record<string, unknown>[]).map((f) => ({
        name: String(f['name'] ?? f['field'] ?? 'unknown'),
        type: String(f['type'] ?? 'string'),
        label: String(f['label'] ?? f['name'] ?? f['field'] ?? ''),
        required: Boolean(f['required']),
        unique: Boolean(f['unique']),
        defaultValue: f['defaultValue'] ?? null,
        options: Array.isArray(f['options']) ? (f['options'] as string[]) : undefined,
        relatedEntity:
          typeof f['relatedEntity'] === 'string'
            ? f['relatedEntity']
            : typeof f['target'] === 'string'
              ? f['target']
              : undefined,
      }));

      const rawRels = Array.isArray(item['relationships']) ? (item['relationships'] as Record<string, unknown>[]) : [];
      const relationships: EntityRelationship[] = rawRels.flatMap((r) => {
          const type = String(r['type'] ?? 'belongsTo') as EntityRelationship['type'];
          const entity =
            typeof r['entity'] === 'string'
              ? r['entity']
              : typeof r['to'] === 'string'
                ? r['to']
                : typeof r['target'] === 'string'
                  ? r['target']
                  : '';
          if (!entity) return [];
          return [{
            type: (['hasMany', 'belongsTo', 'belongsToMany', 'hasOne'].includes(type)
              ? type
              : 'belongsTo') as EntityRelationship['type'],
            entity,
            foreignKey: typeof r['foreignKey'] === 'string' ? r['foreignKey'] : undefined,
            through: typeof r['through'] === 'string' ? r['through'] : undefined,
          }];
        });

      const statusField = fields.find((f) => /status/i.test(f.name));
      return [{
        name,
        pluralName: String(item['pluralName'] ?? `${name}s`),
        description: String(item['description'] ?? ''),
        fields,
        relationships,
        primaryModule: String(item['primaryModule'] ?? item['module'] ?? 'General'),
        hasStatus: Boolean(item['hasStatus'] ?? !!statusField),
        statusValues: Array.isArray(item['statusValues'])
          ? (item['statusValues'] as string[])
          : statusField?.options ?? [],
        hasAuditFields: Boolean(
          item['hasAuditFields'] ?? fields.some((f) => /created|updated|audit/i.test(f.name)),
        ),
        isLookup: Boolean(item['isLookup']),
        estimatedRecordCount:
          typeof item['estimatedRecordCount'] === 'string' ? item['estimatedRecordCount'] : undefined,
      }];
    });

  return { entities };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

function aggregateEntities(analyses: PageAnalysisResult[]): EntityModel {
  const entityMap = new Map<string, Partial<Entity>>();

  for (const analysis of analyses) {
    if (!analysis?.primaryEntity) continue;

    const name = String(analysis.primaryEntity).trim();
    if (!name) continue;

    if (!entityMap.has(name)) {
      entityMap.set(name, {
        name,
        pluralName: name + 's',
        description: analysis.pagePurpose ?? '',
        fields: [],
        relationships: [],
        primaryModule: analysis.businessModule ?? '',
        hasStatus: false,
        statusValues: [],
        hasAuditFields: true,
        isLookup: false,
      });
    }

    const entity = entityMap.get(name)!;

    for (const field of asArray<PageAnalysisResult['nocobaseFields'][number]>(analysis.nocobaseFields)) {
      if (!field?.field) continue;
      if (field.collection === name || !field.collection) {
        const exists = entity.fields!.some((f) => f.name === field.field);
        if (!exists) {
          entity.fields!.push({
            name: field.field,
            type: field.type ?? 'string',
            label: field.field,
            required: false,
            unique: false,
            defaultValue: null,
            options: Array.isArray(field.options) ? field.options : undefined,
          });
        }
      }
    }

    for (const rel of asArray<PageAnalysisResult['relationships'][number]>(analysis.relationships)) {
      if (!rel?.from || !rel?.to) continue;
      if (rel.from === name) {
        const exists = entity.relationships!.some((r) => r.entity === rel.to);
        if (!exists) {
          entity.relationships!.push({
            type: (rel.type as EntityRelationship['type']) || 'belongsTo',
            entity: rel.to,
          });
        }
      }
    }
  }

  return { entities: Array.from(entityMap.values()) as Entity[] };
}
