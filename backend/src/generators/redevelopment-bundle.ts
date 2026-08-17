import path from 'path';
import { prisma } from '../database/client';
import { writeJson, writeText } from '../utils/file-system';
import type { EntityModel } from '../inference/entity';
import type { WorkflowModel } from '../inference/workflow';
import type { PermissionMatrix } from '../inference/permissions';

interface RedevelopmentBundleArgs {
  projectId: string;
  sessionId: string;
  sourceSessionIds: string[];
  appName: string;
  reportsDir: string;
  entityModel: EntityModel;
  workflowModel: WorkflowModel;
  permissionMatrix: PermissionMatrix;
  architectureAvailable: boolean;
  deepResearchAvailable: boolean;
}

export interface CapturedCall {
  crawlSessionId: string;
  method: string | null;
  url: string;
  responseStatus: number | null;
  requestContentType: string | null;
  responseContentType: string | null;
  responseSchemaKeys: string | null;
  isGraphQL: boolean;
  graphQLOperationName: string | null;
  pageCapture: { url: string } | null;
}

function endpointPattern(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split('/').map((segment) => {
      if (/^\d+$/.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ':id';
      if (/^[0-9a-f]{16,}$/i.test(segment)) return ':id';
      return segment;
    });
    return `${parsed.origin}${segments.join('/')}`;
  } catch {
    return rawUrl.split('?')[0] ?? rawUrl;
  }
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function buildApiContractCatalog(calls: CapturedCall[]): Array<Record<string, unknown>> {
  const groups = new Map<string, CapturedCall[]>();
  for (const call of calls) {
    const method = (call.method ?? 'GET').toUpperCase();
    const pattern = endpointPattern(call.url);
    const key = `${method} ${pattern}`;
    const group = groups.get(key) ?? [];
    group.push(call);
    groups.set(key, group);
  }

  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([contract, samples]) => {
    const first = samples[0]!;
    return {
      contract,
      method: (first.method ?? 'GET').toUpperCase(),
      endpointPattern: endpointPattern(first.url),
      observations: samples.length,
      sourceSessionIds: [...new Set(samples.map((sample) => sample.crawlSessionId))].sort(),
      observedOnPages: [...new Set(samples.map((sample) => sample.pageCapture?.url).filter(Boolean))].sort(),
      statuses: [...new Set(samples.map((sample) => sample.responseStatus).filter((status) => status != null))].sort(),
      requestContentTypes: [...new Set(samples.map((sample) => sample.requestContentType).filter(Boolean))].sort(),
      responseContentTypes: [...new Set(samples.map((sample) => sample.responseContentType).filter(Boolean))].sort(),
      responseFields: [...new Set(samples.flatMap((sample) => parseStringArray(sample.responseSchemaKeys)))].sort(),
      graphQL: samples.some((sample) => sample.isGraphQL),
      graphQLOperations: [...new Set(samples.map((sample) => sample.graphQLOperationName).filter(Boolean))].sort(),
      confidence: samples.length >= 3 ? 'high' : samples.length === 2 ? 'medium' : 'low',
    };
  });
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

export async function writeRedevelopmentBundle(args: RedevelopmentBundleArgs): Promise<string[]> {
  const [calls, findings, pageCount] = await Promise.all([
    prisma.networkCall.findMany({
      where: { crawlSessionId: { in: args.sourceSessionIds } },
      orderBy: { createdAt: 'asc' },
      select: {
        crawlSessionId: true,
        method: true,
        url: true,
        responseStatus: true,
        requestContentType: true,
        responseContentType: true,
        responseSchemaKeys: true,
        isGraphQL: true,
        graphQLOperationName: true,
        pageCapture: { select: { url: true } },
      },
    }),
    prisma.analysisFinding.findMany({
      where: { crawlSessionId: args.sessionId },
      orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, agent: true, category: true, severity: true, title: true, recommendation: true, evidenceNodeIds: true },
    }),
    prisma.pageCapture.count({ where: { crawlSessionId: { in: args.sourceSessionIds } } }),
  ]);
  const contracts = buildApiContractCatalog(calls);
  const generatedAt = new Date().toISOString();
  const unknowns = [
    ...(args.architectureAvailable ? [] : ['Technical architecture inference is unavailable and must be validated manually.']),
    ...(args.deepResearchAvailable ? [] : ['Deep network research is unavailable; integrations and session behavior need validation.']),
    ...(contracts.length ? [] : ['No API contracts were observed. Run a network-enabled crawl before implementation.']),
    ...(pageCount ? [] : ['No pages were captured. User-interface scope cannot be estimated.']),
  ];

  const blueprint = {
    schemaVersion: 1,
    generatedAt,
    project: { id: args.projectId, name: args.appName, reportSessionId: args.sessionId, sourceSessionIds: args.sourceSessionIds },
    evidenceBaseline: {
      pages: pageCount,
      apiContracts: contracts.length,
      entities: args.entityModel.entities.length,
      workflows: args.workflowModel.workflows.length,
      roles: args.permissionMatrix.roles.length,
      findings: findings.length,
    },
    targetModules: args.entityModel.entities.map((entity) => ({
      name: entity.name,
      boundedContext: entity.primaryModule || 'General',
      fields: entity.fields,
      relationships: entity.relationships,
      statusValues: entity.statusValues,
    })),
    deliveryPhases: [
      { phase: 0, name: 'Evidence validation', exitCriteria: ['Resolve every high-impact unknown', 'Approve API and role baselines'] },
      { phase: 1, name: 'Platform foundation', exitCriteria: ['CI, environments, observability, auth shell, and migration framework operational'] },
      { phase: 2, name: 'Contract-compatible backend', exitCriteria: ['Observed API contracts implemented with contract tests', 'Authorization enforced server-side'] },
      { phase: 3, name: 'Workflow-complete frontend', exitCriteria: ['Captured workflows pass end-to-end tests', 'Accessibility and responsive checks pass'] },
      { phase: 4, name: 'Migration and cutover', exitCriteria: ['Reconciliation accepted', 'Rollback rehearsed', 'Production SLOs met'] },
    ],
    openQuestions: unknowns,
  };

  const backlog = {
    schemaVersion: 1,
    generatedAt,
    epics: [
      ...args.entityModel.entities.map((entity, index) => ({
        id: `ENTITY-${String(index + 1).padStart(3, '0')}`,
        type: 'domain',
        title: `Rebuild ${entity.name}`,
        module: entity.primaryModule || 'General',
        acceptanceCriteria: [`Persist and validate ${entity.fields.length} observed fields`, 'Implement relationship and status invariants', 'Add unit and integration tests'],
      })),
      ...args.workflowModel.workflows.map((workflow, index) => ({
        id: `FLOW-${String(index + 1).padStart(3, '0')}`,
        type: 'workflow',
        title: `Implement ${workflow.name}`,
        entity: workflow.entityName,
        actors: workflow.actors,
        acceptanceCriteria: workflow.transitions.map((transition) => `${transition.actor}: ${transition.from} -> ${transition.to} via ${transition.trigger}`),
      })),
      ...findings.filter((finding) => ['critical', 'high'].includes((finding.severity ?? '').toLowerCase())).map((finding, index) => ({
        id: `RISK-${String(index + 1).padStart(3, '0')}`,
        type: 'risk-remediation',
        title: finding.title,
        severity: finding.severity,
        acceptanceCriteria: [finding.recommendation || 'Document and mitigate the finding', 'Attach verification evidence before closure'],
      })),
    ],
  };

  const validationPlan = {
    schemaVersion: 1,
    generatedAt,
    gates: [
      { gate: 'contract', required: true, checks: ['Request/response schemas', 'status and error semantics', 'authorization boundaries'] },
      { gate: 'workflow', required: true, checks: args.workflowModel.workflows.map((workflow) => workflow.name) },
      { gate: 'data', required: true, checks: ['Migration rehearsal', 'record-count reconciliation', 'referential integrity', 'rollback'] },
      { gate: 'non-functional', required: true, checks: ['Security scan', 'accessibility', 'performance budget', 'observability', 'backup restore'] },
    ],
    unknownsRequiringHumanValidation: unknowns,
  };

  const traceRows = [
    ['requirementId', 'type', 'name', 'source', 'evidenceIds', 'implementationStatus'],
    ...args.entityModel.entities.map((entity, index) => [`ENTITY-${index + 1}`, 'entity', entity.name, 'entity inference', '', 'planned']),
    ...args.workflowModel.workflows.map((workflow, index) => [`FLOW-${index + 1}`, 'workflow', workflow.name, 'workflow inference', '', 'planned']),
    ...findings.map((finding) => [`FINDING-${finding.id}`, finding.category, finding.title, finding.agent, parseStringArray(finding.evidenceNodeIds).join(';'), 'mitigation-required']),
  ];
  const traceabilityCsv = traceRows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';

  const readme = `# Redevelopment handoff — ${args.appName}\n\nGenerated: ${generatedAt}\n\nThis directory is an evidence-derived implementation starting point, not a claim that uncaptured behavior does not exist. Resolve the open questions in \`redevelopment-blueprint.json\` before committing architecture or migration scope.\n\n## Recommended reading order\n\n1. \`redevelopment-blueprint.json\`\n2. \`api-contract-catalog.json\`\n3. \`implementation-backlog.json\`\n4. \`traceability-matrix.csv\`\n5. \`validation-plan.json\`\n6. \`evidence-citation-map.json\` and \`analysis-coverage.json\`\n\nEvery implementation item should retain a traceability row and pass the corresponding validation gates before cutover.\n`;

  const files = [
    'redevelopment-blueprint.json',
    'api-contract-catalog.json',
    'implementation-backlog.json',
    'traceability-matrix.csv',
    'validation-plan.json',
    'REDEVELOPMENT-README.md',
  ];
  writeJson(path.join(args.reportsDir, files[0]!), blueprint);
  writeJson(path.join(args.reportsDir, files[1]!), { schemaVersion: 1, generatedAt, contracts });
  writeJson(path.join(args.reportsDir, files[2]!), backlog);
  writeText(path.join(args.reportsDir, files[3]!), traceabilityCsv);
  writeJson(path.join(args.reportsDir, files[4]!), validationPlan);
  writeText(path.join(args.reportsDir, files[5]!), readme);
  return files;
}
