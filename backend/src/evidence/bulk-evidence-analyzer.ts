import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { config } from '../config';
import type { LLMClient } from '../ai/llm';
import type { PageAnalysisResult } from '../ai/analyzer';
import { getUploadedEvidenceDir } from '../utils/file-system';
import { logger } from '../utils/logger';
import { withRetry, isNetworkError } from '../utils/retry';

const CHUNK_CHAR_BUDGET = 8_000;
const JSONL_LINES_PER_CHUNK = 12;
const MAX_CHUNKS = 60;
const CHUNK_MAX_TOKENS = 2048;
const MERGE_MAX_TOKENS = 8192;

interface BulkChunk {
  index: number;
  label: string;
  content: string;
}

interface ChunkInsight {
  businessModules: string[];
  entities: string[];
  purposes: string[];
  userActions: string[];
  roles: string[];
  businessRules: string[];
  relationships: Array<{ from: string; to: string; type: string }>;
  summary: string;
}

export function isBulkEvidenceUpload(page: {
  url: string;
  visibleText?: string | null;
  extractedData?: string | null;
}): boolean {
  const url = page.url.toLowerCase();
  if (!url.startsWith('upload://')) return false;

  const bulkPathHints = [
    '/ingestion/chunks.json',
    '/ingestion/documents.json',
    '/structured/knowledge.json',
    'knowledge-base.jsonl',
    '.pins',
    '.pont',
    '.pprj',
  ];
  if (bulkPathHints.some((hint) => url.includes(hint))) return true;

  if ((page.visibleText?.length ?? 0) > 500_000) return true;

  try {
    const data = JSON.parse(page.extractedData!) as Record<string, unknown>;
    const upload = data['uploadedEvidence'] as { sizeBytes?: number } | undefined;
    if (typeof upload?.sizeBytes === 'number' && upload.sizeBytes >= 2_000_000) return true;
  } catch {
    /* ignore */
  }

  return false;
}

function resolveUploadAbsPath(projectSlug: string, sessionId: string, uploadUrl: string): string | null {
  const prefix = 'upload://';
  if (!uploadUrl.startsWith(prefix)) return null;
  const rel = uploadUrl.slice(prefix.length).replace(/\\/g, '/');
  const uploadedRoot = getUploadedEvidenceDir(projectSlug, sessionId);
  const relUnderEvidence = rel.startsWith('uploaded-evidence/')
    ? rel.slice('uploaded-evidence/'.length)
    : rel;
  const abs = path.join(uploadedRoot, relUnderEvidence);
  return fs.existsSync(abs) ? abs : null;
}

/** Keep JSONL chunks small — full lines include huge nested `raw` blobs. */
function compactJsonlLine(line: string): string {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const summary = typeof obj['summary'] === 'string'
      ? obj['summary']
      : typeof obj['content'] === 'string'
        ? obj['content']
        : '';
    return JSON.stringify({
      id: obj['id'],
      type: obj['type'],
      title: obj['title'],
      tags: obj['tags'],
      summary: String(summary).slice(0, 400),
    });
  } catch {
    return line.slice(0, 600);
  }
}

function pushChunk(chunks: BulkChunk[], batchIndex: number, label: string, content: string): void {
  if (!content.trim()) return;
  const trimmed = content.length > CHUNK_CHAR_BUDGET
    ? content.slice(0, CHUNK_CHAR_BUDGET)
    : content;
  chunks.push({ index: batchIndex, label, content: trimmed });
}

async function readJsonlChunks(absPath: string): Promise<BulkChunk[]> {
  const chunks: BulkChunk[] = [];
  let batch: string[] = [];
  let batchIndex = 0;

  const pushBatch = () => {
    if (batch.length === 0) return;
    pushChunk(
      chunks,
      batchIndex++,
      `jsonl records (compact) batch ${chunks.length + 1}`,
      batch.join('\n'),
    );
    batch = [];
  };

  const stream = fs.createReadStream(absPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    batch.push(compactJsonlLine(trimmed));
    if (batch.length >= JSONL_LINES_PER_CHUNK) pushBatch();
  }
  pushBatch();
  return chunks;
}

function readJsonChunks(absPath: string): BulkChunk[] {
  const raw = fs.readFileSync(absPath, 'utf-8');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const chunks: BulkChunk[] = [];
      let batch: unknown[] = [];
      let batchIndex = 0;
      const flush = () => {
        if (batch.length === 0) return;
        pushChunk(
          chunks,
          batchIndex++,
          `json array batch ${chunks.length + 1}`,
          JSON.stringify(batch, null, 0),
        );
        batch = [];
      };
      for (const item of parsed) {
        batch.push(item);
        const serialized = JSON.stringify(batch);
        if (batch.length >= 5 || serialized.length > CHUNK_CHAR_BUDGET) flush();
      }
      flush();
      if (chunks.length > 0) return chunks;
    }
    if (parsed && typeof parsed === 'object') {
      const entries = Object.entries(parsed as Record<string, unknown>);
      const chunks: BulkChunk[] = [];
      let batch = '';
      let batchIndex = 0;
      for (const [key, value] of entries) {
        const piece = `${key}: ${JSON.stringify(value).slice(0, 2000)}\n`;
        if (batch.length + piece.length > CHUNK_CHAR_BUDGET) {
          pushChunk(chunks, batchIndex++, `json object section ${chunks.length + 1}`, batch);
          batch = piece;
        } else {
          batch += piece;
        }
      }
      if (batch.trim()) {
        pushChunk(chunks, batchIndex++, `json object section ${chunks.length + 1}`, batch);
      }
      if (chunks.length > 0) return chunks;
    }
  } catch {
    /* fall through */
  }
  return readTextChunks(raw);
}

function extractProtegeSymbols(text: string): string {
  const classes = new Set<string>();
  const slots = new Set<string>();
  const instances = new Set<string>();
  for (const m of text.matchAll(/\(:CLASS\s+([^\s()]+)/g)) classes.add(m[1]!);
  for (const m of text.matchAll(/\(:SLOT\s+([^\s()]+)/g)) slots.add(m[1]!);
  for (const m of text.matchAll(/\(:INSTANCE\s+([^\s()]+)/g)) instances.add(m[1]!);
  for (const m of text.matchAll(/\(:METACLASS\s+([^\s()]+)/g)) classes.add(m[1]!);
  const parts: string[] = [];
  if (classes.size) parts.push(`Classes (${classes.size}): ${[...classes].slice(0, 40).join(', ')}`);
  if (slots.size) parts.push(`Slots (${slots.size}): ${[...slots].slice(0, 40).join(', ')}`);
  if (instances.size) parts.push(`Instances (${instances.size}): ${[...instances].slice(0, 40).join(', ')}`);
  const excerpt = text.replace(/\s+/g, ' ').slice(0, 4000);
  return `${parts.join('\n')}\n\nExcerpt:\n${excerpt}`;
}

function readProtegeChunks(absPath: string): BulkChunk[] {
  const text = fs.readFileSync(absPath, 'utf-8');
  const chunks: BulkChunk[] = [];
  let offset = 0;
  let index = 0;
  while (offset < text.length && chunks.length < MAX_CHUNKS) {
    const slice = text.slice(offset, offset + CHUNK_CHAR_BUDGET);
    pushChunk(chunks, index++, `protege segment ${chunks.length + 1}`, extractProtegeSymbols(slice));
    offset += CHUNK_CHAR_BUDGET;
  }
  return chunks;
}

function readTextChunks(text: string): BulkChunk[] {
  const chunks: BulkChunk[] = [];
  let offset = 0;
  let index = 0;
  while (offset < text.length && chunks.length < MAX_CHUNKS) {
    const slice = text.slice(offset, offset + CHUNK_CHAR_BUDGET);
    pushChunk(chunks, index++, `text segment ${chunks.length + 1}`, slice);
    offset += CHUNK_CHAR_BUDGET;
  }
  return chunks;
}

async function buildFileChunks(absPath: string): Promise<BulkChunk[]> {
  const ext = path.extname(absPath).toLowerCase();
  let chunks: BulkChunk[] = [];
  if (ext === '.jsonl') {
    chunks = await readJsonlChunks(absPath);
  } else if (ext === '.json') {
    chunks = readJsonChunks(absPath);
  } else if (ext === '.pins' || ext === '.pont' || ext === '.pprj') {
    chunks = readProtegeChunks(absPath);
  } else {
    chunks = readTextChunks(fs.readFileSync(absPath, 'utf-8'));
  }

  if (chunks.length > MAX_CHUNKS) {
    const step = Math.ceil(chunks.length / MAX_CHUNKS);
    chunks = chunks.filter((_, i) => i % step === 0).slice(0, MAX_CHUNKS);
    logger.warn(`[BulkEvidence] Sampled ${chunks.length} chunks from large file ${path.basename(absPath)}`);
  }
  return chunks;
}

function isTransient(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('empty content')
  );
}

function emptyInsight(summary: string): ChunkInsight {
  return {
    businessModules: [],
    entities: [],
    purposes: [],
    userActions: [],
    roles: [],
    businessRules: [],
    relationships: [],
    summary,
  };
}

async function analyzeChunk(
  llm: LLMClient,
  args: { filename: string; chunk: BulkChunk; appName?: string },
): Promise<ChunkInsight> {
  const context = args.appName ? `Application: "${args.appName}". ` : '';
  const tryAnalyze = async (content: string): Promise<ChunkInsight> =>
    withRetry(
      () =>
        llm.chatJson<ChunkInsight>(
          [
            {
              role: 'system',
              content:
                'Analyze enterprise evidence. Return concise JSON only — no reasoning prose. Keep arrays short (max 8 items each).',
            },
            {
              role: 'user',
              content: `${context}File: ${args.filename}\nChunk: ${args.chunk.label}\n\n${content}\n\nJSON: {"businessModules":[],"entities":[],"purposes":[],"userActions":[],"roles":[],"businessRules":[],"relationships":[],"summary":""}`,
            },
          ],
          { maxTokens: CHUNK_MAX_TOKENS },
        ),
      { maxAttempts: 3, delayMs: 1500, backoffFactor: 2, shouldRetry: isTransient },
      `Bulk chunk ${args.chunk.index} ${args.filename}`,
    );

  try {
    return await tryAnalyze(args.chunk.content);
  } catch (err) {
    const half = args.chunk.content.slice(0, Math.floor(args.chunk.content.length / 2));
    if (half.length > 500) {
      logger.warn(`[BulkEvidence] Retrying chunk ${args.chunk.index} at half size for ${args.filename}`);
      try {
        return await tryAnalyze(half);
      } catch {
        /* fall through */
      }
    }
    logger.warn(
      `[BulkEvidence] Chunk ${args.chunk.index} failed for ${args.filename}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return emptyInsight(`Chunk ${args.chunk.label} — partial parse only`);
  }
}

function uniqStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function normalizeRelationships(
  value: unknown,
): PageAnalysisResult['relationships'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const r = item as Record<string, unknown>;
    const from = typeof r['from'] === 'string' ? r['from'] : '';
    const to = typeof r['to'] === 'string' ? r['to'] : typeof r['entity'] === 'string' ? r['entity'] : '';
    const type = typeof r['type'] === 'string' ? r['type'] : 'relatesTo';
    if (!from || !to) return [];
    return [{ from, to, type }];
  });
}

function programmaticMerge(
  filename: string,
  uploadUrl: string,
  chunks: ChunkInsight[],
  chunkCount: number,
  sizeKb: number,
): PageAnalysisResult {
  const modules = uniqStrings(chunks.flatMap((c) => c.businessModules));
  const entities = uniqStrings(chunks.flatMap((c) => c.entities));
  const purposes = uniqStrings(chunks.flatMap((c) => c.purposes));
  const roles = uniqStrings(chunks.flatMap((c) => c.roles));
  const rules = uniqStrings(chunks.flatMap((c) => c.businessRules));
  const actions = uniqStrings(chunks.flatMap((c) => c.userActions));
  const relationships = normalizeRelationships(chunks.flatMap((c) => c.relationships)).slice(0, 30);
  const summary = chunks.map((c) => c.summary).filter(Boolean).join(' ').slice(0, 3000);

  const isProtege = /\.(pins|pont|pprj)$/i.test(filename);
  const isKb = filename.includes('knowledge-base');

  return {
    businessModule: modules[0] ?? (isProtege ? 'Enterprise Architecture / Metamodel Repository' : 'Uploaded Evidence / Knowledge Base'),
    primaryEntity: entities[0] ?? (isProtege ? 'Essential Metamodel Class' : isKb ? 'Knowledge Concept' : 'EvidenceRecord'),
    relatedEntities: entities.slice(1, 25),
    pagePurpose:
      (summary || purposes.join('; ') || `Full chunked analysis of uploaded file ${filename}`) +
      ` [${chunkCount} segments, ${sizeKb} KB]`,
    userActions: actions.slice(0, 15),
    workflowStage: isProtege ? 'Repository / Metamodel' : 'Documentation / Export',
    possibleRoles: roles.slice(0, 12).length ? roles.slice(0, 12) : ['Architect', 'Administrator', 'Analyst'],
    businessRules: rules.slice(0, 15),
    nocobaseCollections: entities.slice(0, 12),
    nocobaseFields: [],
    relationships,
    pluginSuggestions: [],
    confidenceScore: 0.75,
  };
}

async function mergeChunkInsights(
  llm: LLMClient,
  args: {
    filename: string;
    uploadUrl: string;
    chunks: ChunkInsight[];
    chunkCount: number;
    sizeKb: number;
    appName?: string;
  },
): Promise<PageAnalysisResult> {
  const valid = args.chunks.filter((c) => c.summary || c.entities.length || c.businessModules.length);
  if (valid.length === 0) {
    return programmaticMerge(args.filename, args.uploadUrl, args.chunks, args.chunkCount, args.sizeKb);
  }

  const context = args.appName ? `Application: "${args.appName}". ` : '';
  const condensed = valid.slice(0, 40).map((c, i) => ({
    chunk: i + 1,
    summary: c.summary.slice(0, 400),
    businessModules: c.businessModules.slice(0, 6),
    entities: c.entities.slice(0, 10),
    purposes: c.purposes.slice(0, 4),
    roles: c.roles.slice(0, 4),
  }));

  try {
    const merged = await withRetry(
      () =>
        llm.chatJson<PageAnalysisResult>(
          [
            {
              role: 'system',
              content:
                'Synthesize chunk analyses into one page analysis JSON. Return JSON only — no reasoning text.',
            },
            {
              role: 'user',
              content: `${context}File: ${args.filename}\nURL: ${args.uploadUrl}\nChunks: ${valid.length}\n\n${JSON.stringify(condensed).slice(0, 50_000)}\n\nReturn page analysis JSON with businessModule, primaryEntity, relatedEntities, pagePurpose, userActions, workflowStage, possibleRoles, businessRules, nocobaseCollections, nocobaseFields, relationships, pluginSuggestions, confidenceScore.`,
            },
          ],
          { maxTokens: MERGE_MAX_TOKENS },
        ),
      { maxAttempts: 3, delayMs: 2000, backoffFactor: 2, shouldRetry: isTransient },
      `Bulk merge ${args.filename}`,
    );
    merged.pagePurpose =
      `${merged.pagePurpose} [Full chunked analysis: ${args.chunkCount} segment(s), ${args.sizeKb} KB on disk]`.trim();
    merged.confidenceScore = Math.min(merged.confidenceScore ?? 0.75, 0.85);
    merged.nocobaseFields = Array.isArray(merged.nocobaseFields) ? merged.nocobaseFields : [];
    merged.nocobaseCollections = Array.isArray(merged.nocobaseCollections) ? merged.nocobaseCollections : [];
    merged.relatedEntities = Array.isArray(merged.relatedEntities) ? merged.relatedEntities : [];
    merged.userActions = Array.isArray(merged.userActions) ? merged.userActions : [];
    merged.possibleRoles = Array.isArray(merged.possibleRoles) ? merged.possibleRoles : [];
    merged.businessRules = Array.isArray(merged.businessRules) ? merged.businessRules : [];
    merged.pluginSuggestions = Array.isArray(merged.pluginSuggestions) ? merged.pluginSuggestions : [];
    merged.relationships = normalizeRelationships(merged.relationships);
    return merged;
  } catch (err) {
    logger.warn(
      `[BulkEvidence] LLM merge failed for ${args.filename}, using programmatic merge: ${err instanceof Error ? err.message : String(err)}`,
    );
    const fallback = programmaticMerge(args.filename, args.uploadUrl, valid, args.chunkCount, args.sizeKb);
    fallback.pagePurpose =
      `${fallback.pagePurpose} [Programmatic merge after LLM merge timeout]`.trim();
    return fallback;
  }
}

export async function analyzeBulkEvidenceFile(args: {
  projectSlug: string;
  sessionId: string;
  page: { url: string; title?: string | null };
  llm: LLMClient;
  appName?: string;
}): Promise<PageAnalysisResult> {
  const absPath = resolveUploadAbsPath(args.projectSlug, args.sessionId, args.page.url);
  if (!absPath) {
    throw new Error(`Bulk evidence file not found on disk for ${args.page.url}`);
  }

  const filename = args.page.title || path.basename(absPath);
  const stat = fs.statSync(absPath);
  const sizeKb = Math.round(stat.size / 1024);
  const chunks = await buildFileChunks(absPath);
  if (chunks.length === 0) {
    throw new Error(`No analyzable content in bulk file ${filename}`);
  }

  logger.info(`[BulkEvidence] Full analysis of ${filename} (${sizeKb} KB) in ${chunks.length} chunk(s)`);

  const concurrency = config.llm.analysisConcurrency;
  const insights: ChunkInsight[] = new Array(chunks.length);
  let next = 0;
  let completed = 0;

  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= chunks.length) break;
      insights[i] = await analyzeChunk(args.llm, { filename, chunk: chunks[i]!, appName: args.appName });
      completed += 1;
      if (completed % concurrency === 0 || completed === chunks.length) {
        logger.info(`[BulkEvidence] ${filename}: chunk ${completed}/${chunks.length}`);
      }
    }
  });
  await Promise.all(workers);

  const merged = await mergeChunkInsights(args.llm, {
    filename,
    uploadUrl: args.page.url,
    chunks: insights.filter(Boolean),
    chunkCount: chunks.length,
    sizeKb,
    appName: args.appName,
  });

  return merged;
}
