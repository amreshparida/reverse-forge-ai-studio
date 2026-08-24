import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { prisma } from '../database/client';
import { ensureDir, writeJson, readJson, getReportsDir, getHarDir, getUploadedEvidenceDir, urlToFilename } from '../utils/file-system';
import { logger } from '../utils/logger';
import { extractReadableText } from '../evidence/import-service';
import type { PageAnalysisResult } from './analyzer';
import { isHarLog } from './har-summary';

export interface PageAnalysisIndexEntry {
  id: string;
  file: string;
  url: string;
  title: string | null;
  module: string | null;
  entity: string | null;
  workflowStage: string | null;
  sourceSessionId: string;
}

export interface NetworkCallIndexEntry {
  id: string;
  file: string;
  method: string;
  url: string;
  status: number | null;
  resourceType: string | null;
  isGraphQL: boolean;
  sourceSessionId: string;
}

export interface HarIndexEntry {
  id: string;
  file: string;
  pageUrl: string;
  entryCount: number;
  sourceSessionId: string;
  sourceHarFile: string;
}

export interface GraphChunkIndexEntry {
  id: string;
  file: string;
  index: number;
  charLength: number;
}

export interface UploadedEvidenceIndexEntry {
  id: string;
  file: string;
  filename: string;
  sourceSessionId: string;
  sizeBytes: number;
  hasFullText: boolean;
  characterCount: number;
}

export interface SynthesisWorkspace {
  root: string;
  pageAnalysesDir: string;
  networkCallsDir: string;
  harDir: string;
  graphChunksDir: string;
  uploadedEvidenceDir: string;
  indexPath: string;
  index: PageAnalysisIndexEntry[];
  networkIndex: NetworkCallIndexEntry[];
  harIndex: HarIndexEntry[];
  graphChunkIndex: GraphChunkIndexEntry[];
  uploadedEvidenceIndex: UploadedEvidenceIndexEntry[];
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

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprintFiles(root: string, entries: Array<{ id: string; file: string }>): string {
  const hashes = entries.map((entry) => {
    const data = fs.readFileSync(path.join(root, entry.file));
    return `${entry.id}:${data.length}:${createHash('sha256').update(data).digest('hex')}`;
  });
  return hashText(hashes.sort().join('\n'));
}

/**
 * Export all project page AI analyses onto disk for tool-using agents.
 */
export async function materializePageAnalysisWorkspace(args: {
  projectId: string;
  projectSlug: string;
  sessionId: string;
  sourceSessionIds?: string[];
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
  /** Prefer this over graphSnapshot for large graphs — chunks from file text without a full parse. */
  graphSnapshotFile?: string;
  graphChunkSize?: number;
}): Promise<SynthesisWorkspace> {
  const root = getSynthesisWorkspaceDir(args.projectSlug, args.sessionId);
  const priorIndex = readJson<{
    fingerprints?: {
      pages?: string;
      networkCalls?: string;
      harFiles?: string;
      graphChunks?: string;
      uploadedEvidence?: string;
    };
  }>(path.join(root, 'EVIDENCE-INDEX.json'));
  const sourceSessionIds = [...new Set(args.sourceSessionIds?.length ? args.sourceSessionIds : [args.sessionId])].sort();
  const validSessions = await prisma.crawlSession.findMany({
    where: { id: { in: sourceSessionIds }, projectId: args.projectId },
    select: { id: true },
  });
  const validSessionIds = new Set(validSessions.map((session) => session.id));
  const invalidSessionIds = sourceSessionIds.filter((id) => !validSessionIds.has(id));
  if (invalidSessionIds.length > 0) {
    throw new Error(`Evidence source sessions do not belong to project ${args.projectId}: ${invalidSessionIds.join(', ')}`);
  }
  const pageAnalysesDir = ensureDir(path.join(root, 'page-analyses'));
  const networkCallsDir = ensureDir(path.join(root, 'network-calls'));
  const harDir = ensureDir(path.join(root, 'har'));
  const graphChunksDir = ensureDir(path.join(root, 'graph-chunks'));
  const uploadedEvidenceDir = ensureDir(path.join(root, 'uploaded-evidence'));

  clearDir(pageAnalysesDir);
  clearDir(uploadedEvidenceDir);
  if (args.includeNetworkCalls) {
    clearDir(networkCallsDir);
    clearDir(harDir);
  }
  if (args.includeGraphChunks) clearDir(graphChunksDir);

  const pages = await prisma.pageCapture.findMany({
    where: {
      aiAnalysis: { not: null },
      crawlSessionId: { in: sourceSessionIds },
    },
    select: { id: true, url: true, title: true, aiAnalysis: true, crawlSessionId: true },
    // Prefer the newest capture when the same URL exists in multiple selected sessions.
    orderBy: { createdAt: 'desc' },
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
      sourceSessionId: page.crawlSessionId,
    });

    const coerceLabel = (value: unknown): string | null => {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || null;
      }
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return null;
    };

    index.push({
      id,
      file,
      url: page.url,
      title: page.title,
      module: coerceLabel(analysis.businessModule),
      entity: coerceLabel(analysis.primaryEntity),
      workflowStage: coerceLabel(analysis.workflowStage),
      sourceSessionId: page.crawlSessionId,
    });
  }

  writeJson(path.join(pageAnalysesDir, 'index.json'), {
    count: index.length,
    pages: index,
  });

  const networkIndex: NetworkCallIndexEntry[] = [];
  if (args.includeNetworkCalls) {
    const calls = await prisma.networkCall.findMany({
      where: { crawlSessionId: { in: sourceSessionIds } },
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
        crawlSessionId: true,
      },
    });

    // Deduplicate noisy identical method+url+status rows but keep payload variants
    const seen = new Set<string>();
    for (const call of calls) {
      const key = `${call.crawlSessionId}|${call.method}|${call.url}|${call.responseStatus}|${(call.responseSchemaKeys ?? '').slice(0, 80)}|${(call.requestPayload ?? '').slice(0, 80)}`;
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
        sourceSessionId: call.crawlSessionId,
      });
    }

    writeJson(path.join(networkCallsDir, 'index.json'), {
      count: networkIndex.length,
      calls: networkIndex,
    });
  }

  const harIndex: HarIndexEntry[] = [];
  if (args.includeNetworkCalls) {
    for (const sid of sourceSessionIds) {
      const sessionHarDir = getHarDir(args.projectSlug, sid);
      if (!fs.existsSync(sessionHarDir)) continue;
      for (const name of fs.readdirSync(sessionHarDir).filter((f) => f.endsWith('.har')).sort()) {
        try {
          const absSrc = path.join(sessionHarDir, name);
          const raw = JSON.parse(fs.readFileSync(absSrc, 'utf-8')) as unknown;
          if (!isHarLog(raw)) continue;
          const pageUrl = raw.log.pages[0]?.title || name;
          const n = harIndex.length + 1;
          const file = `${String(n).padStart(3, '0')}_${safeWorkspaceFileBase(pageUrl || name, 100)}.har`.slice(0, 180);
          const id = path.basename(file, '.har');
          // Full HAR 1.2 — same payload as session capture (like network-calls/*.json)
          writeJson(path.join(harDir, file), { ...raw, id, sourceSessionId: sid, sourceHarFile: name });
          harIndex.push({
            id,
            file,
            pageUrl,
            entryCount: raw.log.entries.length,
            sourceSessionId: sid,
            sourceHarFile: name,
          });
        } catch (err) {
          logger.warn(
            `[SynthesisWorkspace] Skipping HAR ${name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    writeJson(path.join(harDir, 'index.json'), {
      count: harIndex.length,
      hars: harIndex,
      note: 'Full per-page HAR 1.2 captures (same content as session har/*.har)',
    });
  }

  const graphChunkIndex: GraphChunkIndexEntry[] = [];
  if (args.includeGraphChunks && (args.graphSnapshotFile || args.graphSnapshot != null)) {
    const text = args.graphSnapshotFile
      ? fs.readFileSync(args.graphSnapshotFile, 'utf-8')
      : JSON.stringify(args.graphSnapshot, null, 2);
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

  }

  const uploadedEvidenceIndex: UploadedEvidenceIndexEntry[] = [];
  for (const sid of sourceSessionIds) {
    const sessionUploadedDir = getUploadedEvidenceDir(args.projectSlug, sid);
    if (!fs.existsSync(sessionUploadedDir)) continue;

    const walkUploaded = (dir: string, relPrefix: string) => {
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
          walkUploaded(abs, relPrefix ? `${relPrefix}/${name}` : name);
          continue;
        }
        if (!stat.isFile()) continue;
        if (name === '_structure-inventory.json') continue;
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        const n = uploadedEvidenceIndex.length + 1;
        const fileBase = safeWorkspaceFileBase(rel, 100);
        const envelopeName = `${String(n).padStart(4, '0')}_${fileBase}.json`.slice(0, 180);
        const id = path.basename(envelopeName, '.json');
        const fullText = extractReadableText(abs, name);
        writeJson(path.join(uploadedEvidenceDir, envelopeName), {
          id,
          filename: rel,
          sourceSessionId: sid,
          sizeBytes: stat.size,
          isUserProvidedEvidence: true,
          treatedAsPrimaryEvidence: true,
          hasFullText: Boolean(fullText),
          characterCount: fullText?.length ?? 0,
          fullText: fullText ?? null,
          note: fullText
            ? 'Full file contents included for context building — any upload structure.'
            : 'Binary or non-text file preserved on disk; use image OCR / linked page evidence when applicable.',
        });
        uploadedEvidenceIndex.push({
          id,
          file: envelopeName,
          filename: rel,
          sourceSessionId: sid,
          sizeBytes: stat.size,
          hasFullText: Boolean(fullText),
          characterCount: fullText?.length ?? 0,
        });
      }
    };
    walkUploaded(sessionUploadedDir, '');
  }

  writeJson(path.join(uploadedEvidenceDir, 'index.json'), {
    count: uploadedEvidenceIndex.length,
    note: 'User-uploaded evidence of any type/structure — full text included when readable; used together with crawl captures',
    files: uploadedEvidenceIndex,
  });

  const indexPath = path.join(root, 'EVIDENCE-INDEX.json');
  const fingerprints = {
    pages: fingerprintFiles(pageAnalysesDir, index),
    networkCalls: args.includeNetworkCalls
      ? fingerprintFiles(networkCallsDir, networkIndex)
      : priorIndex?.fingerprints?.networkCalls ?? hashText(''),
    harFiles: args.includeNetworkCalls
      ? fingerprintFiles(harDir, harIndex)
      : priorIndex?.fingerprints?.harFiles ?? hashText(''),
    graphChunks: args.includeGraphChunks
      ? fingerprintFiles(graphChunksDir, graphChunkIndex)
      : priorIndex?.fingerprints?.graphChunks ?? hashText(''),
    uploadedEvidence: fingerprintFiles(uploadedEvidenceDir, uploadedEvidenceIndex),
  };
  const coveragePath = path.join(root, 'coverage-state.json');
  const coverage = readJson<{
    pagesRead?: string[];
    apisRead?: string[];
    harsRead?: string[];
    graphChunksRead?: string[];
    uploadedEvidenceRead?: string[];
  }>(coveragePath) ?? {};
  const pageEvidenceChanged = priorIndex?.fingerprints?.pages !== fingerprints.pages;
  const networkEvidenceChanged = args.includeNetworkCalls
    && priorIndex?.fingerprints?.networkCalls !== fingerprints.networkCalls;
  const harEvidenceChanged = args.includeNetworkCalls
    && priorIndex?.fingerprints?.harFiles !== fingerprints.harFiles;
  const graphEvidenceChanged = args.includeGraphChunks
    && priorIndex?.fingerprints?.graphChunks !== fingerprints.graphChunks;
  const uploadedEvidenceChanged = priorIndex?.fingerprints?.uploadedEvidence !== fingerprints.uploadedEvidence;
  writeJson(coveragePath, {
    pagesRead: pageEvidenceChanged ? [] : coverage.pagesRead ?? [],
    apisRead: networkEvidenceChanged ? [] : coverage.apisRead ?? [],
    harsRead: harEvidenceChanged ? [] : coverage.harsRead ?? [],
    graphChunksRead: graphEvidenceChanged ? [] : coverage.graphChunksRead ?? [],
    uploadedEvidenceRead: uploadedEvidenceChanged ? [] : coverage.uploadedEvidenceRead ?? [],
  });
  if (pageEvidenceChanged) {
    for (const name of ['working-notes.json', 'shared-evidence-meta.json']) {
      const target = path.join(root, name);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
  }

  writeJson(indexPath, {
    projectId: args.projectId,
    projectSlug: args.projectSlug,
    sessionId: args.sessionId,
    sourceSessionIds,
    generatedAt: new Date().toISOString(),
    pages: index.length,
    networkCalls: networkIndex.length,
    harFiles: harIndex.length,
    graphChunks: graphChunkIndex.length,
    uploadedEvidenceFiles: uploadedEvidenceIndex.length,
    fingerprints,
    fingerprint: hashText(JSON.stringify({ sourceSessionIds, fingerprints })),
  });

  writeJson(path.join(root, 'MANIFEST.json'), {
    purpose: 'Local evidence workspace for Cursor-style synthesis agents',
    completenessRule:
      'Entity drains all pages into working-notes.json. Later stages reuse coverage-state + notes and must not re-read pages unless unread>0. write_artifact blocked until required coverage is complete.',
    layout: {
      'page-analyses/': 'Full page AI analyses',
      'network-calls/': 'Network/API captures (xhr/fetch)',
      'har/': 'Full per-page HAR 1.2 captures',
      'graph-chunks/': 'Shared analysis graph partitions',
      'uploaded-evidence/': 'User-uploaded files of any structure (full text envelopes) — additional evidence alongside crawl captures',
      'working-notes.json': 'Shared durable notes (seeded by entity, reused by later stages)',
      'coverage-state.json': 'Read coverage tracker (pages persist across stages)',
      'shared-evidence-meta.json': 'Marker that shared page evidence was seeded',
    },
  });

  logger.info(
    `[SynthesisWorkspace] Evidence ready: ${index.length} pages, ${networkIndex.length} APIs, ${harIndex.length} HAR files, ${graphChunkIndex.length} graph chunks, ${uploadedEvidenceIndex.length} uploaded files → ${root}`,
  );

  return {
    root,
    pageAnalysesDir,
    networkCallsDir,
    harDir,
    graphChunksDir,
    uploadedEvidenceDir,
    indexPath,
    index,
    networkIndex,
    harIndex,
    graphChunkIndex,
    uploadedEvidenceIndex,
  };
}
