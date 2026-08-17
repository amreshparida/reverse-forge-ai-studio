import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { config } from '../config';
import { logger } from '../utils/logger';
import { readJson, writeJson } from '../utils/file-system';
import { retryUntilSuccess } from '../utils/retry';
import { resolveSynthesisLlmConfig, type LLMConfig } from './llm';
import { resolveWorkspacePath, type SynthesisWorkspace } from './synthesis-workspace';

const ALLOWED_ARTIFACTS = new Set([
  'entity-model.json',
  'workflow-model.json',
  'permission-matrix.json',
  'architecture.json',
  'knowledge-graph.json',
  'har-intelligence.json',
  'deep-research.json',
]);

export type SynthesisTask =
  | 'entity'
  | 'workflow'
  | 'permission'
  | 'architecture'
  | 'knowledge-graph'
  | 'deep-research'
  | 'specialist';

export interface SynthesisAgentResult<T> {
  artifact: T;
  artifactPath: string;
  steps: number;
  coverage: CoverageSnapshot;
}

interface CoverageState {
  pagesRead: string[];
  apisRead: string[];
  harsRead: string[];
  graphChunksRead: string[];
}

export interface CoverageSnapshot {
  pages: { total: number; read: number; unread: number };
  apis: { total: number; read: number; unread: number };
  hars: { total: number; read: number; unread: number };
  graphChunks: { total: number; read: number; unread: number };
  complete: boolean;
}

export interface CoverageRequirements {
  requireAllPages?: boolean;
  requireAllApis?: boolean;
  requireAllHars?: boolean;
  requireAllGraphChunks?: boolean;
}

function createClient(cfg?: LLMConfig): { client: OpenAI; model: string; baseUrl?: string } {
  const resolved = resolveSynthesisLlmConfig(cfg);
  return {
    client: new OpenAI({
      baseURL: resolved.baseUrl || undefined,
      apiKey: resolved.apiKey || 'placeholder',
      maxRetries: 0,
      timeout: 300_000, // 5 min — NVIDIA can be slow after rate-limits
    }),
    model: resolved.model || config.llm.model,
    baseUrl: resolved.baseUrl,
  };
}

interface WorkingNotesFile {
  notes: string[];
}

function loadWorkingNotes(workspace: SynthesisWorkspace): WorkingNotesFile {
  const abs = resolveWorkspacePath(workspace.root, 'working-notes.json');
  const existing = readJson<WorkingNotesFile>(abs);
  return existing && Array.isArray(existing.notes) ? existing : { notes: [] };
}

/** True when a prior stage already drained all pages and left durable notes. */
function canReuseSharedPageEvidence(
  workspace: SynthesisWorkspace,
  coverage: CoverageState,
): boolean {
  if (workspace.index.length === 0) return false;
  const pageSnap = snapshotCoverage(workspace, coverage, { requireAllPages: true });
  if (pageSnap.pages.unread > 0) return false;
  return loadWorkingNotes(workspace).notes.length > 0;
}

function defaultReuseSharedEvidence(task: SynthesisTask): boolean {
  return (
    task === 'workflow' ||
    task === 'permission' ||
    task === 'architecture' ||
    task === 'knowledge-graph' ||
    task === 'deep-research' ||
    task === 'specialist'
  );
}

/** True when a prior specialist already drained all graph chunks into notes. */
function canReuseSharedGraphEvidence(
  workspace: SynthesisWorkspace,
  coverage: CoverageState,
): boolean {
  if (workspace.graphChunkIndex.length === 0) return false;
  const snap = snapshotCoverage(workspace, coverage, { requireAllGraphChunks: true });
  if (snap.graphChunks.unread > 0) return false;
  return loadWorkingNotes(workspace).notes.length > 0;
}

/** Minimum tool turns still needed to drain required unread evidence (+ write buffer). */
function estimateRemainingSteps(
  workspace: SynthesisWorkspace,
  coverage: CoverageState,
  req: CoverageRequirements,
): number {
  const snap = snapshotCoverage(workspace, coverage, req);
  let reads = 0;
  if (req.requireAllPages) reads += Math.ceil(snap.pages.unread / 16);
  if (req.requireAllApis) reads += Math.ceil(snap.apis.unread / 25);
  if (req.requireAllHars) reads += Math.ceil(snap.hars.unread / 5);
  if (req.requireAllGraphChunks) reads += Math.ceil(snap.graphChunks.unread / 10);
  return reads + (snap.complete ? 20 : 15);
}

function loadCoverage(workspace: SynthesisWorkspace): CoverageState {
  const abs = resolveWorkspacePath(workspace.root, 'coverage-state.json');
  const existing = readJson<Partial<CoverageState>>(abs);
  return {
    pagesRead: existing?.pagesRead ?? [],
    apisRead: existing?.apisRead ?? [],
    harsRead: existing?.harsRead ?? [],
    graphChunksRead: existing?.graphChunksRead ?? [],
  };
}

function saveCoverage(workspace: SynthesisWorkspace, state: CoverageState): void {
  writeJson(resolveWorkspacePath(workspace.root, 'coverage-state.json'), state);
}

function snapshotCoverage(
  workspace: SynthesisWorkspace,
  state: CoverageState,
  req: CoverageRequirements,
): CoverageSnapshot {
  const pages = {
    total: workspace.index.length,
    read: state.pagesRead.length,
    unread: Math.max(0, workspace.index.length - state.pagesRead.length),
  };
  const apis = {
    total: workspace.networkIndex.length,
    read: state.apisRead.length,
    unread: Math.max(0, workspace.networkIndex.length - state.apisRead.length),
  };
  const hars = {
    total: workspace.harIndex.length,
    read: state.harsRead.length,
    unread: Math.max(0, workspace.harIndex.length - state.harsRead.length),
  };
  const graphChunks = {
    total: workspace.graphChunkIndex.length,
    read: state.graphChunksRead.length,
    unread: Math.max(0, workspace.graphChunkIndex.length - state.graphChunksRead.length),
  };

  const complete =
    (!req.requireAllPages || pages.unread === 0) &&
    (!req.requireAllApis || apis.unread === 0) &&
    (!req.requireAllHars || hars.unread === 0) &&
    (!req.requireAllGraphChunks || graphChunks.unread === 0);

  return { pages, apis, hars, graphChunks, complete };
}

function defaultRequirements(task: SynthesisTask): CoverageRequirements {
  switch (task) {
    case 'architecture':
      return { requireAllPages: true, requireAllApis: true, requireAllHars: true };
    case 'deep-research':
      return { requireAllPages: false, requireAllApis: true, requireAllHars: true };
    case 'knowledge-graph':
      // Structural scaffold already indexes every page/API from the workspace catalogs.
      // Only need shared page coverage (notes); do not re-drain all APIs/HARs.
      return { requireAllPages: true, requireAllApis: false, requireAllHars: false };
    case 'specialist':
      return { requireAllGraphChunks: true };
    case 'entity':
    case 'workflow':
    case 'permission':
    default:
      return { requireAllPages: true };
  }
}

function buildTools(allowedArtifacts: string[]): ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'get_coverage',
        description: 'Show how many pages/APIs/HARs/graph-chunks are still unread. Must reach complete=true before write_artifact.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_page_analyses',
        description: 'Catalog of all page analyses (id, url, module, entity).',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_network_calls',
        description: 'Catalog of all network/API captures.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_har_files',
        description: 'Catalog of all full per-page HAR 1.2 captures.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_graph_chunks',
        description: 'Catalog of shared analysis-graph chunk files.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_next_unread_pages',
        description: 'Read the next batch of UNREAD full page analyses and mark them read. Use until pages.unread=0.',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'Batch size (default 16, max 20)' } },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_next_unread_apis',
        description: 'Read the next batch of UNREAD network calls and mark them read. Use until apis.unread=0.',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'Batch size (default 25, max 50)' } },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_next_unread_hars',
        description: 'Read the next batch of UNREAD full HAR files and mark them read. Use until hars.unread=0.',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'Batch size (default 5, max 10)' } },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_next_unread_graph_chunks',
        description: 'Read the next UNREAD graph chunk(s) and mark them read. Use until graphChunks.unread=0.',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'Batch size (default 10, max 20)' } },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_page_analysis',
        description:
          'Re-read ONE page by id. Do NOT use when pages.unread=0 — prefer read_next_unread_pages/apis/hars/graph_chunks for coverage.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_page_analyses',
        description: 'Search page analysis files (does not mark coverage by itself).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'append_working_notes',
        description: 'Persist durable notes to disk so you can forget raw tool payloads and still keep evidence.',
        parameters: {
          type: 'object',
          properties: { note: { type: 'string' } },
          required: ['note'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_working_notes',
        description: 'Read durable working notes.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_artifact',
        description: 'Read an existing workspace artifact JSON.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', enum: allowedArtifacts } },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_artifact',
        description:
          'Write the final artifact. REJECTED until get_coverage.complete is true (all required evidence drained).',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: allowedArtifacts },
            content: { type: 'object' },
          },
          required: ['name', 'content'],
          additionalProperties: false,
        },
      },
    },
  ];
}

function taskBrief(
  task: SynthesisTask,
  appName: string | undefined,
  expectedArtifact: string,
  specialistFocus?: string,
  sharedPagesReady?: boolean,
  sharedGraphReady?: boolean,
): string {
  const app = appName ? `Application: "${appName}". ` : '';
  const sharedHint = sharedPagesReady
    ? [
        'SHARED EVIDENCE READY: A prior stage already drained ALL page analyses into working-notes.json.',
        'Do NOT re-read pages unless get_coverage shows pages.unread>0.',
        'Start with read_working_notes + read_artifact for prior models, then write_artifact.',
        'Only call read_next_unread_pages for any remaining unread pages.',
      ].join(' ')
    : 'CRITICAL: You must not miss data. Drain ALL required unread evidence using read_next_unread_* until get_coverage.complete=true, append_working_notes as you go, then write_artifact. write_artifact is blocked until coverage is complete.';

  const noteDuty = sharedPagesReady
    ? 'You may append_working_notes with task-specific insights.'
    : 'While reading pages, append_working_notes with durable summaries (entities, roles, workflows, modules, APIs). Later stages reuse these notes and will NOT re-read pages.';

  if (task === 'architecture') {
    return `${app}${sharedHint}
${noteDuty}
Infer technical architecture from page evidence (notes and/or unread pages), every network call, and every full HAR file.
CRITICAL: When pages.unread=0 and (apis.unread>0 or hars.unread>0), call ONLY read_next_unread_apis / read_next_unread_hars. Never call read_page_analysis in that state.
HAR files are complete HAR 1.2 captures (all entries: document/script/css/xhr/fetch/etc.) — same as session har/*.har.
Write "${expectedArtifact}" with:
frontendFramework, frontendLibraries, cssFramework, backendPattern, apiBaseUrl, apiVersion, authMechanism, dataFormats, paginationStyle, realtime, fileUpload, multiTenant, i18n, estimatedScale, unusualPatterns, securityObservations, migrationChallenges.`;
  }
  if (task === 'deep-research') {
    return `${app}${sharedHint}
You are a principal reverse-engineering researcher producing a Deep Research dossier (McKinsey/STRIDE-grade, evidence-linked).
Start with read_artifact("har-intelligence.json") — those are DETERMINISTIC OBSERVED FACTS from full HAR files. Do not invent hosts or endpoints that are not in HAR/API evidence.
Then drain unread APIs and HAR files (read_next_unread_apis / read_next_unread_hars) until get_coverage.complete=true.
Write "${expectedArtifact}" with this EXACT shape:
{
  "researchThesis": "one paragraph: what the system is and how it is wired",
  "confidence": 0.0,
  "observedFacts": ["fact with host/endpoint/status"],
  "inferences": [{ "claim": "...", "evidence": ["HAR/API/page"], "confidence": 0.0 }],
  "integrationMap": {
    "firstPartyApiFamilies": [{ "family": "...", "baseUrlHint": "...", "methods": ["GET"], "purpose": "...", "evidence": ["..."] }],
    "thirdParties": [{ "host": "...", "category": "cdn|analytics|auth|payments|error-tracking|other", "purpose": "...", "risk": "..." }]
  },
  "authAndSessionModel": { "mechanism": "...", "evidence": ["..."], "risks": ["..."] },
  "contractCatalog": [{ "method": "GET", "endpoint": "/api/...", "purpose": "...", "requestShape": ["field"], "responseShape": ["field"], "usedOnPages": ["url"] }],
  "pageLoadStories": [{ "pageUrl": "...", "story": "what fires on load and why", "dependentApis": ["GET /..."] }],
  "riskRegister": [{ "severity": "critical|high|medium|low", "title": "...", "detail": "...", "evidence": ["..."], "recommendation": "..." }],
  "reconstructionPlaybook": {
    "recommendedApproach": "strangler|modular-rewrite|api-clone-first|unknown",
    "modulesToRebuildFirst": ["..."],
    "dataContractsToClone": ["..."],
    "unknownsToValidate": ["..."]
  },
  "openQuestions": ["what crawl/HAR still cannot prove"]
}
Separate facts from inferences. Cite HAR page URLs, templated endpoints, status codes, and hosts. Empty arrays are allowed; invented APIs are not.`;
  }
  if (task === 'knowledge-graph') {
    return `${app}${sharedHint}
${noteDuty}
A structural knowledge-graph scaffold is already on disk (all pages/APIs/entities as nodes + module edges).
Do NOT re-read pages or APIs unless get_coverage shows unread>0. Prefer read_working_notes + read_artifact("entity-model.json" / "architecture.json").
Do NOT regenerate hundreds of page/api nodes. Write a COMPACT enrichment to "${expectedArtifact}":
{
  "edges": [{ "from": "page:…|entity:…|api:…|module:…", "to": "…", "type": "uses|shows_entity|calls|belongs_to_module" }],
  "modules": ["ModuleA", "ModuleB"],
  "summary": { "totalPages": N, "totalEntities": N, "totalAPIs": N, "topModules": [], "coreEntities": [] },
  "extraNodes": []
}
Code merges your edges/summary onto the scaffold. Prefer ≤150 edges. Empty nodes[] is OK.`;
  }
  if (task === 'specialist') {
    const graphHint = sharedGraphReady
      ? 'SHARED GRAPH EVIDENCE READY: A prior specialist already drained graph chunks into working-notes.json. Do NOT re-read chunks unless get_coverage shows graphChunks.unread>0. Start with read_working_notes, then write_artifact.'
      : 'CRITICAL: Drain every graph chunk via read_next_unread_graph_chunks (prefer limit=10) until get_coverage.complete=true, append_working_notes as you go.';
    return `${app}${graphHint}
You are specialist: ${specialistFocus ?? 'general'}.
Write findings to the requested artifact path via write_artifact as { "findings": [ ... ] }.`;
  }
  if (task === 'entity') {
    return `${app}${sharedHint}
${noteDuty}
Infer a complete de-duplicated entity model from ALL page analyses.
Write "${expectedArtifact}" with this EXACT shape (use "fields", never "attributes"):
{
  "entities": [
    {
      "name": "EntityName",
      "pluralName": "EntityNames",
      "description": "...",
      "primaryModule": "Module",
      "hasStatus": false,
      "statusValues": [],
      "hasAuditFields": true,
      "isLookup": false,
      "fields": [
        { "name": "id", "type": "string", "label": "ID", "required": true, "unique": true, "defaultValue": null }
      ],
      "relationships": [
        { "type": "belongsTo", "entity": "OtherEntity", "foreignKey": "otherId" }
      ]
    }
  ]
}
Reject shallow models: include every distinct business entity seen across pages, each with fields[].`;
  }
  if (task === 'workflow') {
    return `${app}${sharedHint}
${noteDuty}
Read entity-model.json and shared working notes (and any unread pages). Infer workflows.
Write "${expectedArtifact}" with this EXACT shape (use states/transitions/actors, not steps):
{
  "workflows": [
    {
      "name": "Entity Lifecycle",
      "description": "...",
      "entityName": "EntityName",
      "states": ["Draft", "Submitted", "Approved"],
      "actors": ["User", "Manager"],
      "autoTransitions": [],
      "isApprovalWorkflow": true,
      "transitions": [
        {
          "from": "Draft",
          "to": "Submitted",
          "trigger": "Submit",
          "actor": "User",
          "conditions": [],
          "notifications": [],
          "approvalRequired": false
        }
      ]
    }
  ]
}
Include every distinct business workflow seen across pages.`;
  }
  return `${app}${sharedHint}
${noteDuty}
Read entity-model.json and shared working notes (and any unread pages). Infer permission matrix.
Write "${expectedArtifact}" with shape:
{
  "modules": ["ModuleA", "ModuleB"],
  "roles": [
    {
      "name": "RoleName",
      "description": "...",
      "level": "admin|manager|user|readonly",
      "permissions": [
        {
          "module": "ModuleA",
          "resource": "EntityName",
          "view": true,
          "create": false,
          "edit": false,
          "delete": false,
          "approve": false,
          "import": false,
          "export": false,
          "configure": false
        }
      ]
    }
  ]
}
Every role MUST include a non-empty permissions[] array. Roles with only name/description will be rejected.`;
}

function runTool(
  workspace: SynthesisWorkspace,
  name: string,
  argsJson: string,
  coverage: CoverageState,
  req: CoverageRequirements,
  allowedArtifacts: Set<string>,
): { result: string; wroteArtifact?: string; coverage: CoverageState; rejectReason?: string } {
  let args: Record<string, unknown> = {};
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch {
    return {
      result: JSON.stringify({ error: 'Invalid tool arguments JSON' }),
      coverage,
      rejectReason: 'Invalid tool arguments JSON',
    };
  }

  const pagesRead = new Set(coverage.pagesRead);
  const apisRead = new Set(coverage.apisRead);
  const harsRead = new Set(coverage.harsRead);
  const graphRead = new Set(coverage.graphChunksRead);

  const markPages = (ids: string[]) => ids.forEach((id) => pagesRead.add(id));
  const markApis = (ids: string[]) => ids.forEach((id) => apisRead.add(id));
  const markHars = (ids: string[]) => ids.forEach((id) => harsRead.add(id));
  const markGraph = (ids: string[]) => ids.forEach((id) => graphRead.add(id));

  const nextCoverage = (): CoverageState => ({
    pagesRead: [...pagesRead],
    apisRead: [...apisRead],
    harsRead: [...harsRead],
    graphChunksRead: [...graphRead],
  });

  try {
    if (name === 'get_coverage') {
      const snap = snapshotCoverage(workspace, nextCoverage(), req);
      return { result: JSON.stringify(snap, null, 2), coverage: nextCoverage() };
    }

    if (name === 'list_page_analyses') {
      return {
        result: JSON.stringify({ count: workspace.index.length, pages: workspace.index }, null, 2),
        coverage,
      };
    }

    if (name === 'list_network_calls') {
      return {
        result: JSON.stringify({ count: workspace.networkIndex.length, calls: workspace.networkIndex }, null, 2),
        coverage,
      };
    }

    if (name === 'list_har_files' || name === 'list_har_summaries') {
      return {
        result: JSON.stringify({ count: workspace.harIndex.length, hars: workspace.harIndex }, null, 2),
        coverage,
      };
    }

    if (name === 'list_graph_chunks') {
      return {
        result: JSON.stringify({ count: workspace.graphChunkIndex.length, chunks: workspace.graphChunkIndex }, null, 2),
        coverage,
      };
    }

    if (name === 'read_next_unread_pages') {
      const limit = Math.min(20, Math.max(1, Number(args['limit'] ?? 16) || 16));
      const unread = workspace.index.filter((p) => !pagesRead.has(p.id)).slice(0, limit);
      const items = unread.map((entry) => {
        const abs = resolveWorkspacePath(workspace.root, path.join('page-analyses', entry.file));
        markPages([entry.id]);
        return JSON.parse(fs.readFileSync(abs, 'utf-8'));
      });
      const cov = nextCoverage();
      return {
        result: JSON.stringify({
          returned: items.length,
          coverage: snapshotCoverage(workspace, cov, req),
          items,
        }),
        coverage: cov,
      };
    }

    if (name === 'read_next_unread_apis') {
      const limit = Math.min(50, Math.max(1, Number(args['limit'] ?? 25) || 25));
      const unread = workspace.networkIndex.filter((p) => !apisRead.has(p.id)).slice(0, limit);
      const items: unknown[] = [];
      const errors: string[] = [];
      for (const entry of unread) {
        try {
          const abs = resolveWorkspacePath(workspace.root, path.join('network-calls', entry.file));
          items.push(JSON.parse(fs.readFileSync(abs, 'utf-8')));
          markApis([entry.id]);
        } catch (err) {
          // Still mark read so a bad filename cannot permanently block coverage
          markApis([entry.id]);
          errors.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const cov = nextCoverage();
      return {
        result: JSON.stringify({
          returned: items.length,
          skippedErrors: errors.length ? errors : undefined,
          coverage: snapshotCoverage(workspace, cov, req),
          items,
        }),
        coverage: cov,
      };
    }

    if (name === 'read_next_unread_hars') {
      const limit = Math.min(10, Math.max(1, Number(args['limit'] ?? 5) || 5));
      const unread = workspace.harIndex.filter((p) => !harsRead.has(p.id)).slice(0, limit);
      const items: unknown[] = [];
      const errors: string[] = [];
      for (const entry of unread) {
        try {
          const abs = resolveWorkspacePath(workspace.root, path.join('har', entry.file));
          items.push(JSON.parse(fs.readFileSync(abs, 'utf-8')));
          markHars([entry.id]);
        } catch (err) {
          markHars([entry.id]);
          errors.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const cov = nextCoverage();
      return {
        result: JSON.stringify({
          returned: items.length,
          skippedErrors: errors.length ? errors : undefined,
          coverage: snapshotCoverage(workspace, cov, req),
          items,
        }),
        coverage: cov,
      };
    }

    if (name === 'read_next_unread_graph_chunks') {
      const limit = Math.min(20, Math.max(1, Number(args['limit'] ?? 10) || 10));
      const unread = workspace.graphChunkIndex.filter((p) => !graphRead.has(p.id)).slice(0, limit);
      const items = unread.map((entry) => {
        const abs = resolveWorkspacePath(workspace.root, path.join('graph-chunks', entry.file));
        markGraph([entry.id]);
        return JSON.parse(fs.readFileSync(abs, 'utf-8'));
      });
      const cov = nextCoverage();
      return {
        result: JSON.stringify({
          returned: items.length,
          coverage: snapshotCoverage(workspace, cov, req),
          items,
        }),
        coverage: cov,
      };
    }

    if (name === 'read_page_analysis') {
      const snap = snapshotCoverage(workspace, nextCoverage(), req);
      // Stop the architecture/KG death spiral: re-reading pages while APIs/HARs remain unread
      if (snap.pages.unread === 0 && req.requireAllApis && snap.apis.unread > 0) {
        return {
          result: JSON.stringify({
            error: 'pages already fully covered — refuse read_page_analysis',
            coverage: snap,
            hint: `Call read_next_unread_apis with limit=25 (${snap.apis.unread} APIs still unread)`,
          }),
          coverage,
        };
      }
      if (snap.pages.unread === 0 && req.requireAllHars && snap.hars.unread > 0) {
        return {
          result: JSON.stringify({
            error: 'pages already fully covered — refuse read_page_analysis',
            coverage: snap,
            hint: `Call read_next_unread_hars with limit=5 (${snap.hars.unread} HAR files still unread)`,
          }),
          coverage,
        };
      }
      if (snap.pages.unread === 0 && req.requireAllGraphChunks && snap.graphChunks.unread > 0) {
        return {
          result: JSON.stringify({
            error: 'pages already fully covered — refuse read_page_analysis',
            coverage: snap,
            hint: `Call read_next_unread_graph_chunks (${snap.graphChunks.unread} chunks still unread)`,
          }),
          coverage,
        };
      }
      const id = String(args['id'] ?? '');
      const fileName = id.endsWith('.json') ? id : `${id}.json`;
      const fromIndex = workspace.index.find((p) => p.id === id || p.file === fileName || p.file === id);
      const rel = path.join('page-analyses', fromIndex?.file ?? fileName);
      const abs = resolveWorkspacePath(workspace.root, rel);
      if (!fs.existsSync(abs)) {
        return { result: JSON.stringify({ error: `Not found: ${id}` }), coverage };
      }
      if (fromIndex) markPages([fromIndex.id]);
      return { result: fs.readFileSync(abs, 'utf-8'), coverage: nextCoverage() };
    }

    if (name === 'search_page_analyses') {
      const query = String(args['query'] ?? '').toLowerCase();
      const limit = Math.min(50, Number(args['limit'] ?? 20) || 20);
      const matches: Array<{ id: string; url: string; snippet: string }> = [];
      for (const entry of workspace.index) {
        if (matches.length >= limit) break;
        const abs = resolveWorkspacePath(workspace.root, path.join('page-analyses', entry.file));
        const raw = fs.readFileSync(abs, 'utf-8');
        const idx = raw.toLowerCase().indexOf(query);
        if (idx === -1) continue;
        const start = Math.max(0, idx - 80);
        matches.push({ id: entry.id, url: entry.url, snippet: raw.slice(start, start + 200).replace(/\s+/g, ' ') });
      }
      return { result: JSON.stringify({ query, matches }, null, 2), coverage };
    }

    if (name === 'append_working_notes') {
      const note = String(args['note'] ?? '');
      const abs = resolveWorkspacePath(workspace.root, 'working-notes.json');
      const prev = readJson<{ notes: string[] }>(abs) ?? { notes: [] };
      prev.notes.push(`[${new Date().toISOString()}] ${note}`);
      writeJson(abs, prev);
      return { result: JSON.stringify({ ok: true, noteCount: prev.notes.length }), coverage };
    }

    if (name === 'read_working_notes') {
      const abs = resolveWorkspacePath(workspace.root, 'working-notes.json');
      const prev = readJson<{ notes: string[] }>(abs) ?? { notes: [] };
      return { result: JSON.stringify(prev, null, 2), coverage };
    }

    if (name === 'read_artifact') {
      const artifactName = String(args['name'] ?? '');
      if (!allowedArtifacts.has(artifactName)) {
        return { result: JSON.stringify({ error: `Artifact not allowed: ${artifactName}` }), coverage };
      }
      const abs = resolveWorkspacePath(workspace.root, artifactName);
      if (!fs.existsSync(abs)) {
        return { result: JSON.stringify({ error: `Missing artifact: ${artifactName}` }), coverage };
      }
      return { result: fs.readFileSync(abs, 'utf-8'), coverage };
    }

    if (name === 'write_artifact') {
      const artifactName = String(args['name'] ?? '');
      let content: unknown = args['content'];
      if (typeof content === 'string') {
        try {
          content = JSON.parse(content);
        } catch {
          return {
            result: JSON.stringify({ error: 'content string is not valid JSON' }),
            coverage,
            rejectReason: 'content string is not valid JSON',
          };
        }
      }
      if (!allowedArtifacts.has(artifactName)) {
        return {
          result: JSON.stringify({ error: `Artifact not allowed: ${artifactName}` }),
          coverage,
          rejectReason: `Artifact not allowed: ${artifactName}`,
        };
      }
      const cov = nextCoverage();
      const snap = snapshotCoverage(workspace, cov, req);
      if (!snap.complete) {
        return {
          result: JSON.stringify({
            error: 'Coverage incomplete — refuse to write artifact and miss data',
            coverage: snap,
            hint: 'Call read_next_unread_* until get_coverage.complete=true',
          }),
          coverage: cov,
          rejectReason: 'Coverage incomplete',
        };
      }
      if (content === undefined || content === null || typeof content !== 'object') {
        return {
          result: JSON.stringify({ error: 'content must be a JSON object' }),
          coverage: cov,
          rejectReason: 'content must be a JSON object',
        };
      }

      // Knowledge graph: merge compact LLM enrichment onto structural scaffold
      if (artifactName === 'knowledge-graph.json') {
        const scaffold = ensureKnowledgeGraphScaffold(workspace);
        content = mergeKnowledgeGraph(content as Record<string, unknown>, scaffold);
      }

      const schemaError = validateArtifactContent(artifactName, content);
      if (schemaError) {
        return {
          result: JSON.stringify({
            error: `Artifact schema invalid: ${schemaError}`,
            hint: 'Fix the JSON shape and call write_artifact again',
          }),
          coverage: cov,
          rejectReason: schemaError,
        };
      }
      const abs = resolveWorkspacePath(workspace.root, artifactName);
      writeJson(abs, content);
      writeJson(resolveWorkspacePath(workspace.root, 'coverage-final.json'), snap);
      return {
        result: JSON.stringify({ ok: true, path: artifactName, coverage: snap }),
        wroteArtifact: artifactName,
        coverage: cov,
      };
    }

    return { result: JSON.stringify({ error: `Unknown tool: ${name}` }), coverage };
  } catch (err) {
    return {
      result: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      coverage,
    };
  }
}

/** Compact long histories without breaking OpenAI tool_call / tool message pairing. */
function compactMessages(
  messages: ChatCompletionMessageParam[],
  coverageSnap: CoverageSnapshot,
  expectedArtifact: string,
): ChatCompletionMessageParam[] {
  if (messages.length < 48) return messages;

  const system = messages[0];
  const drainHint =
    coverageSnap.pages.unread === 0 && coverageSnap.apis.unread > 0
      ? `Pages are done. Call read_next_unread_apis (limit=25) — ${coverageSnap.apis.unread} APIs unread. Do NOT call read_page_analysis.`
      : coverageSnap.pages.unread === 0 && coverageSnap.hars.unread > 0
        ? `Pages are done. Call read_next_unread_hars (limit=5) — ${coverageSnap.hars.unread} HAR files unread. Do NOT call read_page_analysis.`
      : coverageSnap.complete
        ? `Coverage is complete. Call write_artifact "${expectedArtifact}" now with the FULL valid JSON object (do not omit required arrays/fields).`
        : `Continue read_next_unread_* until get_coverage.complete=true, append_working_notes, then write_artifact "${expectedArtifact}".`;

  // Hard reset: durable state lives on disk (coverage-state + working-notes).
  // Never keep a sliced tail that can orphan role:tool messages.
  return [
    system!,
    {
      role: 'user',
      content: [
        'Conversation was compacted to stay within context limits.',
        'Authoritative state is on disk: coverage-state.json and working-notes.json (call read_working_notes / get_coverage).',
        `Current coverage: ${JSON.stringify(coverageSnap)}`,
        drainHint,
      ].join('\n'),
    },
  ];
}

function buildStructuralKnowledgeGraph(workspace: SynthesisWorkspace): Record<string, unknown> {
  const entityModel = readJson<{ entities?: Array<{ name: string; primaryModule?: string }> }>(
    resolveWorkspacePath(workspace.root, 'entity-model.json'),
  );
  const entities = Array.isArray(entityModel?.entities) ? entityModel!.entities! : [];

  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const moduleCounts = new Map<string, number>();

  const addNode = (node: Record<string, unknown>) => {
    const id = String(node['id'] ?? '');
    if (!id || nodeIds.has(id)) return;
    nodeIds.add(id);
    nodes.push(node);
  };
  const addEdge = (from: string, to: string, type: string) => {
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) return;
    const key = `${from}|${to}|${type}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, type });
  };

  for (const mod of new Set(
    workspace.index.map((p) => p.module).filter((m): m is string => Boolean(m && m.trim())),
  )) {
    addNode({ id: `module:${mod}`, type: 'module', label: mod, properties: {} });
  }

  for (const ent of entities) {
    if (!ent?.name) continue;
    addNode({
      id: `entity:${ent.name}`,
      type: 'entity',
      label: ent.name,
      properties: { module: ent.primaryModule ?? null },
    });
    if (ent.primaryModule) {
      addNode({ id: `module:${ent.primaryModule}`, type: 'module', label: ent.primaryModule, properties: {} });
      addEdge(`entity:${ent.name}`, `module:${ent.primaryModule}`, 'belongs_to_module');
    }
  }

  for (const page of workspace.index) {
    const pageId = `page:${page.id}`;
    addNode({
      id: pageId,
      type: 'page',
      label: page.title ?? page.url,
      properties: { url: page.url, module: page.module, entity: page.entity },
    });
    if (page.module) {
      moduleCounts.set(page.module, (moduleCounts.get(page.module) ?? 0) + 1);
      addNode({ id: `module:${page.module}`, type: 'module', label: page.module, properties: {} });
      addEdge(pageId, `module:${page.module}`, 'belongs_to_module');
    }
    if (page.entity) {
      addNode({ id: `entity:${page.entity}`, type: 'entity', label: page.entity, properties: {} });
      addEdge(pageId, `entity:${page.entity}`, 'shows_entity');
    }
  }

  for (const call of workspace.networkIndex) {
    const apiId = `api:${call.id}`;
    addNode({
      id: apiId,
      type: 'api',
      label: `${call.method} ${call.url.slice(0, 80)}`,
      properties: { method: call.method, status: call.status, url: call.url },
    });
  }

  const topModules = [...moduleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name]) => name);

  return {
    nodes,
    edges,
    modules: topModules,
    summary: {
      totalPages: workspace.index.length,
      totalEntities: entities.length,
      totalAPIs: workspace.networkIndex.length,
      topModules,
      coreEntities: entities.slice(0, 12).map((e) => e.name),
    },
  };
}

function mergeKnowledgeGraph(
  llmContent: Record<string, unknown>,
  scaffold: Record<string, unknown>,
): Record<string, unknown> {
  const scaffoldNodes = Array.isArray(scaffold['nodes'])
    ? (scaffold['nodes'] as Array<Record<string, unknown>>)
    : [];
  const scaffoldEdges = Array.isArray(scaffold['edges'])
    ? (scaffold['edges'] as Array<Record<string, unknown>>)
    : [];

  const llmNodes = Array.isArray(llmContent['nodes'])
    ? (llmContent['nodes'] as Array<Record<string, unknown>>)
    : [];
  const extraNodes = Array.isArray(llmContent['extraNodes'])
    ? (llmContent['extraNodes'] as Array<Record<string, unknown>>)
    : [];
  const llmEdges = Array.isArray(llmContent['edges'])
    ? (llmContent['edges'] as Array<Record<string, unknown>>)
    : [];

  // Prefer scaffold nodes (complete catalog). Accept LLM full graph only if it has a solid node set.
  const useLlmNodes = llmNodes.length >= Math.max(20, Math.floor(scaffoldNodes.length * 0.5));
  const nodes = useLlmNodes ? llmNodes : [...scaffoldNodes, ...extraNodes];

  const nodeIds = new Set(nodes.map((n) => String(n['id'] ?? '')).filter(Boolean));
  const edgeKeys = new Set<string>();
  const edges: Array<Record<string, unknown>> = [];
  for (const edge of [...scaffoldEdges, ...llmEdges]) {
    const from = String(edge['from'] ?? edge['source'] ?? '');
    const to = String(edge['to'] ?? edge['target'] ?? '');
    const type = String(edge['type'] ?? edge['relation'] ?? 'related');
    if (!from || !to) continue;
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
    const key = `${from}|${to}|${type}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ from, to, type });
  }

  const scaffoldSummary =
    scaffold['summary'] && typeof scaffold['summary'] === 'object'
      ? (scaffold['summary'] as Record<string, unknown>)
      : {};
  const llmSummary =
    llmContent['summary'] && typeof llmContent['summary'] === 'object'
      ? (llmContent['summary'] as Record<string, unknown>)
      : {};

  const modules = Array.isArray(llmContent['modules'])
    ? llmContent['modules']
    : Array.isArray(scaffold['modules'])
      ? scaffold['modules']
      : [];

  return {
    nodes,
    edges,
    modules,
    summary: {
      ...scaffoldSummary,
      ...llmSummary,
      totalPages: llmSummary['totalPages'] ?? scaffoldSummary['totalPages'],
      totalEntities: llmSummary['totalEntities'] ?? scaffoldSummary['totalEntities'],
      totalAPIs: llmSummary['totalAPIs'] ?? scaffoldSummary['totalAPIs'],
    },
  };
}

function ensureKnowledgeGraphScaffold(workspace: SynthesisWorkspace): Record<string, unknown> {
  const scaffoldPath = resolveWorkspacePath(workspace.root, 'knowledge-graph-scaffold.json');
  const existing = readJson<Record<string, unknown>>(scaffoldPath);
  if (existing && Array.isArray(existing['nodes']) && (existing['nodes'] as unknown[]).length > 0) {
    return existing;
  }
  const scaffold = buildStructuralKnowledgeGraph(workspace);
  writeJson(scaffoldPath, scaffold);
  logger.info(
    `[SynthesisAgent] knowledge-graph scaffold ready: ${(scaffold['nodes'] as unknown[]).length} nodes, ${(scaffold['edges'] as unknown[]).length} edges`,
  );
  return scaffold;
}

function validateArtifactContent(name: string, content: unknown): string | null {
  if (!content || typeof content !== 'object') return 'content must be a JSON object';
  const obj = content as Record<string, unknown>;

  if (name === 'entity-model.json') {
    if (!Array.isArray(obj['entities']) || obj['entities'].length === 0) {
      return 'entity-model.json requires non-empty entities[]';
    }
    for (const ent of obj['entities'] as Array<Record<string, unknown>>) {
      if (!ent['name'] || typeof ent['name'] !== 'string') {
        return 'each entity requires a string name';
      }
      const hasFields = Array.isArray(ent['fields']);
      const hasAttributes = Array.isArray(ent['attributes']);
      if (!hasFields && !hasAttributes) {
        return `entity "${ent['name']}" is missing fields[] (use fields, not only name/description)`;
      }
    }
  }

  if (name === 'workflow-model.json') {
    if (!Array.isArray(obj['workflows'])) {
      return 'workflow-model.json requires workflows[]';
    }
    for (const wf of obj['workflows'] as Array<Record<string, unknown>>) {
      if (!wf['name'] || typeof wf['name'] !== 'string') {
        return 'each workflow requires a string name';
      }
      const hasStates = Array.isArray(wf['states']);
      const hasSteps = Array.isArray(wf['steps']);
      if (!hasStates && !hasSteps) {
        return `workflow "${wf['name']}" is missing states[] (or steps[] that can be normalized)`;
      }
    }
  }

  if (name === 'permission-matrix.json') {
    const roles = obj['roles'];
    if (!Array.isArray(roles) || roles.length === 0) {
      return 'permission-matrix.json requires non-empty roles[]';
    }
    for (const role of roles as Array<Record<string, unknown>>) {
      if (!Array.isArray(role['permissions'])) {
        return `role "${String(role['name'] ?? '?')}" is missing permissions[] (each role must include permissions array with module/resource CRUD flags)`;
      }
    }
    const anyPerms = (roles as Array<Record<string, unknown>>).some(
      (r) => Array.isArray(r['permissions']) && (r['permissions'] as unknown[]).length > 0,
    );
    if (!anyPerms) {
      return 'all roles have empty permissions[] — include at least one permission entry per role';
    }
    if (!Array.isArray(obj['modules'])) {
      return 'permission-matrix.json requires modules[]';
    }
  }

  if (name === 'architecture.json') {
    if (typeof obj['frontendFramework'] !== 'string' || typeof obj['backendPattern'] !== 'string') {
      return 'architecture.json requires frontendFramework and backendPattern strings';
    }
  }

  if (name === 'knowledge-graph.json') {
    // After normalize/merge, nodes+edges must exist. Enrichment-only payloads are merged first.
    if (!Array.isArray(obj['nodes']) || obj['nodes'].length === 0) {
      return 'knowledge-graph.json requires non-empty nodes[] (scaffold merge failed)';
    }
    if (!Array.isArray(obj['edges'])) {
      return 'knowledge-graph.json requires edges[] (may be empty)';
    }
  }

  if (name.endsWith('-findings.json')) {
    if (!Array.isArray(obj['findings'])) {
      return `${name} requires findings[]`;
    }
    for (const finding of obj['findings'] as Array<Record<string, unknown>>) {
      if (typeof finding['title'] !== 'string' || typeof finding['detail'] !== 'string') {
        return `${name} findings require string title and detail fields`;
      }
      if (!Array.isArray(finding['evidenceNodeIds']) || finding['evidenceNodeIds'].length === 0) {
        return `${name} finding "${String(finding['title'] ?? '?')}" requires at least one evidenceNodeId`;
      }
    }
  }

  return null;
}

export async function runSynthesisAgent<T>(args: {
  workspace: SynthesisWorkspace;
  task: SynthesisTask;
  expectedArtifact: string;
  appName?: string;
  llmConfig?: LLMConfig;
  maxSteps?: number;
  maxTokens?: number;
  coverage?: CoverageRequirements;
  specialistFocus?: string;
  extraAllowedArtifacts?: string[];
  /**
   * When true (default for workflow/permission/arch/KG), reuse prior page coverage +
   * working-notes.json instead of re-reading every page analysis.
   * Entity always does a fresh page drain and seeds shared notes.
   */
  reuseSharedEvidence?: boolean;
}): Promise<SynthesisAgentResult<T>> {
  const allowed = new Set([...ALLOWED_ARTIFACTS, ...(args.extraAllowedArtifacts ?? [])]);
  if (!allowed.has(args.expectedArtifact) && !args.expectedArtifact.endsWith('-findings.json')) {
    // allow specialist dynamic names via extraAllowedArtifacts
    if (!args.extraAllowedArtifacts?.includes(args.expectedArtifact)) {
      throw new Error(`Unsupported artifact: ${args.expectedArtifact}`);
    }
  }
  allowed.add(args.expectedArtifact);

  const req = args.coverage ?? defaultRequirements(args.task);
  const { client, model, baseUrl } = createClient(args.llmConfig);
  const tools = buildTools([...allowed]);

  const wantReuse = args.reuseSharedEvidence ?? defaultReuseSharedEvidence(args.task);
  let coverage = loadCoverage(args.workspace);
  const sharedGraphReady =
    args.task === 'specialist' && wantReuse && canReuseSharedGraphEvidence(args.workspace, coverage);
  const sharedPagesReady =
    args.task !== 'entity' &&
    args.task !== 'specialist' &&
    wantReuse &&
    canReuseSharedPageEvidence(args.workspace, coverage);

  if (args.task === 'entity' || (!wantReuse && args.task !== 'specialist')) {
    // Fresh page drain — seeds shared notes for later stages
    coverage = { pagesRead: [], apisRead: [], harsRead: [], graphChunksRead: [] };
    writeJson(resolveWorkspacePath(args.workspace.root, 'working-notes.json'), { notes: [] });
  } else if (args.task === 'specialist') {
    if (sharedGraphReady) {
      logger.info(
        `[SynthesisAgent] specialist: reusing shared graph coverage (${coverage.graphChunksRead.length}/${args.workspace.graphChunkIndex.length}) + ${loadWorkingNotes(args.workspace).notes.length} notes — skipping chunk re-read`,
      );
    } else if (wantReuse && coverage.graphChunksRead.length > 0) {
      logger.info(
        `[SynthesisAgent] specialist: continuing shared graph coverage (${coverage.graphChunksRead.length} chunks already read)`,
      );
    } else {
      coverage = {
        pagesRead: coverage.pagesRead,
        apisRead: coverage.apisRead,
        harsRead: coverage.harsRead,
        graphChunksRead: [],
      };
      // Independent specialists must not inherit another specialist's interpretation.
      if (!wantReuse || loadWorkingNotes(args.workspace).notes.length === 0) {
        writeJson(resolveWorkspacePath(args.workspace.root, 'working-notes.json'), { notes: [] });
      }
    }
  } else if (sharedPagesReady) {
    // Keep pagesRead + working notes; reset only newly required evidence streams
    coverage = {
      pagesRead: coverage.pagesRead,
      apisRead: req.requireAllApis ? [] : coverage.apisRead,
      harsRead: req.requireAllHars ? [] : coverage.harsRead,
      graphChunksRead: req.requireAllGraphChunks ? [] : coverage.graphChunksRead,
    };
    logger.info(
      `[SynthesisAgent] ${args.task}: reusing shared page coverage (${coverage.pagesRead.length}/${args.workspace.index.length}) + ${loadWorkingNotes(args.workspace).notes.length} notes — skipping page re-read`,
    );
  } else if (wantReuse) {
    // Partial prior coverage: continue draining unread pages, keep existing notes
    coverage = {
      pagesRead: coverage.pagesRead,
      apisRead: req.requireAllApis ? [] : coverage.apisRead,
      harsRead: req.requireAllHars ? [] : coverage.harsRead,
      graphChunksRead: req.requireAllGraphChunks ? [] : coverage.graphChunksRead,
    };
    logger.info(
      `[SynthesisAgent] ${args.task}: continuing shared coverage (${coverage.pagesRead.length} pages already read, notes=${loadWorkingNotes(args.workspace).notes.length})`,
    );
  }

  saveCoverage(args.workspace, coverage);

  if (args.task === 'knowledge-graph') {
    ensureKnowledgeGraphScaffold(args.workspace);
  }

  const initialBudget = Math.max(
    args.maxSteps ?? config.llm.synthesisMaxSteps,
    estimateRemainingSteps(args.workspace, coverage, req),
  );
  let stepBudget = initialBudget;
  const hardCeiling = Math.max(initialBudget, config.llm.synthesisMaxStepsCeiling);

  logger.info(
    `[SynthesisAgent] ${args.task} using model=${model}` +
      (baseUrl ? ` baseUrl=${baseUrl}` : '') +
      ` stepBudget=${stepBudget} ceiling=${hardCeiling}`,
  );

  const sharedReady = sharedPagesReady || sharedGraphReady;

  let messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content:
        'You are a reverse-engineering synthesis agent with a local evidence workspace. ' +
        'Explore with tools. Never invent missing files. ' +
        'Prefer durable working-notes.json over re-reading raw evidence when shared coverage is ready. ' +
        'You MUST reach get_coverage.complete=true before write_artifact. Missing data is unacceptable.',
    },
    {
      role: 'user',
      content: [
        taskBrief(
          args.task,
          args.appName,
          args.expectedArtifact,
          args.specialistFocus,
          sharedPagesReady,
          sharedGraphReady,
        ),
        '',
        `Evidence counts: pages=${args.workspace.index.length}, apis=${args.workspace.networkIndex.length}, hars=${args.workspace.harIndex.length}, graphChunks=${args.workspace.graphChunkIndex.length}`,
        sharedReady
          ? 'Start with get_coverage + read_working_notes (+ read_artifact for prior models), then write_artifact.'
          : 'Start with get_coverage, then read_next_unread_* loops, append_working_notes, then write_artifact.',
      ].join('\n'),
    },
  ];

  let wrote: string | undefined;
  let step = 0;
  let stallCount = 0;
  let writeRejectCount = 0;

  while (true) {
    step += 1;

    if (step > stepBudget) {
      const snapExtend = snapshotCoverage(args.workspace, coverage, req);
      // Knowledge graph: if coverage is done but LLM can't emit a valid write, salvage scaffold.
      if (args.task === 'knowledge-graph' && snapExtend.complete && writeRejectCount >= 2) {
        const scaffold = ensureKnowledgeGraphScaffold(args.workspace);
        const abs = resolveWorkspacePath(args.workspace.root, args.expectedArtifact);
        writeJson(abs, scaffold);
        writeJson(resolveWorkspacePath(args.workspace.root, 'coverage-final.json'), snapExtend);
        logger.warn(
          `[SynthesisAgent] knowledge-graph: auto-salvaged structural scaffold after ${writeRejectCount} rejected writes (${(scaffold['nodes'] as unknown[]).length} nodes)`,
        );
        return {
          artifact: scaffold as T,
          artifactPath: abs,
          steps: step,
          coverage: snapExtend,
        };
      }
      if (step > hardCeiling) {
        throw new Error(
          `[SynthesisAgent] ${args.task} exceeded the hard step ceiling (${hardCeiling}); ` +
            `unread pages=${snapExtend.pages.unread}, apis=${snapExtend.apis.unread}, ` +
            `hars=${snapExtend.hars.unread}, graph=${snapExtend.graphChunks.unread}`,
        );
      }
      const need = estimateRemainingSteps(args.workspace, coverage, req);
      const extension = Math.max(config.llm.synthesisMaxSteps, need, 60);
      const nextBudget = Math.min(hardCeiling, stepBudget + extension);
      logger.info(
        `[SynthesisAgent] ${args.task}: extending step budget ${stepBudget} → ${nextBudget} ` +
          `(hardCeiling=${hardCeiling}; unread pages=${snapExtend.pages.unread} apis=${snapExtend.apis.unread} hars=${snapExtend.hars.unread} graph=${snapExtend.graphChunks.unread})`,
      );
      stepBudget = nextBudget;
    }

    // Deterministic drain when the model stalls (coverage incomplete)
    const snapBefore = snapshotCoverage(args.workspace, coverage, req);
    if (!snapBefore.complete && stallCount >= 3) {
      const drainTool =
        req.requireAllApis && snapBefore.apis.unread > 0
          ? 'read_next_unread_apis'
          : req.requireAllHars && snapBefore.hars.unread > 0
            ? 'read_next_unread_hars'
          : req.requireAllPages && snapBefore.pages.unread > 0
            ? 'read_next_unread_pages'
            : req.requireAllGraphChunks && snapBefore.graphChunks.unread > 0
              ? 'read_next_unread_graph_chunks'
              : null;
      if (drainTool) {
        logger.info(`[SynthesisAgent] ${args.task}: auto-draining via ${drainTool} (model stall)`);
        const out = runTool(
          args.workspace,
          drainTool,
          JSON.stringify({
            limit: drainTool.includes('apis') ? 25 : drainTool.includes('pages') ? 16 : 10,
          }),
          coverage,
          req,
          allowed,
        );
        coverage = out.coverage;
        saveCoverage(args.workspace, coverage);
        messages.push({
          role: 'user',
          content: `System auto-drained unread evidence with ${drainTool}. Coverage now: ${JSON.stringify(snapshotCoverage(args.workspace, coverage, req))}. Continue until complete, then write_artifact "${args.expectedArtifact}".`,
        });
        stallCount = 0;
        continue;
      }
    }

    messages = compactMessages(messages, snapBefore, args.expectedArtifact);

    const completion = await retryUntilSuccess(
      async () =>
        client.chat.completions.create({
          model,
          messages,
          tools,
          tool_choice: 'auto',
          max_completion_tokens: args.maxTokens ?? 8000,
          temperature: /^gpt-5/i.test(model) ? 1 : 0.2,
        }),
      {
        label: `Synthesis agent (${args.task}) step ${step}`,
        delayMs: 10_000,
        maxDelayMs: 180_000,
        backoffFactor: 1.7,
        shouldRetry: () => true, // never give up on LLM transport/model errors
      },
    );

    const msg = completion.choices[0]?.message;
    if (!msg) {
      stallCount += 1;
      messages.push({
        role: 'user',
        content: `Empty model response. Use tools to drain coverage then write_artifact "${args.expectedArtifact}".`,
      });
      continue;
    }

    messages.push({
      role: 'assistant',
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    } as ChatCompletionMessageParam);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      stallCount += 1;
      messages.push({
        role: 'user',
        content: sharedReady
          ? `Use tools. Read working notes / prior artifacts if needed, confirm get_coverage.complete, then write_artifact "${args.expectedArtifact}".`
          : `Use tools. Drain unread evidence (get_coverage) then write_artifact "${args.expectedArtifact}".`,
      });
      continue;
    }

    const progressTools = new Set([
      'read_next_unread_pages',
      'read_next_unread_apis',
      'read_next_unread_graph_chunks',
      'write_artifact',
      'append_working_notes',
    ]);
    let progressed = false;
    let attemptedWrite = false;

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      if (progressTools.has(call.function.name)) progressed = true;
      if (call.function.name === 'write_artifact') attemptedWrite = true;
      const out = runTool(
        args.workspace,
        call.function.name,
        call.function.arguments,
        coverage,
        req,
        allowed,
      );
      coverage = out.coverage;
      saveCoverage(args.workspace, coverage);
      if (out.wroteArtifact) {
        wrote = out.wroteArtifact;
        writeRejectCount = 0;
      } else if (call.function.name === 'write_artifact' && out.rejectReason) {
        writeRejectCount += 1;
        logger.warn(
          `[SynthesisAgent] ${args.task}: write_artifact rejected (#${writeRejectCount}): ${out.rejectReason}`,
        );
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: out.result.slice(0, 100_000),
      });
    }

    stallCount = progressed ? 0 : stallCount + 1;

    const snap = snapshotCoverage(args.workspace, coverage, req);
    logger.info(`[SynthesisAgent] ${args.task} step ${step}/${stepBudget}`, {
      tools: toolCalls.map((c) => (c.type === 'function' ? c.function.name : c.type)),
      coverage: snap,
      wrote,
      stallCount,
      writeRejectCount: attemptedWrite ? writeRejectCount : undefined,
    });

    // After repeated rejected KG writes with complete coverage, accept structural scaffold.
    if (
      !wrote &&
      args.task === 'knowledge-graph' &&
      snap.complete &&
      (writeRejectCount >= 3 || stallCount >= 5)
    ) {
      const scaffold = ensureKnowledgeGraphScaffold(args.workspace);
      const abs = resolveWorkspacePath(args.workspace.root, args.expectedArtifact);
      writeJson(abs, scaffold);
      writeJson(resolveWorkspacePath(args.workspace.root, 'coverage-final.json'), snap);
      logger.warn(
        `[SynthesisAgent] knowledge-graph: auto-salvaged structural scaffold ` +
          `(rejects=${writeRejectCount}, stall=${stallCount}, nodes=${(scaffold['nodes'] as unknown[]).length})`,
      );
      return {
        artifact: scaffold as T,
        artifactPath: abs,
        steps: step,
        coverage: snap,
      };
    }

    if (!wrote && snap.pages.unread === 0 && req.requireAllApis && snap.apis.unread > 0) {
      messages.push({
        role: 'user',
        content: `STOP re-reading pages. pages.unread=0 but apis.unread=${snap.apis.unread}. Call read_next_unread_apis with limit=25 now, then write_artifact "${args.expectedArtifact}" when complete.`,
      });
    } else if (!wrote && snap.pages.unread === 0 && req.requireAllHars && snap.hars.unread > 0) {
      messages.push({
        role: 'user',
        content: `STOP re-reading pages. pages.unread=0 but hars.unread=${snap.hars.unread}. Call read_next_unread_hars with limit=5 now, then write_artifact "${args.expectedArtifact}" when complete.`,
      });
    } else if (!wrote && snap.pages.unread === 0 && req.requireAllGraphChunks && snap.graphChunks.unread > 0) {
      messages.push({
        role: 'user',
        content: `STOP re-reading pages. Call read_next_unread_graph_chunks (limit=10). graphChunks.unread=${snap.graphChunks.unread}.`,
      });
    } else if (!wrote && snap.complete) {
      messages.push({
        role: 'user',
        content:
          args.task === 'knowledge-graph'
            ? `Coverage is complete. Call write_artifact "${args.expectedArtifact}" NOW with a COMPACT enrichment only: edges[], modules[], summary{} (nodes optional — scaffold already has all page/api/entity nodes). Keep the tool payload small.`
            : `Coverage is complete. Call write_artifact "${args.expectedArtifact}" NOW with the full valid JSON.`,
      });
    }

    if (wrote === args.expectedArtifact) {
      const abs = resolveWorkspacePath(args.workspace.root, args.expectedArtifact);
      const artifact = readJson<T>(abs);
      if (!artifact) {
        wrote = undefined;
        stallCount += 1;
        messages.push({
          role: 'user',
          content: `Artifact file missing after write. Call write_artifact "${args.expectedArtifact}" again.`,
        });
        continue;
      }

      if (args.task === 'entity' && snap.pages.unread === 0) {
        writeJson(resolveWorkspacePath(args.workspace.root, 'shared-evidence-meta.json'), {
          seededBy: 'entity',
          pagesRead: coverage.pagesRead.length,
          notes: loadWorkingNotes(args.workspace).notes.length,
          updatedAt: new Date().toISOString(),
        });
      }
      if (args.task === 'specialist' && snap.graphChunks.unread === 0) {
        writeJson(resolveWorkspacePath(args.workspace.root, 'shared-evidence-meta.json'), {
          seededBy: 'specialist',
          graphChunksRead: coverage.graphChunksRead.length,
          notes: loadWorkingNotes(args.workspace).notes.length,
          updatedAt: new Date().toISOString(),
        });
      }

      return { artifact, artifactPath: abs, steps: step, coverage: snap };
    }
  }
}
