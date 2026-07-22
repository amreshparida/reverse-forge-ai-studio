import fs from 'fs';
import path from 'path';
import { prisma } from '../database/client';
import { ensureDir, writeJson, readJson, getReportsDir, urlToFilename } from '../utils/file-system';
import { logger } from '../utils/logger';
import type { PageAnalysisResult } from './analyzer';

export interface PageAnalysisIndexEntry {
  id: string;
  file: string;
  url: string;
  title: string | null;
  module: string | null;
  entity: string | null;
  workflowStage: string | null;
}

export interface NetworkCallIndexEntry {
  id: string;
  file: string;
  method: string;
  url: string;
  status: number | null;
  resourceType: string | null;
  isGraphQL: boolean;
}

export interface GraphChunkIndexEntry {
  id: string;
  file: string;
  index: number;
  charLength: number;
}

export interface SynthesisWorkspace {
  root: string;
  pageAnalysesDir: string;
  networkCallsDir: string;
  graphChunksDir: string;
  indexPath: string;
  index: PageAnalysisIndexEntry[];
  networkIndex: NetworkCallIndexEntry[];
  graphChunkIndex: GraphChunkIndexEntry[];
}

export function getSynthesisWorkspaceDir(projectSlug: string, sessionId: string): string {
  return ensureDir(path.join(getReportsDir(projectSlug, sessionId), '_generation', 'workspace'));
}

export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  // Reject real traversal segments (../ or /..), not filenames that merely contain ".."
  // e.g. "bootstrap.js..json" must be allowed.
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '..' || seg === '')) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  const abs = path.resolve(workspaceRoot, normalized);
  const rootAbs = path.resolve(workspaceRoot);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return abs;
}

/** Safe on-disk name: no path separators, no ".." substring (avoids false path-escape hits). */
export function safeWorkspaceFileBase(raw: string, maxLen = 80): string {
  return raw
    .replace(/\.\./g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, maxLen);
}

function clearDir(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    fs.unlinkSync(path.join(dir, name));
  }
}

/**
 * Export all project page AI analyses onto disk for tool-using agents.
 */
export async function materializePageAnalysisWorkspace(args: {
  projectId: string;
  projectSlug: string;
  sessionId: string;
}): Promise<SynthesisWorkspace> {
  return materializeEvidenceWorkspace({ ...args, includeNetworkCalls: false, includeGraphChunks: false });
}

/**
 * Full evidence workspace: pages (+ optional APIs / graph chunks).
 * Used so Cursor-style agents can cover every artifact without stuffing prompts.
 */
export async function materializeEvidenceWorkspace(args: {
  projectId: string;
  projectSlug: string;
  sessionId: string;
  sourceSessionIds?: string[];
  includeNetworkCalls?: boolean;
  includeGraphChunks?: boolean;
  graphSnapshot?: unknown;
  graphChunkSize?: number;
}): Promise<SynthesisWorkspace> {
  const root = getSynthesisWorkspaceDir(args.projectSlug, args.sessionId);
  const pageAnalysesDir = ensureDir(path.join(root, 'page-analyses'));
  const networkCallsDir = ensureDir(path.join(root, 'network-calls'));
  const graphChunksDir = ensureDir(path.join(root, 'graph-chunks'));

  clearDir(pageAnalysesDir);
  if (args.includeNetworkCalls) clearDir(networkCallsDir);
  if (args.includeGraphChunks) clearDir(graphChunksDir);

  const pages = await prisma.pageCapture.findMany({
    where: {
      aiAnalysis: { not: null },
      crawlSession: { projectId: args.projectId },
    },
    select: { id: true, url: true, title: true, aiAnalysis: true },
    orderBy: { createdAt: 'asc' },
  });

  const seenUrls = new Set<string>();
  const index: PageAnalysisIndexEntry[] = [];

  for (const page of pages) {
    if (seenUrls.has(page.url)) continue;
    seenUrls.add(page.url);

    let analysis: PageAnalysisResult;
    try {
      analysis = JSON.parse(page.aiAnalysis!) as PageAnalysisResult;
    } catch {
      continue;
    }

    const fileBase = safeWorkspaceFileBase(urlToFilename(page.url, '').replace(/\.html$/i, '') || page.id.slice(0, 8), 120);
    const file = `${String(index.length + 1).padStart(3, '0')}_${fileBase}.json`.slice(0, 180);
    const id = path.basename(file, '.json');

    writeJson(path.join(pageAnalysesDir, file), {
      id,
      url: page.url,
      title: page.title,
      analysis,
    });

    index.push({
      id,
      file,
      url: page.url,
      title: page.title,
      module: analysis.businessModule ?? null,
      entity: analysis.primaryEntity ?? null,
      workflowStage: analysis.workflowStage ?? null,
    });
  }

  writeJson(path.join(pageAnalysesDir, 'index.json'), {
    count: index.length,
    pages: index,
  });

  const networkIndex: NetworkCallIndexEntry[] = [];
  if (args.includeNetworkCalls) {
    const sessionIds = args.sourceSessionIds?.length ? args.sourceSessionIds : [args.sessionId];
    const calls = await prisma.networkCall.findMany({
      where: { crawlSessionId: { in: sessionIds } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        method: true,
        url: true,
        queryParams: true,
        requestPayload: true,
        requestContentType: true,
        responseStatus: true,
        responseBody: true,
        responseContentType: true,
        responseSchemaKeys: true,
        resourceType: true,
        isGraphQL: true,
        graphQLOperationName: true,
        timingMs: true,
      },
    });

    // Deduplicate noisy identical method+url+status rows but keep payload variants
    const seen = new Set<string>();
    for (const call of calls) {
      const key = `${call.method}|${call.url}|${call.responseStatus}|${(call.responseSchemaKeys ?? '').slice(0, 80)}|${(call.requestPayload ?? '').slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const n = networkIndex.length + 1;
      const safeUrl = safeWorkspaceFileBase(call.url, 80);
      const file = `${String(n).padStart(4, '0')}_${call.method}_${safeUrl}.json`.slice(0, 180);
      const id = path.basename(file, '.json');
      writeJson(path.join(networkCallsDir, file), { ...call, id });
      networkIndex.push({
        id,
        file,
        method: call.method ?? 'GET',
        url: call.url,
        status: call.responseStatus,
        resourceType: call.resourceType,
        isGraphQL: Boolean(call.isGraphQL),
      });
    }

    writeJson(path.join(networkCallsDir, 'index.json'), {
      count: networkIndex.length,
      calls: networkIndex,
    });
  }

  const graphChunkIndex: GraphChunkIndexEntry[] = [];
  if (args.includeGraphChunks && args.graphSnapshot != null) {
    const text = JSON.stringify(args.graphSnapshot, null, 2);
    const chunkSize = args.graphChunkSize ?? 80_000;
    let offset = 0;
    let i = 0;
    while (offset < text.length) {
      const slice = text.slice(offset, offset + chunkSize);
      i += 1;
      const file = `chunk-${String(i).padStart(3, '0')}.json`;
      const id = path.basename(file, '.json');
      // Store as JSON wrapper so tools always return parseable objects
      writeJson(path.join(graphChunksDir, file), {
        id,
        index: i,
        totalHint: null,
        raw: slice,
      });
      graphChunkIndex.push({ id, file, index: i, charLength: slice.length });
      offset += chunkSize;
    }
    // Patch totalHint
    for (const entry of graphChunkIndex) {
      const abs = path.join(graphChunksDir, entry.file);
      const cur = JSON.parse(fs.readFileSync(abs, 'utf-8')) as Record<string, unknown>;
      cur['totalHint'] = graphChunkIndex.length;
      writeJson(abs, cur);
    }
    writeJson(path.join(graphChunksDir, 'index.json'), {
      count: graphChunkIndex.length,
      chunks: graphChunkIndex,
    });

    // Chunk set was rebuilt — invalidate prior graph coverage so IDs stay consistent
    const covPath = path.join(root, 'coverage-state.json');
    const cov = readJson<{ pagesRead: string[]; apisRead: string[]; graphChunksRead: string[] }>(covPath) ?? {
      pagesRead: [],
      apisRead: [],
      graphChunksRead: [],
    };
    writeJson(covPath, { ...cov, graphChunksRead: [] });
  }

  const indexPath = path.join(root, 'EVIDENCE-INDEX.json');
  writeJson(indexPath, {
    projectId: args.projectId,
    projectSlug: args.projectSlug,
    sessionId: args.sessionId,
    pages: index.length,
    networkCalls: networkIndex.length,
    graphChunks: graphChunkIndex.length,
  });

  writeJson(path.join(root, 'MANIFEST.json'), {
    purpose: 'Local evidence workspace for Cursor-style synthesis agents',
    completenessRule:
      'Entity drains all pages into working-notes.json. Later stages reuse coverage-state + notes and must not re-read pages unless unread>0. write_artifact blocked until required coverage is complete.',
    layout: {
      'page-analyses/': 'Full page AI analyses',
      'network-calls/': 'Network/API captures',
      'graph-chunks/': 'Shared analysis graph partitions',
      'working-notes.json': 'Shared durable notes (seeded by entity, reused by later stages)',
      'coverage-state.json': 'Read coverage tracker (pages persist across stages)',
      'shared-evidence-meta.json': 'Marker that shared page evidence was seeded',
    },
  });

  logger.info(
    `[SynthesisWorkspace] Evidence ready: ${index.length} pages, ${networkIndex.length} APIs, ${graphChunkIndex.length} graph chunks → ${root}`,
  );

  return {
    root,
    pageAnalysesDir,
    networkCallsDir,
    graphChunksDir,
    indexPath,
    index,
    networkIndex,
    graphChunkIndex,
  };
}
