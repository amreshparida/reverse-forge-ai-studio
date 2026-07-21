import { createLLMClient, isLLMConfigured, type LLMConfig } from '../ai/llm';
import { buildNocoBaseBlueprintPrompt } from '../ai/prompts';
import { logger } from '../utils/logger';
import type { EntityModel } from '../inference/entity';
import type { WorkflowModel } from '../inference/workflow';
import type { PermissionMatrix } from '../inference/permissions';

export interface NocoBaseField {
  name: string;
  type: string;
  interface: string;
  uiSchema: Record<string, unknown>;
  required?: boolean;
}

export interface NocoBaseCollection {
  name: string;
  title: string;
  description: string;
  fields: NocoBaseField[];
  indexes: string[];
  timestamps: boolean;
  paranoid: boolean;
}

export interface NocoBaseView {
  title: string;
  type: 'table' | 'form' | 'detail' | 'calendar' | 'kanban' | 'gallery';
  collection: string;
  filters: unknown[];
}

export interface NocoBaseBlueprint {
  recommendedPlugins: string[];
  customPlugins: Array<{ name: string; purpose: string }>;
  collections: NocoBaseCollection[];
  views: NocoBaseView[];
  dashboards: Array<{ title: string; widgets: unknown[] }>;
  importJobs: Array<{ name: string; collection: string; format: string; mapping: Record<string, string> }>;
  effortEstimate: {
    totalWeeks: number;
    phases: Array<{ name: string; weeks: number; tasks: string[] }>;
  };
  risks: string[];
  assumptions: string[];
}

const FIELD_TYPE_MAP: Record<string, { interface: string; uiSchema: Record<string, unknown> }> = {
  string: { interface: 'input', uiSchema: { type: 'string', 'x-component': 'Input' } },
  text: { interface: 'textarea', uiSchema: { type: 'string', 'x-component': 'Input.TextArea' } },
  number: { interface: 'number', uiSchema: { type: 'number', 'x-component': 'InputNumber' } },
  date: { interface: 'date', uiSchema: { type: 'string', 'x-component': 'DatePicker' } },
  boolean: { interface: 'checkbox', uiSchema: { type: 'boolean', 'x-component': 'Checkbox' } },
  select: { interface: 'select', uiSchema: { type: 'string', 'x-component': 'Select' } },
  relation: { interface: 'select', uiSchema: { type: 'string', 'x-component': 'AssociationSelect' } },
  email: { interface: 'email', uiSchema: { type: 'string', 'x-component': 'Input', 'x-validator': 'email' } },
  url: { interface: 'url', uiSchema: { type: 'string', 'x-component': 'Input', 'x-validator': 'url' } },
  file: { interface: 'attachment', uiSchema: { type: 'array', 'x-component': 'Upload' } },
  uuid: { interface: 'input', uiSchema: { type: 'string', 'x-component': 'Input', 'x-read-pretty': true } },
};

export async function generateNocoBaseBlueprint(
  entityModel: EntityModel,
  workflowModel: WorkflowModel,
  permissionMatrix: PermissionMatrix,
  llmConfig?: LLMConfig,
  appName?: string,
): Promise<NocoBaseBlueprint> {
  if (isLLMConfigured(llmConfig)) {
    try {
      const llm = createLLMClient(llmConfig);
      const blueprint = await llm.chatJson<NocoBaseBlueprint>(
        [
          {
            role: 'system',
            content:
              'You are a NocoBase expert. Generate a complete implementation blueprint based on entity model, workflows, and permissions.',
          },
          {
            role: 'user',
            content: buildNocoBaseBlueprintPrompt(
              entityModel.entities,
              workflowModel.workflows,
              permissionMatrix.roles,
              appName,
            ),
          },
        ],
        { maxTokens: 8000 },
      );
      return blueprint;
    } catch (err) {
      logger.error('LLM NocoBase blueprint generation failed, using structural fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return generateFallbackBlueprint(entityModel, workflowModel, permissionMatrix);
}

function generateFallbackBlueprint(
  entityModel: EntityModel,
  workflowModel: WorkflowModel,
  permissionMatrix: PermissionMatrix,
): NocoBaseBlueprint {
  const hasWorkflows = workflowModel.workflows.length > 0;
  const hasApprovals = workflowModel.workflows.some((w) => w.isApprovalWorkflow);

  const recommendedPlugins = [
    '@nocobase/plugin-data-source-main',
    '@nocobase/plugin-collection-manager',
    '@nocobase/plugin-ui-schema-storage',
    '@nocobase/plugin-action-bulk-edit',
    '@nocobase/plugin-action-export',
    '@nocobase/plugin-action-import',
    '@nocobase/plugin-audit-logs',
    '@nocobase/plugin-users',
    '@nocobase/plugin-acl',
  ];

  if (hasWorkflows) recommendedPlugins.push('@nocobase/plugin-workflow');
  if (hasApprovals) recommendedPlugins.push('@nocobase/plugin-workflow-approval');
  if (entityModel.entities.some((e) => e.hasStatus)) {
    recommendedPlugins.push('@nocobase/plugin-kanban');
  }

  const collections: NocoBaseCollection[] = entityModel.entities.map((entity) => ({
    name: entity.name.toLowerCase().replace(/\s+/g, '_'),
    title: entity.name,
    description: entity.description,
    fields: entity.fields.map((field) => {
      const mapping = FIELD_TYPE_MAP[field.type] ?? FIELD_TYPE_MAP['string']!;
      const uiSchema = { ...mapping.uiSchema, title: field.label };
      if (field.options?.length) {
        (uiSchema as Record<string, unknown>)['enum'] = field.options.map((o) => ({ value: o, label: o }));
      }
      return {
        name: field.name,
        type: field.type === 'relation' ? 'belongsTo' : field.type,
        interface: mapping.interface,
        uiSchema,
        required: field.required,
      };
    }),
    indexes: entity.fields
      .filter((f) => f.unique)
      .map((f) => f.name),
    timestamps: entity.hasAuditFields,
    paranoid: false,
  }));

  const views: NocoBaseView[] = entityModel.entities.flatMap((entity) => {
    const collectionName = entity.name.toLowerCase().replace(/\s+/g, '_');
    return [
      { title: `${entity.name} List`, type: 'table' as const, collection: collectionName, filters: [] },
      { title: `Create ${entity.name}`, type: 'form' as const, collection: collectionName, filters: [] },
      { title: `${entity.name} Detail`, type: 'detail' as const, collection: collectionName, filters: [] },
    ];
  });

  const totalWeeks = Math.max(4, Math.round(entityModel.entities.length * 0.75 + workflowModel.workflows.length));

  return {
    recommendedPlugins,
    customPlugins: [],
    collections,
    views,
    dashboards: [
      { title: 'Overview Dashboard', widgets: permissionMatrix.modules.map((m) => ({ type: 'stat', module: m })) },
    ],
    importJobs: entityModel.entities.map((e) => ({
      name: `Import ${e.name}`,
      collection: e.name.toLowerCase().replace(/\s+/g, '_'),
      format: 'csv',
      mapping: Object.fromEntries(e.fields.map((f) => [f.name, f.label])),
    })),
    effortEstimate: {
      totalWeeks,
      phases: [
        { name: 'Setup & Configuration', weeks: 1, tasks: ['Install NocoBase', 'Configure plugins', 'Setup roles'] },
        { name: 'Data Model', weeks: Math.ceil(entityModel.entities.length / 5), tasks: entityModel.entities.map((e) => `Create ${e.name} collection`) },
        { name: 'UI & Views', weeks: Math.ceil(views.length / 10), tasks: views.slice(0, 5).map((v) => `Build ${v.title}`) },
        { name: 'Workflows', weeks: workflowModel.workflows.length, tasks: workflowModel.workflows.map((w) => `Implement ${w.name}`) },
        { name: 'Testing & Launch', weeks: 2, tasks: ['User acceptance testing', 'Data migration', 'Go-live'] },
      ],
    },
    risks: [
      'Data migration complexity may be underestimated',
      'Custom plugin development required for complex business rules',
      'User training and change management needed',
    ],
    assumptions: [
      'NocoBase latest stable version',
      'PostgreSQL or SQLite for production',
      'Existing data can be exported in CSV/Excel format',
    ],
  };
}

export function blueprintToMarkdown(blueprint: NocoBaseBlueprint, appName?: string): string {
  const name = appName ?? 'Application';
  const lines: string[] = [
    `# NocoBase Implementation Blueprint: ${name}`,
    '',
    `> Generated by ReverseForge AI Studio`,
    '',
    '## Recommended Plugins',
    '',
    ...blueprint.recommendedPlugins.map((p) => `- \`${p}\``),
    '',
  ];

  if (blueprint.customPlugins.length > 0) {
    lines.push('## Custom Plugins Needed', '');
    blueprint.customPlugins.forEach((p) => {
      lines.push(`### ${p.name}`, p.purpose, '');
    });
  }

  lines.push('## Collections', '');
  for (const col of blueprint.collections) {
    lines.push(`### ${col.title} (\`${col.name}\`)`, col.description, '');
    lines.push('| Field | Type | Interface | Required |', '|-------|------|-----------|----------|');
    col.fields.forEach((f) => {
      lines.push(`| ${f.name} | ${f.type} | ${f.interface} | ${f.required ? 'Yes' : 'No'} |`);
    });
    lines.push('');
  }

  lines.push('## Views & Pages', '');
  blueprint.views.forEach((v) => {
    lines.push(`- **${v.title}** (${v.type}) → \`${v.collection}\``);
  });
  lines.push('');

  lines.push('## Effort Estimate', '');
  lines.push(`**Total:** ${blueprint.effortEstimate.totalWeeks} weeks`, '');
  lines.push('| Phase | Weeks |', '|-------|-------|');
  blueprint.effortEstimate.phases.forEach((p) => {
    lines.push(`| ${p.name} | ${p.weeks} |`);
  });
  lines.push('');

  lines.push('## Risks', '');
  blueprint.risks.forEach((r) => lines.push(`- ${r}`));
  lines.push('');

  lines.push('## Assumptions', '');
  blueprint.assumptions.forEach((a) => lines.push(`- ${a}`));

  return lines.join('\n');
}
