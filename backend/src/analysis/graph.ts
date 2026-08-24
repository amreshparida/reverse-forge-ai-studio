import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { prisma } from '../database/client';
import { createLLMClient, isLLMConfigured, type LLMConfig } from '../ai/llm';
import { ensureDir, getSessionOutputDir, writeJson } from '../utils/file-system';
import { logger } from '../utils/logger';
import { retryUntilSuccess } from '../utils/retry';
import type { EntityModel } from '../inference/entity';
import type { WorkflowModel } from '../inference/workflow';
import type { PermissionMatrix } from '../inference/permissions';

type NodeKind =
  | 'PROJECT'
  | 'PAGE'
  | 'MODULE'
  | 'FEATURE'
  | 'FORM'
  | 'FIELD'
  | 'TABLE'
  | 'COLUMN'
  | 'MODAL'
  | 'ENTITY'
  | 'WORKFLOW'
  | 'ROLE'
  | 'PERMISSION'
  | 'API_ENDPOINT'
  | 'API_CALL'
  | 'REQUEST_PAYLOAD'
  | 'RESPONSE_BODY'
  | 'RAW_ARTIFACT'
  | 'BUSINESS_RULE'
  | 'EVIDENCE';

type GraphNodeInput = {
  kind: NodeKind;
  key: string;
  label: string;
  properties?: unknown;
  source?: string;
  confidence?: number;
};

type GraphEdgeInput = {
  fromNodeId: string;
  toNodeId: string;
  kind: string;
  label?: string;
  properties?: unknown;
  source?: string;
  confidence?: number;
};

export type GraphFindingInput = {
  agent: string;
  category?: string;
  severity?: string;
  title: string;
  detail: string;
  evidenceNodeIds?: string[] | string;
  recommendation?: string;
  confidence?: number;
};

const AGENT_DEFAULT_CATEGORY: Record<string, string> = {
  'ui-ux-agent': 'ux',
  'api-integration-agent': 'api',
  'data-engineer-agent': 'data',
  'domain-product-agent': 'domain',
  'security-compliance-agent': 'security',
  'solution-architect-agent': 'architecture',
  'gap-validator': 'gap',
};

function normalizeEvidenceNodeIds(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const ids = value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    return ids.length > 0 ? ids : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = parseJsonSafe<string[]>(value);
    if (Array.isArray(parsed)) {
      const ids = parsed.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
      return ids.length > 0 ? ids : undefined;
    }
  }
  return undefined;
}

export function normalizeGraphFindingInput(
  finding: Partial<GraphFindingInput> & Pick<GraphFindingInput, 'agent' | 'title' | 'detail'>,
): Required<Pick<GraphFindingInput, 'agent' | 'category' | 'title' | 'detail'>> &
  Pick<GraphFindingInput, 'severity' | 'recommendation' | 'confidence'> & {
    evidenceNodeIds?: string[];
  } {
  const category =
    (typeof finding.category === 'string' && finding.category.trim()) ||
    AGENT_DEFAULT_CATEGORY[finding.agent] ||
    'general';

  return {
    agent: finding.agent,
    category,
    severity: typeof finding.severity === 'string' && finding.severity.trim() ? finding.severity : undefined,
    title: finding.title,
    detail: finding.detail,
    evidenceNodeIds: normalizeEvidenceNodeIds(finding.evidenceNodeIds),
    recommendation:
      typeof finding.recommendation === 'string' && finding.recommendation.trim()
        ? finding.recommendation
        : undefined,
    confidence: typeof finding.confidence === 'number' ? finding.confidence : undefined,
  };
}

export type AnalysisGraphContext = {
  projectId: string;
  sessionId: string;
  sourceSessionIds: string[];
  appName: string;
  reportsDir: string;
  nodeCount: number;
  edgeCount: number;
  findingCount: number;
};

function stringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJsonSafe<T = unknown>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function endpointKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function safeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function collectArtifactMetadata(projectSlug: string, sourceSessionIds: string[]): Array<Record<string, unknown>> {
  const artifacts: Array<Record<string, unknown>> = [];
  const textExts = new Set(['.html', '.json', '.txt', '.md', '.csv', '.log', '.xml', '.svg', '.css', '.js', '.ts', '.tsx']);

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
      const ext = path.extname(entry.name).toLowerCase();
      const buffer = fs.readFileSync(abs);
      artifacts.push({
        sessionId,
        relativePath: rel,
        absolutePath: abs,
        folder: rel.includes('/') ? rel.split('/')[0] : '',
        extension: ext,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        sha256: hashBuffer(buffer),
        encoding: textExts.has(ext) ? 'utf8' : 'base64',
      });
    }
  };

  for (const sessionId of sourceSessionIds) {
    const root = getSessionOutputDir(projectSlug, sessionId);
    walk(sessionId, root, root);
  }

  return artifacts;
}

async function upsertNode(projectId: string, sessionId: string, input: GraphNodeInput): Promise<string> {
  const node = await prisma.analysisGraphNode.upsert({
    where: { crawlSessionId_kind_key: { crawlSessionId: sessionId, kind: input.kind, key: input.key } },
    create: {
      projectId,
      crawlSessionId: sessionId,
      kind: input.kind,
      key: input.key,
      label: input.label,
      properties: stringify(input.properties),
      source: input.source,
      confidence: input.confidence,
    },
    update: {
      label: input.label,
      properties: stringify(input.properties),
      source: input.source,
      confidence: input.confidence,
    },
    select: { id: true },
  });
  return node.id;
}

async function upsertEdge(projectId: string, sessionId: string, input: GraphEdgeInput): Promise<void> {
  await prisma.analysisGraphEdge.upsert({
    where: {
      crawlSessionId_fromNodeId_toNodeId_kind: {
        crawlSessionId: sessionId,
        fromNodeId: input.fromNodeId,
        toNodeId: input.toNodeId,
        kind: input.kind,
      },
    },
    create: {
      projectId,
      crawlSessionId: sessionId,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      kind: input.kind,
      label: input.label,
      properties: stringify(input.properties),
      source: input.source,
      confidence: input.confidence,
    },
    update: {
      label: input.label,
      properties: stringify(input.properties),
      source: input.source,
      confidence: input.confidence,
    },
  });
}

export async function addAnalysisFinding(
  projectId: string,
  sessionId: string,
  finding: Partial<GraphFindingInput> & Pick<GraphFindingInput, 'agent' | 'title' | 'detail'>,
): Promise<void> {
  const normalized = normalizeGraphFindingInput(finding);
  await prisma.analysisFinding.create({
    data: {
      projectId,
      crawlSessionId: sessionId,
      agent: normalized.agent,
      category: normalized.category,
      severity: normalized.severity,
      title: normalized.title,
      detail: normalized.detail,
      evidenceNodeIds: normalized.evidenceNodeIds ? stringify(normalized.evidenceNodeIds) : null,
      recommendation: normalized.recommendation,
      confidence: normalized.confidence,
    },
  });
}

function normalizeFindingText(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
}

export async function dedupeAnalysisFindings(sessionId: string): Promise<{ before: number; after: number; removed: number }> {
  const findings = await prisma.analysisFinding.findMany({
    where: { crawlSessionId: sessionId },
    orderBy: { createdAt: 'asc' },
  });

  const seen = new Map<string, string>();
  const duplicateIds: string[] = [];
  for (const finding of findings) {
    const evidence = parseJsonSafe<string[]>(finding.evidenceNodeIds ?? undefined) ?? [];
    const key = [
      finding.agent,
      finding.category,
      finding.severity ?? '',
      normalizeFindingText(finding.title),
      normalizeFindingText(finding.detail),
      evidence.sort().join('|'),
    ].join('::');
    if (seen.has(key)) duplicateIds.push(finding.id);
    else seen.set(key, finding.id);
  }

  if (duplicateIds.length > 0) {
    await prisma.analysisFinding.deleteMany({ where: { id: { in: duplicateIds } } });
  }

  return { before: findings.length, after: findings.length - duplicateIds.length, removed: duplicateIds.length };
}

export async function resetAnalysisGraph(sessionId: string): Promise<void> {
  await prisma.analysisFinding.deleteMany({ where: { crawlSessionId: sessionId } });
  await prisma.analysisGraphEdge.deleteMany({ where: { crawlSessionId: sessionId } });
  await prisma.analysisGraphNode.deleteMany({ where: { crawlSessionId: sessionId } });
}

export async function buildAnalysisGraph(params: {
  projectId: string;
  sessionId: string;
  projectSlug: string;
  sourceSessionIds?: string[];
  appName: string;
  reportsDir: string;
  entityModel: EntityModel;
  workflowModel: WorkflowModel;
  permissionMatrix: PermissionMatrix;
}): Promise<AnalysisGraphContext> {
  const { projectId, sessionId, projectSlug, appName, reportsDir, entityModel, workflowModel, permissionMatrix } = params;
  const sourceSessionIds = params.sourceSessionIds?.length ? params.sourceSessionIds : [sessionId];

  await resetAnalysisGraph(sessionId);

  const projectNodeId = await upsertNode(projectId, sessionId, {
    kind: 'PROJECT',
    key: projectId,
    label: appName,
    properties: { projectId, sessionId, sourceSessionIds, appName },
    source: 'report-orchestrator',
    confidence: 1,
  });

  for (const artifact of collectArtifactMetadata(projectSlug, sourceSessionIds)) {
    const relativePath = String(artifact['relativePath'] ?? '');
    const artifactSessionId = String(artifact['sessionId'] ?? '');
    const artifactNodeId = await upsertNode(projectId, sessionId, {
      kind: 'RAW_ARTIFACT',
      key: `${artifactSessionId}:${relativePath}`,
      label: relativePath,
      properties: artifact,
      source: 'raw-artifact',
      confidence: 1,
    });
    await upsertEdge(projectId, sessionId, {
      fromNodeId: projectNodeId,
      toNodeId: artifactNodeId,
      kind: 'PROJECT_HAS_RAW_ARTIFACT',
      source: 'raw-artifact',
      confidence: 1,
    });
  }

  const pages = await prisma.pageCapture.findMany({
    where: { crawlSessionId: { in: sourceSessionIds } },
    include: { networkCalls: true },
    orderBy: [{ depth: 'asc' }, { createdAt: 'asc' }],
  });

  for (const page of pages) {
    const extracted = parseJsonSafe<Record<string, unknown>>(page.extractedData);
    const ai = parseJsonSafe<Record<string, unknown>>(page.aiAnalysis);
    const pageNodeId = await upsertNode(projectId, sessionId, {
      kind: 'PAGE',
      key: page.url,
      label: page.title || page.url,
      properties: {
        id: page.id,
        crawlSessionId: page.crawlSessionId,
        url: page.url,
        title: page.title,
        depth: page.depth,
        loadTimeMs: page.loadTimeMs,
        visibleText: page.visibleText,
        accessibilityTree: page.accessibilityTree,
        screenshotPath: page.screenshotPath,
        fullScreenshotPath: page.fullScreenshotPath,
        extractedData: extracted ?? page.extractedData,
        aiAnalysis: ai,
      },
      source: 'page-capture',
      confidence: 1,
    });
    await upsertEdge(projectId, sessionId, { fromNodeId: projectNodeId, toNodeId: pageNodeId, kind: 'HAS_PAGE' });

    const navigation = extracted?.['navigation'] as { currentModule?: string; buttons?: string[]; tabs?: string[] } | undefined;
    const breadcrumbs = (extracted?.['breadcrumbs'] as string[] | undefined) ?? [];
    const moduleNames = [navigation?.currentModule, ...breadcrumbs].filter((v): v is string => Boolean(v));
    for (const moduleName of moduleNames) {
      const moduleNodeId = await upsertNode(projectId, sessionId, {
        kind: 'MODULE',
        key: safeKey(moduleName),
        label: moduleName,
        properties: { name: moduleName },
        source: 'page-navigation',
        confidence: 0.8,
      });
      await upsertEdge(projectId, sessionId, { fromNodeId: pageNodeId, toNodeId: moduleNodeId, kind: 'PAGE_IN_MODULE' });
    }

    for (const action of navigation?.buttons ?? []) {
      const featureNodeId = await upsertNode(projectId, sessionId, {
        kind: 'FEATURE',
        key: `${page.url}#action:${safeKey(action)}`,
        label: action,
        properties: { action, pageUrl: page.url },
        source: 'page-action',
        confidence: 0.8,
      });
      await upsertEdge(projectId, sessionId, { fromNodeId: pageNodeId, toNodeId: featureNodeId, kind: 'PAGE_HAS_FEATURE' });
    }

    const forms = (extracted?.['forms'] as Array<{ title?: string; fields?: Array<{ label?: string; name?: string; type?: string; required?: boolean }> }> | undefined) ?? [];
    for (const [formIndex, form] of forms.entries()) {
      const formLabel = form.title || `Form ${formIndex + 1}`;
      const formNodeId = await upsertNode(projectId, sessionId, {
        kind: 'FORM',
        key: `${page.url}#form:${formIndex}:${safeKey(formLabel)}`,
        label: formLabel,
        properties: form,
        source: 'page-form',
        confidence: 0.95,
      });
      await upsertEdge(projectId, sessionId, { fromNodeId: pageNodeId, toNodeId: formNodeId, kind: 'PAGE_HAS_FORM' });
      for (const [fieldIndex, field] of (form.fields ?? []).entries()) {
        const fieldLabel = field.label || field.name || `Field ${fieldIndex + 1}`;
        const fieldNodeId = await upsertNode(projectId, sessionId, {
          kind: 'FIELD',
          key: `${page.url}#form:${formIndex}:field:${fieldIndex}:${safeKey(fieldLabel)}`,
          label: fieldLabel,
          properties: field,
          source: 'page-form-field',
          confidence: 0.95,
        });
        await upsertEdge(projectId, sessionId, { fromNodeId: formNodeId, toNodeId: fieldNodeId, kind: 'FORM_HAS_FIELD' });
      }
    }

    const tables = (extracted?.['tables'] as Array<{ title?: string; columns?: Array<{ header?: string }> }> | undefined) ?? [];
    for (const [tableIndex, table] of tables.entries()) {
      const tableLabel = table.title || `Table ${tableIndex + 1}`;
      const tableNodeId = await upsertNode(projectId, sessionId, {
        kind: 'TABLE',
        key: `${page.url}#table:${tableIndex}:${safeKey(tableLabel)}`,
        label: tableLabel,
        properties: table,
        source: 'page-table',
        confidence: 0.95,
      });
      await upsertEdge(projectId, sessionId, { fromNodeId: pageNodeId, toNodeId: tableNodeId, kind: 'PAGE_HAS_TABLE' });
      for (const [columnIndex, column] of (table.columns ?? []).entries()) {
        const columnLabel = column.header || `Column ${columnIndex + 1}`;
        const columnNodeId = await upsertNode(projectId, sessionId, {
          kind: 'COLUMN',
          key: `${page.url}#table:${tableIndex}:column:${columnIndex}:${safeKey(columnLabel)}`,
          label: columnLabel,
          properties: column,
          source: 'page-table-column',
          confidence: 0.95,
        });
        await upsertEdge(projectId, sessionId, { fromNodeId: tableNodeId, toNodeId: columnNodeId, kind: 'TABLE_HAS_COLUMN' });
      }
    }

    const modals = (extracted?.['modals'] as Array<{ title?: string; text?: string }> | undefined) ?? [];
    for (const [modalIndex, modal] of modals.entries()) {
      const modalLabel = modal.title || `Modal ${modalIndex + 1}`;
      const modalNodeId = await upsertNode(projectId, sessionId, {
        kind: 'MODAL',
        key: `${page.url}#modal:${modalIndex}:${safeKey(modalLabel)}`,
        label: modalLabel,
        properties: modal,
        source: 'page-modal',
        confidence: 0.9,
      });
      await upsertEdge(projectId, sessionId, { fromNodeId: pageNodeId, toNodeId: modalNodeId, kind: 'PAGE_HAS_MODAL' });
    }

    for (const call of page.networkCalls) {
      const endpointNodeId = await upsertNode(projectId, sessionId, {
        kind: 'API_ENDPOINT',
        key: endpointKey(call.url),
        label: `${call.method ?? '?'} ${endpointKey(call.url)}`,
        properties: { endpoint: endpointKey(call.url), url: call.url, method: call.method },
        source: 'network-call',
        confidence: 1,
      });
      await upsertEdge(projectId, sessionId, { fromNodeId: pageNodeId, toNodeId: endpointNodeId, kind: 'PAGE_CALLS_API' });

      const callNodeId = await upsertNode(projectId, sessionId, {
        kind: 'API_CALL',
        key: call.id,
        label: `${call.method ?? '?'} ${call.url}`,
        properties: {
          id: call.id,
          method: call.method,
          url: call.url,
          queryParams: parseJsonSafe(call.queryParams) ?? call.queryParams,
          requestPayload: parseJsonSafe(call.requestPayload) ?? call.requestPayload,
          requestContentType: call.requestContentType,
          responseStatus: call.responseStatus,
          responseBody: parseJsonSafe(call.responseBody) ?? call.responseBody,
          responseContentType: call.responseContentType,
          responseSchemaKeys: parseJsonSafe(call.responseSchemaKeys) ?? call.responseSchemaKeys,
          requestHeaders: parseJsonSafe(call.requestHeaders) ?? call.requestHeaders,
          responseHeaders: parseJsonSafe(call.responseHeaders) ?? call.responseHeaders,
          timingMs: call.timingMs,
          resourceType: call.resourceType,
          isGraphQL: call.isGraphQL,
          graphQLOperationName: call.graphQLOperationName,
        },
        source: 'network-call',
        confidence: 1,
      });
      await upsertEdge(projectId, sessionId, { fromNodeId: endpointNodeId, toNodeId: callNodeId, kind: 'ENDPOINT_HAS_CALL' });

      if (call.requestPayload) {
        const requestNodeId = await upsertNode(projectId, sessionId, {
          kind: 'REQUEST_PAYLOAD',
          key: `${call.id}:request`,
          label: `Request payload for ${call.method ?? '?'} ${call.url}`,
          properties: { contentType: call.requestContentType, payload: parseJsonSafe(call.requestPayload) ?? call.requestPayload },
          source: 'network-call',
          confidence: 1,
        });
        await upsertEdge(projectId, sessionId, { fromNodeId: callNodeId, toNodeId: requestNodeId, kind: 'CALL_HAS_REQUEST_PAYLOAD' });
      }

      if (call.responseBody) {
        const responseNodeId = await upsertNode(projectId, sessionId, {
          kind: 'RESPONSE_BODY',
          key: `${call.id}:response`,
          label: `Response body for ${call.method ?? '?'} ${call.url}`,
          properties: { contentType: call.responseContentType, body: parseJsonSafe(call.responseBody) ?? call.responseBody },
          source: 'network-call',
          confidence: 1,
        });
        await upsertEdge(projectId, sessionId, { fromNodeId: callNodeId, toNodeId: responseNodeId, kind: 'CALL_HAS_RESPONSE_BODY' });
      }
    }
  }

  for (const entity of entityModel.entities) {
    const entityNodeId = await upsertNode(projectId, sessionId, {
      kind: 'ENTITY',
      key: safeKey(entity.name),
      label: entity.name,
      properties: entity,
      source: 'entity-agent',
      confidence: 0.85,
    });
    await upsertEdge(projectId, sessionId, { fromNodeId: projectNodeId, toNodeId: entityNodeId, kind: 'HAS_ENTITY' });
    for (const field of entity.fields) {
      const fieldNodeId = await upsertNode(projectId, sessionId, {
        kind: 'FIELD',
        key: `entity:${safeKey(entity.name)}:field:${safeKey(field.name)}`,
        label: `${entity.name}.${field.name}`,
        properties: field,
        source: 'entity-agent',
        confidence: 0.85,
      });
      await upsertEdge(projectId, sessionId, { fromNodeId: entityNodeId, toNodeId: fieldNodeId, kind: 'ENTITY_HAS_FIELD' });
    }
  }

  for (const workflow of workflowModel.workflows) {
    const workflowNodeId = await upsertNode(projectId, sessionId, {
      kind: 'WORKFLOW',
      key: safeKey(workflow.name),
      label: workflow.name,
      properties: workflow,
      source: 'workflow-agent',
      confidence: 0.8,
    });
    await upsertEdge(projectId, sessionId, { fromNodeId: projectNodeId, toNodeId: workflowNodeId, kind: 'HAS_WORKFLOW' });
  }

  for (const role of permissionMatrix.roles) {
    const roleNodeId = await upsertNode(projectId, sessionId, {
      kind: 'ROLE',
      key: safeKey(role.name),
      label: role.name,
      properties: role,
      source: 'permission-agent',
      confidence: 0.75,
    });
    await upsertEdge(projectId, sessionId, { fromNodeId: projectNodeId, toNodeId: roleNodeId, kind: 'HAS_ROLE' });
    for (const permission of role.permissions ?? []) {
      const permissionNodeId = await upsertNode(projectId, sessionId, {
        kind: 'PERMISSION',
        key: `role:${safeKey(role.name)}:permission:${safeKey(permission.module)}:${safeKey(permission.resource)}`,
        label: `${role.name} -> ${permission.module}/${permission.resource}`,
        properties: permission,
        source: 'permission-agent',
        confidence: 0.75,
      });
      await upsertEdge(projectId, sessionId, { fromNodeId: roleNodeId, toNodeId: permissionNodeId, kind: 'ROLE_HAS_PERMISSION' });
    }
  }

  await runDeterministicGapValidator(projectId, sessionId, sourceSessionIds);

  const [nodeCount, edgeCount, findingCount] = await Promise.all([
    prisma.analysisGraphNode.count({ where: { crawlSessionId: sessionId } }),
    prisma.analysisGraphEdge.count({ where: { crawlSessionId: sessionId } }),
    prisma.analysisFinding.count({ where: { crawlSessionId: sessionId } }),
  ]);

  await writeAnalysisGraphSnapshotFile(sessionId, path.join(reportsDir, 'analysis-graph.json'));
  logger.info(`Analysis graph built: ${nodeCount} nodes, ${edgeCount} edges, ${findingCount} findings`);

  return { projectId, sessionId, sourceSessionIds, appName, reportsDir, nodeCount, edgeCount, findingCount };
}

async function runDeterministicGapValidator(projectId: string, sessionId: string, sourceSessionIds: string[]): Promise<void> {
  const [pagesWithoutAnalysis, apiWithoutResponse, forms, entities] = await Promise.all([
    prisma.pageCapture.findMany({ where: { crawlSessionId: { in: sourceSessionIds }, aiAnalysis: null }, select: { url: true, title: true } }),
    prisma.networkCall.findMany({ where: { crawlSessionId: { in: sourceSessionIds }, responseBody: null }, select: { method: true, url: true, responseStatus: true } }),
    prisma.analysisGraphNode.findMany({ where: { crawlSessionId: sessionId, kind: 'FORM' }, select: { id: true, label: true } }),
    prisma.analysisGraphNode.findMany({ where: { crawlSessionId: sessionId, kind: 'ENTITY' }, select: { id: true, label: true } }),
  ]);

  if (pagesWithoutAnalysis.length > 0) {
    await addAnalysisFinding(projectId, sessionId, {
      agent: 'gap-validator',
      category: 'coverage',
      severity: 'medium',
      title: 'Some captured pages do not have AI page analysis',
      detail: `${pagesWithoutAnalysis.length} page(s) are captured but missing aiAnalysis.`,
      recommendation: 'Run page analysis for all pages before final sign-off.',
      confidence: 1,
    });
  }

  if (apiWithoutResponse.length > 0) {
    await addAnalysisFinding(projectId, sessionId, {
      agent: 'gap-validator',
      category: 'api-coverage',
      severity: 'low',
      title: 'Some API calls have no captured response body',
      detail: `${apiWithoutResponse.length} API call(s) have no response body stored. This may be expected for redirects, blocked responses, or non-text resources.`,
      recommendation: 'Review missing-response API calls if they are business-critical endpoints.',
      confidence: 0.9,
    });
  }

  if (forms.length > 0 && entities.length === 0) {
    await addAnalysisFinding(projectId, sessionId, {
      agent: 'gap-validator',
      category: 'data-model',
      severity: 'high',
      title: 'Forms were found but no entities were inferred',
      detail: `${forms.length} form node(s) exist, but no entity nodes were created.`,
      recommendation: 'Re-run entity inference and inspect form-to-entity mapping.',
      confidence: 1,
    });
  }
}

const GRAPH_SNAPSHOT_BATCH = 250;

function createJsonWriteStream(outPath: string): {
  write: (chunk: string) => Promise<void>;
  end: () => Promise<void>;
} {
  ensureDir(path.dirname(outPath));
  const stream = fs.createWriteStream(outPath, { encoding: 'utf-8' });
  let streamError: Error | null = null;
  stream.on('error', (err) => {
    streamError = err;
  });

  const write = (chunk: string) =>
    new Promise<void>((resolve, reject) => {
      if (streamError) {
        reject(streamError);
        return;
      }
      if (stream.write(chunk)) {
        resolve();
        return;
      }
      stream.once('drain', () => {
        if (streamError) reject(streamError);
        else resolve();
      });
    });

  const end = () =>
    new Promise<void>((resolve, reject) => {
      stream.end(() => {
        if (streamError) reject(streamError);
        else resolve();
      });
    });

  return { write, end };
}

/** Lightweight counts — never loads node/edge/finding payloads. */
export async function getAnalysisGraphCounts(sessionId: string): Promise<{
  nodeCount: number;
  edgeCount: number;
  findingCount: number;
}> {
  const [nodeCount, edgeCount, findingCount] = await Promise.all([
    prisma.analysisGraphNode.count({ where: { crawlSessionId: sessionId } }),
    prisma.analysisGraphEdge.count({ where: { crawlSessionId: sessionId } }),
    prisma.analysisFinding.count({ where: { crawlSessionId: sessionId } }),
  ]);
  return { nodeCount, edgeCount, findingCount };
}

/**
 * Stream-write the analysis graph to disk in batches so large projects
 * (thousands of nodes) do not OOM from JSON.parse + Array.map of the full set.
 */
export async function writeAnalysisGraphSnapshotFile(
  sessionId: string,
  outPath: string,
): Promise<{ nodeCount: number; edgeCount: number; findingCount: number }> {
  const { write, end } = createJsonWriteStream(outPath);

  await write('{\n  "nodes": [\n');
  let nodeCount = 0;
  let skip = 0;
  for (;;) {
    const nodes = await prisma.analysisGraphNode.findMany({
      where: { crawlSessionId: sessionId },
      orderBy: [{ kind: 'asc' }, { label: 'asc' }],
      skip,
      take: GRAPH_SNAPSHOT_BATCH,
    });
    if (nodes.length === 0) break;
    for (const node of nodes) {
      const row = JSON.stringify({
        id: node.id,
        kind: node.kind,
        key: node.key,
        label: node.label,
        properties: parseJsonSafe(node.properties) ?? node.properties,
        source: node.source,
        confidence: node.confidence,
      });
      await write(`${nodeCount > 0 ? ',\n' : ''}    ${row}`);
      nodeCount += 1;
    }
    skip += nodes.length;
  }

  await write('\n  ],\n  "edges": [\n');
  let edgeCount = 0;
  skip = 0;
  for (;;) {
    const edges = await prisma.analysisGraphEdge.findMany({
      where: { crawlSessionId: sessionId },
      orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
      skip,
      take: GRAPH_SNAPSHOT_BATCH,
    });
    if (edges.length === 0) break;
    for (const edge of edges) {
      const row = JSON.stringify({
        id: edge.id,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        kind: edge.kind,
        label: edge.label,
        properties: parseJsonSafe(edge.properties ?? undefined) ?? edge.properties,
        source: edge.source,
        confidence: edge.confidence,
      });
      await write(`${edgeCount > 0 ? ',\n' : ''}    ${row}`);
      edgeCount += 1;
    }
    skip += edges.length;
  }

  await write('\n  ],\n  "findings": [\n');
  let findingCount = 0;
  skip = 0;
  for (;;) {
    const findings = await prisma.analysisFinding.findMany({
      where: { crawlSessionId: sessionId },
      orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
      skip,
      take: GRAPH_SNAPSHOT_BATCH,
    });
    if (findings.length === 0) break;
    for (const finding of findings) {
      const row = JSON.stringify({
        id: finding.id,
        agent: finding.agent,
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        evidenceNodeIds: parseJsonSafe(finding.evidenceNodeIds ?? undefined) ?? [],
        recommendation: finding.recommendation,
        confidence: finding.confidence,
      });
      await write(`${findingCount > 0 ? ',\n' : ''}    ${row}`);
      findingCount += 1;
    }
    skip += findings.length;
  }

  await write('\n  ]\n}\n');
  await end();

  return { nodeCount, edgeCount, findingCount };
}

/**
 * In-memory snapshot — prefer {@link writeAnalysisGraphSnapshotFile} for large graphs.
 * Kept for callers that need a compact object; loads in batches to reduce peak pressure.
 */
export async function getAnalysisGraphSnapshot(sessionId: string): Promise<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const findings: Array<Record<string, unknown>> = [];

  for (let skip = 0; ; skip += GRAPH_SNAPSHOT_BATCH) {
    const batch = await prisma.analysisGraphNode.findMany({
      where: { crawlSessionId: sessionId },
      orderBy: [{ kind: 'asc' }, { label: 'asc' }],
      skip,
      take: GRAPH_SNAPSHOT_BATCH,
    });
    if (batch.length === 0) break;
    for (const node of batch) {
      nodes.push({
        id: node.id,
        kind: node.kind,
        key: node.key,
        label: node.label,
        properties: parseJsonSafe(node.properties) ?? node.properties,
        source: node.source,
        confidence: node.confidence,
      });
    }
  }

  for (let skip = 0; ; skip += GRAPH_SNAPSHOT_BATCH) {
    const batch = await prisma.analysisGraphEdge.findMany({
      where: { crawlSessionId: sessionId },
      orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
      skip,
      take: GRAPH_SNAPSHOT_BATCH,
    });
    if (batch.length === 0) break;
    for (const edge of batch) {
      edges.push({
        id: edge.id,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        kind: edge.kind,
        label: edge.label,
        properties: parseJsonSafe(edge.properties ?? undefined) ?? edge.properties,
        source: edge.source,
        confidence: edge.confidence,
      });
    }
  }

  for (let skip = 0; ; skip += GRAPH_SNAPSHOT_BATCH) {
    const batch = await prisma.analysisFinding.findMany({
      where: { crawlSessionId: sessionId },
      orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
      skip,
      take: GRAPH_SNAPSHOT_BATCH,
    });
    if (batch.length === 0) break;
    for (const finding of batch) {
      findings.push({
        id: finding.id,
        agent: finding.agent,
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        evidenceNodeIds: parseJsonSafe(finding.evidenceNodeIds ?? undefined) ?? [],
        recommendation: finding.recommendation,
        confidence: finding.confidence,
      });
    }
  }

  return { nodes, edges, findings };
}

function pickEvidencePointer(propertiesRaw: string | null | undefined): Record<string, unknown> {
  const props = parseJsonSafe<Record<string, unknown>>(propertiesRaw) ?? {};
  return {
    pageUrl: props['url'],
    apiUrl: props['url'] ?? props['endpoint'],
    screenshotPath: props['screenshotPath'],
    fullScreenshotPath: props['fullScreenshotPath'],
  };
}

export async function writeEvidenceCitationMapFile(sessionId: string, outPath: string): Promise<void> {
  const { write, end } = createJsonWriteStream(outPath);

  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (let skip = 0; ; skip += GRAPH_SNAPSHOT_BATCH) {
    const edges = await prisma.analysisGraphEdge.findMany({
      where: { crawlSessionId: sessionId },
      select: { fromNodeId: true, toNodeId: true },
      skip,
      take: GRAPH_SNAPSHOT_BATCH,
    });
    if (edges.length === 0) break;
    for (const edge of edges) {
      outbound.set(edge.fromNodeId, (outbound.get(edge.fromNodeId) ?? 0) + 1);
      inbound.set(edge.toNodeId, (inbound.get(edge.toNodeId) ?? 0) + 1);
    }
  }

  const nodeMeta = new Map<string, { kind: string; label: string; source: string | null }>();

  await write('{\n  "nodes": [\n');
  let nodeCount = 0;
  for (let skip = 0; ; skip += GRAPH_SNAPSHOT_BATCH) {
    const nodes = await prisma.analysisGraphNode.findMany({
      where: { crawlSessionId: sessionId },
      orderBy: [{ kind: 'asc' }, { label: 'asc' }],
      skip,
      take: GRAPH_SNAPSHOT_BATCH,
    });
    if (nodes.length === 0) break;
    for (const node of nodes) {
      nodeMeta.set(node.id, { kind: node.kind, label: node.label, source: node.source });
      const row = JSON.stringify({
        id: node.id,
        kind: node.kind,
        label: node.label,
        source: node.source,
        confidence: node.confidence,
        evidencePointer: pickEvidencePointer(node.properties),
        inboundEdges: inbound.get(node.id) ?? 0,
        outboundEdges: outbound.get(node.id) ?? 0,
      });
      await write(`${nodeCount > 0 ? ',\n' : ''}    ${row}`);
      nodeCount += 1;
    }
  }

  await write('\n  ],\n  "findings": [\n');
  let findingCount = 0;
  for (let skip = 0; ; skip += GRAPH_SNAPSHOT_BATCH) {
    const findings = await prisma.analysisFinding.findMany({
      where: { crawlSessionId: sessionId },
      orderBy: [{ agent: 'asc' }, { createdAt: 'asc' }],
      skip,
      take: GRAPH_SNAPSHOT_BATCH,
    });
    if (findings.length === 0) break;
    for (const finding of findings) {
      const evidenceIds = parseJsonSafe<string[]>(finding.evidenceNodeIds ?? undefined) ?? [];
      const row = JSON.stringify({
        id: finding.id,
        agent: finding.agent,
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        evidence: evidenceIds.map((id) => {
          const node = nodeMeta.get(id);
          return node ? { id, kind: node.kind, label: node.label, source: node.source } : { id, missing: true };
        }),
      });
      await write(`${findingCount > 0 ? ',\n' : ''}    ${row}`);
      findingCount += 1;
    }
  }

  await write('\n  ]\n}\n');
  await end();
}

export async function buildEvidenceCitationMap(sessionId: string): Promise<Record<string, unknown>> {
  // Prefer streaming to disk; this in-memory path is only for small graphs / tests.
  const counts = await getAnalysisGraphCounts(sessionId);
  if (counts.nodeCount > 2_000) {
    logger.warn(
      `[Graph] buildEvidenceCitationMap in-memory skipped for large graph (${counts.nodeCount} nodes) — use writeEvidenceCitationMapFile`,
    );
    return { nodes: [], findings: [], streamed: true, ...counts };
  }

  const [nodes, edges, findings] = await Promise.all([
    prisma.analysisGraphNode.findMany({ where: { crawlSessionId: sessionId }, orderBy: [{ kind: 'asc' }, { label: 'asc' }] }),
    prisma.analysisGraphEdge.findMany({ where: { crawlSessionId: sessionId }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] }),
    prisma.analysisFinding.findMany({ where: { crawlSessionId: sessionId }, orderBy: [{ agent: 'asc' }, { createdAt: 'asc' }] }),
  ]);

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const edge of edges) {
    outbound.set(edge.fromNodeId, (outbound.get(edge.fromNodeId) ?? 0) + 1);
    inbound.set(edge.toNodeId, (inbound.get(edge.toNodeId) ?? 0) + 1);
  }

  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      source: node.source,
      confidence: node.confidence,
      evidencePointer: pickEvidencePointer(node.properties),
      inboundEdges: inbound.get(node.id) ?? 0,
      outboundEdges: outbound.get(node.id) ?? 0,
    })),
    findings: findings.map((finding) => {
      const evidenceIds = parseJsonSafe<string[]>(finding.evidenceNodeIds ?? undefined) ?? [];
      return {
        id: finding.id,
        agent: finding.agent,
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        evidence: evidenceIds.map((id) => {
          const node = nodeById.get(id);
          return node ? { id, kind: node.kind, label: node.label, source: node.source } : { id, missing: true };
        }),
      };
    }),
  };
}

export async function computeAnalysisCoverage(sessionId: string, sourceSessionIds: string[] = [sessionId]): Promise<Record<string, unknown>> {
  // Count-only queries — never load aiAnalysis / extractedData / response bodies.
  const [
    nodes,
    edges,
    findings,
    pageCount,
    pagesWithExtracted,
    pagesWithAi,
    callCount,
    callsWithPayload,
    callsWithResponse,
  ] = await Promise.all([
    prisma.analysisGraphNode.findMany({
      where: { crawlSessionId: sessionId },
      select: { id: true, kind: true, confidence: true },
    }),
    prisma.analysisGraphEdge.findMany({
      where: { crawlSessionId: sessionId },
      select: { fromNodeId: true, toNodeId: true, kind: true },
    }),
    prisma.analysisFinding.findMany({
      where: { crawlSessionId: sessionId },
      select: { category: true, severity: true, evidenceNodeIds: true },
    }),
    prisma.pageCapture.count({ where: { crawlSessionId: { in: sourceSessionIds } } }),
    prisma.pageCapture.count({
      where: { crawlSessionId: { in: sourceSessionIds }, extractedData: { not: null } },
    }),
    prisma.pageCapture.count({
      where: { crawlSessionId: { in: sourceSessionIds }, aiAnalysis: { not: null } },
    }),
    prisma.networkCall.count({ where: { crawlSessionId: { in: sourceSessionIds } } }),
    prisma.networkCall.count({
      where: { crawlSessionId: { in: sourceSessionIds }, requestPayload: { not: null } },
    }),
    prisma.networkCall.count({
      where: { crawlSessionId: { in: sourceSessionIds }, responseBody: { not: null } },
    }),
  ]);

  const countBy = <T extends string>(items: T[]): Record<T, number> =>
    items.reduce((acc, item) => {
      acc[item] = (acc[item] ?? 0) + 1;
      return acc;
    }, {} as Record<T, number>);

  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.fromNodeId);
    connectedIds.add(edge.toNodeId);
  }

  const findingsWithEvidence = findings.filter((finding) => {
    const ids = parseJsonSafe<string[]>(finding.evidenceNodeIds ?? undefined) ?? [];
    return ids.length > 0;
  }).length;

  const lowConfidenceNodes = nodes.filter((node) => typeof node.confidence === 'number' && node.confidence < 0.7).length;

  const ratios = {
    pagesWithExtractedData: pageCount ? pagesWithExtracted / pageCount : 0,
    pagesWithAiAnalysis: pageCount ? pagesWithAi / pageCount : 0,
    apiCallsWithRequestPayload: callCount ? callsWithPayload / callCount : 0,
    apiCallsWithResponseBody: callCount ? callsWithResponse / callCount : 0,
    findingsWithEvidence: findings.length ? findingsWithEvidence / findings.length : 0,
    graphConnectedNodes: nodes.length ? connectedIds.size / nodes.length : 0,
  };

  const coverageScore = Math.round(
    ((ratios.pagesWithExtractedData * 0.15) +
      (ratios.pagesWithAiAnalysis * 0.2) +
      (ratios.apiCallsWithResponseBody * 0.15) +
      (ratios.findingsWithEvidence * 0.25) +
      (ratios.graphConnectedNodes * 0.25)) * 100,
  );

  return {
    score: coverageScore,
    insufficientEvidence: pageCount === 0 || nodes.length === 0 || findings.length === 0,
    ratios,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      findings: findings.length,
      pages: pageCount,
      networkCalls: callCount,
      pagesWithExtractedData: pagesWithExtracted,
      pagesWithAiAnalysis: pagesWithAi,
      apiCallsWithRequestPayload: callsWithPayload,
      apiCallsWithResponseBody: callsWithResponse,
      findingsWithEvidence,
      lowConfidenceNodes,
      orphanNodes: nodes.filter((node) => !connectedIds.has(node.id)).length,
    },
    nodesByKind: countBy(nodes.map((node) => node.kind)),
    edgesByKind: countBy(edges.map((edge) => edge.kind)),
    findingsByCategory: countBy(findings.map((finding) => finding.category)),
    findingsBySeverity: countBy(findings.map((finding) => finding.severity ?? 'info')),
  };
}

export async function finalizeAnalysisGraphArtifacts(sessionId: string, reportsDir: string, sourceSessionIds: string[] = [sessionId]): Promise<Record<string, unknown>> {
  logger.info(`[Graph] Finalizing analysis artifacts for ${sessionId} (streamed, memory-safe)`);
  const dedupe = await dedupeAnalysisFindings(sessionId);
  const coverage = await computeAnalysisCoverage(sessionId, sourceSessionIds);

  await writeAnalysisGraphSnapshotFile(sessionId, path.join(reportsDir, 'analysis-graph-enriched.json'));
  await writeEvidenceCitationMapFile(sessionId, path.join(reportsDir, 'evidence-citation-map.json'));
  writeJson(path.join(reportsDir, 'analysis-coverage.json'), coverage);
  writeJson(path.join(reportsDir, 'finding-dedupe-summary.json'), dedupe);

  const counts = (coverage['counts'] ?? {}) as Record<string, unknown>;
  const score = typeof coverage['score'] === 'number' ? coverage['score'] : 100;
  const findings = typeof counts['findings'] === 'number' ? counts['findings'] : 0;
  const findingsWithEvidence = typeof counts['findingsWithEvidence'] === 'number' ? counts['findingsWithEvidence'] : 0;
  const orphanNodes = typeof counts['orphanNodes'] === 'number' ? counts['orphanNodes'] : 0;
  const project = await prisma.crawlSession.findUnique({ where: { id: sessionId }, select: { projectId: true } });
  if (project) {
    if (score < 80) {
      await addAnalysisFinding(project.projectId, sessionId, {
        agent: 'coverage-validator',
        category: 'coverage',
        severity: 'medium',
        title: 'Analysis coverage score is below target',
        detail: `Computed evidence coverage score is ${score}/100. Review analysis-coverage.json for the weak dimensions.`,
        recommendation: 'Improve crawl depth, page analysis completion, API response capture, or evidence-linked findings before relying on the report as final.',
        confidence: 1,
      });
    }
    if (findings > 0 && findingsWithEvidence < findings) {
      await addAnalysisFinding(project.projectId, sessionId, {
        agent: 'coverage-validator',
        category: 'auditability',
        severity: 'medium',
        title: 'Some findings are missing evidence node links',
        detail: `${findings - findingsWithEvidence} finding(s) do not cite graph evidence nodes.`,
        recommendation: 'Require specialist agents to include evidenceNodeIds for all material findings.',
        confidence: 1,
      });
    }
    if (orphanNodes > 1) {
      await addAnalysisFinding(project.projectId, sessionId, {
        agent: 'coverage-validator',
        category: 'graph-quality',
        severity: 'low',
        title: 'Graph contains orphan nodes',
        detail: `${orphanNodes} graph node(s) have no edge connections. Some isolated nodes may be expected, but this can indicate missed relationships.`,
        recommendation: 'Review orphan nodes and add missing relationships where appropriate.',
        confidence: 0.9,
      });
    }
  }

  // Re-write coverage after optional validator findings (graph file already on disk; avoid second full load)
  const finalCoverage = await computeAnalysisCoverage(sessionId, sourceSessionIds);
  writeJson(path.join(reportsDir, 'analysis-coverage.json'), finalCoverage);
  await writeAnalysisGraphSnapshotFile(sessionId, path.join(reportsDir, 'analysis-graph-enriched.json'));
  await writeEvidenceCitationMapFile(sessionId, path.join(reportsDir, 'evidence-citation-map.json'));

  logger.info(`[Graph] Finalization complete for ${sessionId}`);
  return { dedupe, coverage: finalCoverage };
}

function chunkString(input: string, maxChars: number): string[] {
  if (input.length <= maxChars) return [input];
  const chunks: string[] = [];
  for (let start = 0; start < input.length; start += maxChars) chunks.push(input.slice(start, start + maxChars));
  return chunks;
}

export async function runSpecialistGraphAgents(params: {
  projectId: string;
  sessionId: string;
  sourceSessionIds?: string[];
  appName: string;
  reportsDir: string;
  llmConfig?: LLMConfig;
}): Promise<void> {
  if (!isLLMConfigured(params.llmConfig)) return;

  const agents = [
    { name: 'ui-ux-agent', focus: 'UI screens, navigation, forms, modals, tables, usability, and user journeys' },
    { name: 'api-integration-agent', focus: 'API endpoints, payloads, responses, schemas, auth/session signals, and integration risks' },
    { name: 'data-engineer-agent', focus: 'entities, fields, relationships, data lineage, payload objects, data quality, reporting' },
    { name: 'domain-product-agent', focus: 'business domain, capabilities, modules, product workflows, personas, business rules' },
    { name: 'security-compliance-agent', focus: 'permissions, sensitive data, authorization risks, auditability, compliance signals' },
    { name: 'solution-architect-agent', focus: 'architecture style, frontend/backend boundaries, scalability, modernization, technical debt' },
  ];

  function specialistArtifactReady(agentName: string): boolean {
    const filePath = path.join(params.reportsDir, `${agentName}-findings.json`);
    if (!fs.existsSync(filePath)) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      // File present means the agent finished (even if findings[] is empty).
      if (Array.isArray(raw)) return true;
      if (raw && typeof raw === 'object' && Array.isArray((raw as { findings?: unknown }).findings)) {
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  const pendingAgents = agents.filter((agent) => !specialistArtifactReady(agent.name));
  if (pendingAgents.length === 0) {
    logger.info('[Specialist] All specialist findings already on disk — skipping agent runs');
    await finalizeAnalysisGraphArtifacts(
      params.sessionId,
      params.reportsDir,
      params.sourceSessionIds?.length ? params.sourceSessionIds : [params.sessionId],
    );
    return;
  }

  const { config } = await import('../config.js');

  if (config.llm.synthesisAgentEnabled) {
    const project = await prisma.project.findUnique({
      where: { id: params.projectId },
      select: { slug: true },
    });
    if (!project) throw new Error('Project not found for specialist workspace');

    const { materializeEvidenceWorkspace } = await import('../ai/synthesis-workspace.js');
    const { runSynthesisAgent } = await import('../ai/synthesis-agent.js');
    const { writeJson: writeJsonFs } = await import('../utils/file-system.js');

    // Stream graph to disk and chunk from the file — never hold a full parsed graph object.
    const graphSnapshotPath = path.join(params.reportsDir, '_generation', 'analysis-graph-for-specialists.json');
    await writeAnalysisGraphSnapshotFile(params.sessionId, graphSnapshotPath);

    const workspace = await materializeEvidenceWorkspace({
      projectId: params.projectId,
      projectSlug: project.slug,
      sessionId: params.sessionId,
      sourceSessionIds: params.sourceSessionIds,
      includeNetworkCalls: false,
      includeGraphChunks: true,
      graphSnapshotFile: graphSnapshotPath,
      graphChunkSize: 200_000,
    });

    for (const agent of pendingAgents) {
      const artifactName = `${agent.name}-findings.json`;

      const { artifact, steps, coverage } = await retryUntilSuccess(
        () =>
          runSynthesisAgent<{ findings: GraphFindingInput[] }>({
            workspace,
            task: 'specialist',
            expectedArtifact: artifactName,
            appName: params.appName,
            llmConfig: params.llmConfig,
            specialistFocus: `${agent.name}: ${agent.focus}`,
            coverage: { requireAllGraphChunks: true },
            extraAllowedArtifacts: [artifactName],
            reuseSharedEvidence: false,
          }),
        { label: `Specialist ${agent.name}`, delayMs: 15_000, maxDelayMs: 180_000 },
      );

      const findings = (artifact.findings ?? []).map((f) => ({ ...f, agent: f.agent || agent.name }));
      writeJson(path.join(params.reportsDir, artifactName), findings);
      writeJsonFs(path.join(workspace.root, artifactName), findings);
      for (const finding of findings) {
        await addAnalysisFinding(params.projectId, params.sessionId, finding);
      }
      logger.info(`[Specialist] ${agent.name} done in ${steps} steps (${findings.length} findings)`, coverage);
    }

    await finalizeAnalysisGraphArtifacts(
      params.sessionId,
      params.reportsDir,
      params.sourceSessionIds?.length ? params.sourceSessionIds : [params.sessionId],
    );
    return;
  }

  // Legacy chunked chatJson path
  const snapshotPath = path.join(params.reportsDir, '_generation', 'analysis-graph-for-specialists.json');
  await writeAnalysisGraphSnapshotFile(params.sessionId, snapshotPath);
  const snapshotText = fs.readFileSync(snapshotPath, 'utf-8');
  const llm = createLLMClient(params.llmConfig);
  const chunks = chunkString(snapshotText, 80_000);

  for (const agent of pendingAgents) {
    const agentFindings: GraphFindingInput[] = [];
    for (let i = 0; i < chunks.length; i++) {
      logger.info(`${agent.name} analyzing graph chunk ${i + 1}/${chunks.length}`);
      const result = await llm.chatJson<{ findings: GraphFindingInput[] }>(
        [
          {
            role: 'system',
            content: `You are ${agent.name}. Focus: ${agent.focus}. Use the shared analysis graph as your blackboard. Return only valid JSON.`,
          },
          {
            role: 'user',
            content: `Application: ${params.appName}
Graph chunk ${i + 1}/${chunks.length}. Create evidence-backed findings. Reference evidenceNodeIds when possible. Do not invent unsupported facts.

Return JSON:
{
  "findings": [
    {
      "agent": "${agent.name}",
      "category": "domain|product|architecture|data|api|security|workflow|ux|operations|gap",
      "severity": "critical|high|medium|low",
      "title": "short title",
      "detail": "detailed expert finding",
      "evidenceNodeIds": ["node-id"],
      "recommendation": "actionable recommendation",
      "confidence": 0.85
    }
  ]
}

Shared graph chunk:
${chunks[i]}`,
          },
        ],
        { maxTokens: 7000 },
      );
      for (const finding of result.findings ?? []) {
        agentFindings.push({ ...finding, agent: finding.agent || agent.name });
      }
    }

    writeJson(path.join(params.reportsDir, `${agent.name}-findings.json`), agentFindings);
    for (const finding of agentFindings) {
      await addAnalysisFinding(params.projectId, params.sessionId, finding);
    }
  }

  await finalizeAnalysisGraphArtifacts(params.sessionId, params.reportsDir, params.sourceSessionIds?.length ? params.sourceSessionIds : [params.sessionId]);
}

async function runSpecialistLegacyChunkPass(args: {
  agent: { name: string; focus: string };
  snapshot: unknown;
  llmConfig?: LLMConfig;
  appName: string;
  projectId: string;
  sessionId: string;
  reportsDir: string;
}): Promise<void> {
  const llm = createLLMClient(args.llmConfig);
  const chunks = chunkString(JSON.stringify(args.snapshot, null, 2), 80_000);
  const agentFindings: GraphFindingInput[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const result = await llm.chatJson<{ findings: GraphFindingInput[] }>(
      [
        {
          role: 'system',
          content: `You are ${args.agent.name}. Focus: ${args.agent.focus}. Return only valid JSON.`,
        },
        {
          role: 'user',
          content: `Application: ${args.appName}\nGraph chunk ${i + 1}/${chunks.length}.\n${chunks[i]}`,
        },
      ],
      { maxTokens: 7000 },
    );
    for (const finding of result.findings ?? []) {
      agentFindings.push({ ...finding, agent: finding.agent || args.agent.name });
    }
  }
  writeJson(path.join(args.reportsDir, `${args.agent.name}-findings.json`), agentFindings);
  for (const finding of agentFindings) {
    await addAnalysisFinding(args.projectId, args.sessionId, finding);
  }
}
