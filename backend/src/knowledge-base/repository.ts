import fs from 'fs';
import path from 'path';
import { resolveAsset, verifyMarkdownImageLinks, mimeForPath } from './assets';
import { buildEdgeIndexes, traverseGraph } from './graph';
import { loadJsonlArray, streamJsonlLines } from './jsonl';
import { resolveUnderRoot, walkFiles, toPosixRelative, PathSafetyError } from './path-safety';
import { buildDiagnostics, diag } from './provenance';
import { lexicalSearchChunks, matchesFilters } from './retrieval';
import {
  DocumentVideoLinkSchema,
  FrameIndexEntrySchema,
  GraphEdgeSchema,
  GraphNodeSchema,
  KnowledgeChunkSchema,
  KnowledgeRecordSchema,
  ManifestSchema,
  NamedIndexEntrySchema,
  ValidationReportSchema,
  VideoIndexEntrySchema,
  parsePassthrough,
} from './schemas';
import type {
  DiagnosticItem,
  DocumentVideoLink,
  FileInventoryEntry,
  FilterOptions,
  FrameIndexEntry,
  GraphEdge,
  GraphNode,
  GraphTraversalResult,
  KnowledgeBaseDiagnostics,
  KnowledgeBaseManifest,
  KnowledgeChunk,
  KnowledgeRecord,
  NamedIndexEntry,
  ResolvedAsset,
  SearchHit,
  SourceIndexEntry,
  TraversalOptions,
  ValidationReport,
  VideoIndexEntry,
  VideoView,
} from './types';

export function detectKnowledgeBaseRoot(searchRoot: string, maxDepth = 5): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: searchRoot, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const manifestPath = path.join(current.dir, 'manifest.json');
    const hasStructured =
      fs.existsSync(path.join(current.dir, 'structured'))
      || fs.existsSync(path.join(current.dir, 'ingestion'))
      || fs.existsSync(path.join(current.dir, 'indexes'));
    if (fs.existsSync(manifestPath) && hasStructured) {
      return current.dir;
    }
    // Also accept a nested `output/` folder containing the KB contract
    if (current.depth < maxDepth) {
      for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function readJsonFile(abs: string): unknown {
  return JSON.parse(fs.readFileSync(abs, 'utf-8')) as unknown;
}

function optionalReadJson(abs: string): unknown | null {
  if (!fs.existsSync(abs)) return null;
  return readJsonFile(abs);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['items', 'records', 'entries', 'chunks', 'nodes', 'edges', 'links', 'frames', 'videos']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

export class KnowledgeBaseRepository {
  private rootDir: string;
  private signal?: AbortSignal;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private manifest: KnowledgeBaseManifest | null = null;
  private diagnostics: KnowledgeBaseDiagnostics | null = null;
  private validationReport: ValidationReport | null = null;

  private recordsById = new Map<string, KnowledgeRecord>();
  private rawRecordsById = new Map<string, Record<string, unknown>>();
  private chunksById = new Map<string, KnowledgeChunk>();
  private rawChunksById = new Map<string, Record<string, unknown>>();
  private chunksBySourceId = new Map<string, KnowledgeChunk[]>();
  private chunksBySectionId = new Map<string, KnowledgeChunk[]>();
  private chunksByVideoId = new Map<string, KnowledgeChunk[]>();

  private videosById = new Map<string, VideoIndexEntry>();
  private videosByBundle = new Map<string, VideoIndexEntry[]>();
  private linksBySection = new Map<string, DocumentVideoLink[]>();
  private linksByVideo = new Map<string, DocumentVideoLink[]>();
  private allLinks: DocumentVideoLink[] = [];
  private framesByVideo = new Map<string, FrameIndexEntry[]>();
  private topicIndex = new Map<string, NamedIndexEntry>();
  private conceptIndex = new Map<string, NamedIndexEntry>();
  private entityIndex = new Map<string, NamedIndexEntry>();
  private sourceIndex: SourceIndexEntry[] = [];

  private nodesById = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private outgoing = new Map<string, GraphEdge[]>();
  private incoming = new Map<string, GraphEdge[]>();

  private markdownFiles: string[] = [];
  private assetFiles: string[] = [];
  private fileInventory: FileInventoryEntry[] = [];

  constructor(rootDir: string, signal?: AbortSignal) {
    this.rootDir = path.resolve(rootDir);
    this.signal = signal;
  }

  getRootDir(): string {
    return this.rootDir;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    const errors: DiagnosticItem[] = [];
    const warnings: DiagnosticItem[] = [];
    const info: DiagnosticItem[] = [];

    if (!fs.existsSync(this.rootDir)) {
      throw new Error(`Knowledge base root not found: ${this.rootDir}`);
    }

    const manifestPath = path.join(this.rootDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Missing primary file: manifest.json under ${this.rootDir}`);
    }

    try {
      this.manifest = parsePassthrough(ManifestSchema, readJsonFile(manifestPath), 'manifest.json');
    } catch (err) {
      throw new Error(`Failed to parse manifest.json: ${err instanceof Error ? err.message : String(err)}`);
    }

    const primary = this.manifest.primary_paths ?? {
      knowledge_jsonl: 'structured/knowledge.jsonl',
      chunks_jsonl: 'ingestion/chunks.jsonl',
      nodes_jsonl: 'graph/nodes.jsonl',
      edges_jsonl: 'graph/edges.jsonl',
    };

    const requirePrimary = (key: string, fallback: string) => {
      const rel = primary[key] ?? fallback;
      const abs = path.join(this.rootDir, rel);
      if (!fs.existsSync(abs)) {
        errors.push(diag('error', 'MISSING_PRIMARY', `Missing primary file declared/expected: ${rel}`, rel));
        return null;
      }
      return { rel, abs };
    };

    const knowledgePrimary = requirePrimary('knowledge_jsonl', 'structured/knowledge.jsonl');
    const chunksPrimary = requirePrimary('chunks_jsonl', 'ingestion/chunks.jsonl');

    // Load knowledge records (JSONL preferred)
    if (knowledgePrimary) {
      try {
        for await (const entry of streamJsonlLines(knowledgePrimary.abs, this.signal)) {
          const parsed = parsePassthrough(
            KnowledgeRecordSchema,
            entry.value,
            `${knowledgePrimary.rel}:${entry.lineNumber}`,
          );
          if (this.recordsById.has(parsed.id)) {
            errors.push(diag('error', 'DUPLICATE_RECORD_ID', `Duplicate knowledge id: ${parsed.id}`, knowledgePrimary.rel));
          }
          this.recordsById.set(parsed.id, parsed as KnowledgeRecord);
          this.rawRecordsById.set(parsed.id, entry.value as Record<string, unknown>);
        }
      } catch (err) {
        errors.push(diag('error', 'KNOWLEDGE_PARSE', err instanceof Error ? err.message : String(err), knowledgePrimary.rel));
      }
    }

    // Fallback/verify JSON array
    const knowledgeJsonPath = path.join(this.rootDir, 'structured/knowledge.json');
    if (fs.existsSync(knowledgeJsonPath)) {
      try {
        const arr = asArray(readJsonFile(knowledgeJsonPath));
        const jsonIds = new Set<string>();
        for (const item of arr) {
          const parsed = parsePassthrough(KnowledgeRecordSchema, item, 'structured/knowledge.json');
          jsonIds.add(parsed.id);
          if (!this.recordsById.has(parsed.id)) {
            this.recordsById.set(parsed.id, parsed as KnowledgeRecord);
            this.rawRecordsById.set(parsed.id, item as Record<string, unknown>);
            warnings.push(diag('warning', 'JSON_FALLBACK_RECORD', `Record ${parsed.id} loaded from JSON fallback`, 'structured/knowledge.json'));
          }
        }
        if (this.recordsById.size !== jsonIds.size && this.recordsById.size > 0 && jsonIds.size > 0) {
          // Compare logical sets when both present
          for (const id of this.recordsById.keys()) {
            if (!jsonIds.has(id)) {
              warnings.push(diag('warning', 'JSON_JSONL_MISMATCH', `Record ${id} present in JSONL but not JSON`, 'structured/knowledge.json'));
            }
          }
        }
      } catch (err) {
        warnings.push(diag('warning', 'KNOWLEDGE_JSON_PARSE', err instanceof Error ? err.message : String(err), 'structured/knowledge.json'));
      }
    }

    if (chunksPrimary) {
      try {
        for await (const entry of streamJsonlLines(chunksPrimary.abs, this.signal)) {
          const parsed = parsePassthrough(
            KnowledgeChunkSchema,
            entry.value,
            `${chunksPrimary.rel}:${entry.lineNumber}`,
          );
          if (this.chunksById.has(parsed.chunk_id)) {
            errors.push(diag('error', 'DUPLICATE_CHUNK_ID', `Duplicate chunk_id: ${parsed.chunk_id}`, chunksPrimary.rel));
          }
          this.chunksById.set(parsed.chunk_id, parsed);
          this.rawChunksById.set(parsed.chunk_id, entry.value as Record<string, unknown>);
          this.pushMulti(this.chunksBySourceId, parsed.source_id, parsed);
          if (parsed.document_section_id) this.pushMulti(this.chunksBySectionId, parsed.document_section_id, parsed);
          if (parsed.video_id) this.pushMulti(this.chunksByVideoId, parsed.video_id, parsed);
          if (!this.recordsById.has(parsed.source_id)) {
            errors.push(diag('error', 'CHUNK_SOURCE_MISSING', `Chunk ${parsed.chunk_id} source_id missing: ${parsed.source_id}`, chunksPrimary.rel));
          }
        }
      } catch (err) {
        errors.push(diag('error', 'CHUNKS_PARSE', err instanceof Error ? err.message : String(err), chunksPrimary.rel));
      }
    }

    const chunksJsonPath = path.join(this.rootDir, 'ingestion/chunks.json');
    if (fs.existsSync(chunksJsonPath)) {
      try {
        const arr = asArray(readJsonFile(chunksJsonPath));
        const jsonIds = new Set<string>();
        for (const item of arr) {
          const parsed = parsePassthrough(KnowledgeChunkSchema, item, 'ingestion/chunks.json');
          jsonIds.add(parsed.chunk_id);
          if (!this.chunksById.has(parsed.chunk_id)) {
            this.chunksById.set(parsed.chunk_id, parsed);
            this.rawChunksById.set(parsed.chunk_id, item as Record<string, unknown>);
          }
        }
        if (jsonIds.size && this.chunksById.size && jsonIds.size !== this.chunksById.size) {
          warnings.push(diag('warning', 'CHUNKS_JSON_JSONL_COUNT', `chunks.json count ${jsonIds.size} vs jsonl ${this.chunksById.size}`, 'ingestion/chunks.json'));
        }
      } catch (err) {
        warnings.push(diag('warning', 'CHUNKS_JSON_PARSE', err instanceof Error ? err.message : String(err)));
      }
    }

    await this.loadSpecializedJsonl('ingestion/documents.jsonl', warnings);
    await this.loadSpecializedJsonl('ingestion/videos.jsonl', warnings);
    await this.loadSpecializedJsonl('ingestion/topics.jsonl', warnings);
    await this.loadSpecializedJsonl('ingestion/concepts.jsonl', warnings);
    await this.loadSpecializedJsonl('ingestion/entities.jsonl', warnings);

    // Graph
    const nodesPath = path.join(this.rootDir, primary['nodes_jsonl'] ?? 'graph/nodes.jsonl');
    const edgesPath = path.join(this.rootDir, primary['edges_jsonl'] ?? 'graph/edges.jsonl');
    if (fs.existsSync(nodesPath)) {
      try {
        for await (const entry of streamJsonlLines(nodesPath, this.signal)) {
          const node = parsePassthrough(GraphNodeSchema, entry.value, `graph/nodes.jsonl:${entry.lineNumber}`);
          if (this.nodesById.has(node.id)) {
            errors.push(diag('error', 'DUPLICATE_NODE_ID', `Duplicate graph node id: ${node.id}`));
          }
          this.nodesById.set(node.id, node);
        }
      } catch (err) {
        errors.push(diag('error', 'NODES_PARSE', err instanceof Error ? err.message : String(err)));
      }
    } else {
      warnings.push(diag('warning', 'MISSING_OPTIONAL', 'Missing optional graph/nodes.jsonl', 'graph/nodes.jsonl'));
    }

    if (fs.existsSync(edgesPath)) {
      try {
        for await (const entry of streamJsonlLines(edgesPath, this.signal)) {
          const edge = parsePassthrough(GraphEdgeSchema, entry.value, `graph/edges.jsonl:${entry.lineNumber}`);
          this.edges.push(edge);
          if (!this.nodesById.has(edge.from)) {
            errors.push(diag('error', 'EDGE_FROM_MISSING', `Edge from missing node: ${edge.from}`));
          }
          if (!this.nodesById.has(edge.to)) {
            errors.push(diag('error', 'EDGE_TO_MISSING', `Edge to missing node: ${edge.to}`));
          }
        }
      } catch (err) {
        errors.push(diag('error', 'EDGES_PARSE', err instanceof Error ? err.message : String(err)));
      }
    } else {
      warnings.push(diag('warning', 'MISSING_OPTIONAL', 'Missing optional graph/edges.jsonl', 'graph/edges.jsonl'));
    }
    const edgeIdx = buildEdgeIndexes(this.edges);
    this.outgoing = edgeIdx.outgoing;
    this.incoming = edgeIdx.incoming;

    // Indexes
    this.loadVideoIndex(warnings);
    this.loadDocumentVideoLinks(warnings, errors);
    this.loadFrameIndex(warnings, errors);
    this.loadNamedIndex('indexes/topic-index.json', this.topicIndex, warnings);
    this.loadNamedIndex('indexes/concept-index.json', this.conceptIndex, warnings);
    this.loadNamedIndex('indexes/entity-index.json', this.entityIndex, warnings);
    this.loadSourceIndex(warnings);

    // Markdown / assets inventory
    this.collectMarkdownAndAssets(warnings, errors);

    // Validation report
    const validationPath = path.join(this.rootDir, 'reports/validation.json');
    if (fs.existsSync(validationPath)) {
      try {
        this.validationReport = parsePassthrough(
          ValidationReportSchema,
          readJsonFile(validationPath),
          'reports/validation.json',
        );
        for (const w of this.validationReport.warnings ?? []) {
          warnings.push(diag('warning', 'BUILD_VALIDATION_WARNING', String(w), 'reports/validation.json'));
        }
        for (const e of this.validationReport.errors ?? []) {
          errors.push(diag('error', 'BUILD_VALIDATION_ERROR', String(e), 'reports/validation.json'));
        }
      } catch (err) {
        warnings.push(diag('warning', 'VALIDATION_PARSE', err instanceof Error ? err.message : String(err)));
      }
    } else {
      warnings.push(diag('warning', 'MISSING_OPTIONAL', 'Missing reports/validation.json', 'reports/validation.json'));
    }

    // Manifest statistics reconciliation
    const stats = this.manifest.statistics ?? {};
    const counts = this.computeCounts();
    for (const [key, expected] of Object.entries(stats)) {
      const actual = counts[key];
      if (typeof actual === 'number' && actual !== expected) {
        warnings.push(diag(
          'warning',
          'STAT_MISMATCH',
          `Manifest statistics.${key}=${expected} but reader counted ${actual}`,
        ));
      }
    }

    this.fileInventory = this.buildFileInventory();
    for (const entry of this.fileInventory) {
      if (entry.classification === 'unclassified') {
        warnings.push(diag('warning', 'UNCLASSIFIED_FILE', `File not classified by reader: ${entry.relativePath}`, entry.relativePath));
      }
    }

    let resolvedLinks = 0;
    let unresolvedLinks = 0;
    for (const link of this.allLinks) {
      if (link.resolved === false || (!link.video_id && link.reason)) unresolvedLinks += 1;
      else if (link.video_id && this.videosById.has(link.video_id)) resolvedLinks += 1;
      else if (link.video_id) unresolvedLinks += 1;
      else unresolvedLinks += 1;
    }

    this.diagnostics = buildDiagnostics({
      manifest: this.manifest,
      errors,
      warnings,
      info,
      counts,
      unresolvedVideoReferences: unresolvedLinks,
      resolvedVideoReferences: resolvedLinks,
      validationStatusFromReport: this.validationReport?.status,
    });

    if (errors.some((e) => e.code === 'MISSING_PRIMARY')) {
      throw new Error(`Knowledge base initialization failed:\n${this.diagnostics.humanReport}`);
    }

    this.initialized = true;
  }

  private pushMulti<T>(map: Map<string, T[]>, key: string, value: T): void {
    const arr = map.get(key) ?? [];
    arr.push(value);
    map.set(key, arr);
  }

  private async loadSpecializedJsonl(rel: string, warnings: DiagnosticItem[]): Promise<void> {
    const abs = path.join(this.rootDir, rel);
    if (!fs.existsSync(abs)) {
      warnings.push(diag('warning', 'MISSING_OPTIONAL', `Missing optional ${rel}`, rel));
      return;
    }
    try {
      for await (const entry of streamJsonlLines(abs, this.signal)) {
        const parsed = parsePassthrough(KnowledgeRecordSchema, entry.value, `${rel}:${entry.lineNumber}`);
        const canonical = this.recordsById.get(parsed.id);
        if (!canonical) {
          warnings.push(diag('warning', 'SPECIALIZED_ORPHAN', `${rel} id ${parsed.id} not in canonical knowledge`, rel));
        }
      }
    } catch (err) {
      warnings.push(diag('warning', 'SPECIALIZED_PARSE', err instanceof Error ? err.message : String(err), rel));
    }
  }

  private loadVideoIndex(warnings: DiagnosticItem[]): void {
    const abs = path.join(this.rootDir, 'indexes/video-index.json');
    if (!fs.existsSync(abs)) {
      warnings.push(diag('warning', 'MISSING_OPTIONAL', 'Missing indexes/video-index.json', 'indexes/video-index.json'));
      return;
    }
    try {
      for (const item of asArray(readJsonFile(abs))) {
        const entry = parsePassthrough(VideoIndexEntrySchema, item, 'indexes/video-index.json');
        this.videosById.set(entry.video_id, entry);
        if (entry.bundle_name) this.pushMulti(this.videosByBundle, entry.bundle_name, entry);
      }
    } catch (err) {
      warnings.push(diag('warning', 'VIDEO_INDEX_PARSE', err instanceof Error ? err.message : String(err)));
    }
  }

  private loadDocumentVideoLinks(warnings: DiagnosticItem[], errors: DiagnosticItem[]): void {
    const abs = path.join(this.rootDir, 'indexes/document-video-links.json');
    if (!fs.existsSync(abs)) {
      warnings.push(diag('warning', 'MISSING_OPTIONAL', 'Missing indexes/document-video-links.json', 'indexes/document-video-links.json'));
      return;
    }
    try {
      for (const item of asArray(readJsonFile(abs))) {
        const link = parsePassthrough(DocumentVideoLinkSchema, item, 'indexes/document-video-links.json');
        this.allLinks.push(link);
        this.pushMulti(this.linksBySection, link.document_section_id, link);
        if (link.video_id) this.pushMulti(this.linksByVideo, link.video_id, link);
        if (link.resolved !== false && link.video_id && !this.videosById.has(link.video_id)) {
          errors.push(diag('error', 'LINK_VIDEO_MISSING', `Resolved link references missing video ${link.video_id}`));
        }
      }
    } catch (err) {
      warnings.push(diag('warning', 'DOC_VIDEO_LINKS_PARSE', err instanceof Error ? err.message : String(err)));
    }
  }

  private loadFrameIndex(warnings: DiagnosticItem[], errors: DiagnosticItem[]): void {
    const abs = path.join(this.rootDir, 'indexes/frame-index.json');
    if (!fs.existsSync(abs)) {
      warnings.push(diag('warning', 'MISSING_OPTIONAL', 'Missing indexes/frame-index.json', 'indexes/frame-index.json'));
      return;
    }
    try {
      for (const item of asArray(readJsonFile(abs))) {
        const frame = parsePassthrough(FrameIndexEntrySchema, item, 'indexes/frame-index.json');
        this.pushMulti(this.framesByVideo, frame.video_id, frame);
        try {
          resolveUnderRoot(this.rootDir, frame.path.startsWith('assets/') ? frame.path : frame.path);
          const candidate = path.join(this.rootDir, frame.path.startsWith('assets/') ? frame.path : path.join('assets', frame.path));
          if (!fs.existsSync(candidate)) {
            errors.push(diag('error', 'FRAME_MISSING', `Frame path missing: ${frame.path}`, frame.path));
          }
        } catch (err) {
          errors.push(diag('error', 'FRAME_PATH', err instanceof Error ? err.message : String(err), frame.path));
        }
      }
    } catch (err) {
      warnings.push(diag('warning', 'FRAME_INDEX_PARSE', err instanceof Error ? err.message : String(err)));
    }
  }

  private loadNamedIndex(rel: string, target: Map<string, NamedIndexEntry>, warnings: DiagnosticItem[]): void {
    const abs = path.join(this.rootDir, rel);
    if (!fs.existsSync(abs)) {
      warnings.push(diag('warning', 'MISSING_OPTIONAL', `Missing ${rel}`, rel));
      return;
    }
    try {
      for (const item of asArray(readJsonFile(abs))) {
        const entry = parsePassthrough(NamedIndexEntrySchema, item, rel);
        target.set(entry.id, entry);
      }
    } catch (err) {
      warnings.push(diag('warning', 'NAMED_INDEX_PARSE', err instanceof Error ? err.message : String(err), rel));
    }
  }

  private loadSourceIndex(warnings: DiagnosticItem[]): void {
    const abs = path.join(this.rootDir, 'indexes/source-index.json');
    if (!fs.existsSync(abs)) {
      warnings.push(diag('warning', 'MISSING_OPTIONAL', 'Missing indexes/source-index.json', 'indexes/source-index.json'));
      return;
    }
    try {
      this.sourceIndex = asArray(readJsonFile(abs)) as SourceIndexEntry[];
    } catch (err) {
      warnings.push(diag('warning', 'SOURCE_INDEX_PARSE', err instanceof Error ? err.message : String(err)));
    }
  }

  private collectMarkdownAndAssets(warnings: DiagnosticItem[], errors: DiagnosticItem[]): void {
    for (const abs of walkFiles(this.rootDir)) {
      const rel = toPosixRelative(this.rootDir, abs);
      if (rel.startsWith('markdown/') || rel.startsWith('canonical/') || rel === 'README.md') {
        if (rel.endsWith('.md')) this.markdownFiles.push(rel);
      }
      if (rel.startsWith('assets/')) this.assetFiles.push(rel);
    }

    for (const rel of this.markdownFiles) {
      try {
        const md = fs.readFileSync(path.join(this.rootDir, rel), 'utf-8');
        const missing = verifyMarkdownImageLinks(this.rootDir, rel, md);
        for (const m of missing) {
          errors.push(diag('error', 'MARKDOWN_IMAGE_MISSING', `Missing image ${m} in ${rel}`, rel));
        }
      } catch (err) {
        warnings.push(diag('warning', 'MARKDOWN_READ', err instanceof Error ? err.message : String(err), rel));
      }
    }

    // Record-referenced images/frames
    for (const record of this.recordsById.values()) {
      for (const img of record.images ?? []) {
        const candidate = path.join(this.rootDir, img.startsWith('assets/') ? img : path.join('assets', img));
        if (!fs.existsSync(candidate)) {
          errors.push(diag('error', 'RECORD_IMAGE_MISSING', `Record ${record.id} image missing: ${img}`, img));
        }
      }
      for (const frame of record.frames ?? []) {
        const candidate = path.join(this.rootDir, frame.startsWith('assets/') ? frame : path.join('assets', frame));
        if (!fs.existsSync(candidate)) {
          errors.push(diag('error', 'RECORD_FRAME_MISSING', `Record ${record.id} frame missing: ${frame}`, frame));
        }
      }
    }
  }

  private computeCounts(): Record<string, number> {
    return {
      structured_records: this.recordsById.size,
      chunks: this.chunksById.size,
      videos: this.videosById.size,
      document_sections: [...this.recordsById.values()].filter((r) => r.content_type === 'document_section' || r.source_type === 'document').length,
      topics: this.topicIndex.size || [...this.recordsById.values()].filter((r) => r.content_type === 'topic').length,
      concepts: this.conceptIndex.size || [...this.recordsById.values()].filter((r) => r.content_type === 'concept').length,
      entities: this.entityIndex.size || [...this.recordsById.values()].filter((r) => r.content_type === 'entity').length,
      frames: [...this.framesByVideo.values()].reduce((s, a) => s + a.length, 0),
      graph_nodes: this.nodesById.size,
      graph_edges: this.edges.length,
      markdown_pages: this.markdownFiles.length,
      assets: this.assetFiles.length,
      document_video_links: this.allLinks.length,
    };
  }

  private buildFileInventory(): FileInventoryEntry[] {
    const knownAlternates = new Set([
      'structured/knowledge.json',
      'ingestion/chunks.json',
    ]);
    const parsedPrefixes = [
      'structured/', 'ingestion/', 'graph/', 'indexes/', 'manifest.json',
    ];
    return walkFiles(this.rootDir).map((abs) => {
      const relativePath = toPosixRelative(this.rootDir, abs);
      if (knownAlternates.has(relativePath)) {
        return { relativePath, classification: 'alternate-serialization' as const };
      }
      if (relativePath.startsWith('assets/')) {
        return { relativePath, classification: 'asset' as const };
      }
      if (relativePath.startsWith('markdown/') || relativePath.startsWith('canonical/') || relativePath === 'README.md' || relativePath.endsWith('.md')) {
        if (relativePath.startsWith('reports/')) {
          return { relativePath, classification: 'report' as const };
        }
        return { relativePath, classification: 'markdown' as const };
      }
      if (relativePath.startsWith('reports/')) {
        return { relativePath, classification: 'report' as const };
      }
      if (parsedPrefixes.some((p) => relativePath === p || relativePath.startsWith(p))) {
        return { relativePath, classification: 'parsed' as const };
      }
      return { relativePath, classification: 'unclassified' as const };
    });
  }

  private ensureReady(): void {
    if (!this.initialized || !this.manifest || !this.diagnostics) {
      throw new Error('KnowledgeBaseRepository not initialized — call initialize() first');
    }
  }

  getManifest(): KnowledgeBaseManifest {
    this.ensureReady();
    return this.manifest!;
  }

  getDiagnostics(): KnowledgeBaseDiagnostics {
    this.ensureReady();
    return this.diagnostics!;
  }

  getFileInventory(): FileInventoryEntry[] {
    this.ensureReady();
    return this.fileInventory;
  }

  getRawRecord(id: string): Record<string, unknown> | undefined {
    this.ensureReady();
    const raw = this.rawRecordsById.get(id);
    return raw ? structuredClone(raw) : undefined;
  }

  getRawChunk(chunkId: string): Record<string, unknown> | undefined {
    this.ensureReady();
    const raw = this.rawChunksById.get(chunkId);
    return raw ? structuredClone(raw) : undefined;
  }

  async *streamKnowledge(options?: FilterOptions): AsyncIterable<KnowledgeRecord> {
    this.ensureReady();
    for (const record of this.recordsById.values()) {
      if (matchesFilters(record, options)) yield structuredClone(record);
    }
  }

  async *streamChunks(options?: FilterOptions): AsyncIterable<KnowledgeChunk> {
    this.ensureReady();
    for (const chunk of this.chunksById.values()) {
      if (matchesFilters(chunk, options)) yield structuredClone(chunk);
    }
  }

  async getRecord(id: string): Promise<KnowledgeRecord | undefined> {
    this.ensureReady();
    const r = this.recordsById.get(id);
    return r ? structuredClone(r) : undefined;
  }

  async getChunk(chunkId: string): Promise<KnowledgeChunk | undefined> {
    this.ensureReady();
    const c = this.chunksById.get(chunkId);
    return c ? structuredClone(c) : undefined;
  }

  async getDocumentSection(id: string): Promise<KnowledgeRecord | undefined> {
    return this.getRecord(id);
  }

  async getTopic(id: string): Promise<KnowledgeRecord | undefined> {
    return this.getRecord(id);
  }

  async getConcept(id: string): Promise<KnowledgeRecord | undefined> {
    return this.getRecord(id);
  }

  async getEntity(id: string): Promise<KnowledgeRecord | undefined> {
    return this.getRecord(id);
  }

  async listVideos(): Promise<VideoIndexEntry[]> {
    this.ensureReady();
    return [...this.videosById.values()].map((v) => structuredClone(v));
  }

  async getDocumentVideoLinks(sectionId?: string): Promise<DocumentVideoLink[]> {
    this.ensureReady();
    if (sectionId) return structuredClone(this.linksBySection.get(sectionId) ?? []);
    return structuredClone(this.allLinks);
  }

  async getFrames(videoId: string): Promise<FrameIndexEntry[]> {
    this.ensureReady();
    return structuredClone(this.framesByVideo.get(videoId) ?? []);
  }

  async getProvenance(id: string): Promise<Array<Record<string, unknown>>> {
    const record = await this.getRecord(id);
    return structuredClone(record?.provenance ?? []);
  }

  async getNode(id: string): Promise<GraphNode | undefined> {
    this.ensureReady();
    const n = this.nodesById.get(id);
    return n ? structuredClone(n) : undefined;
  }

  async getOutgoingEdges(id: string, relationships?: string[]): Promise<GraphEdge[]> {
    this.ensureReady();
    let edges = this.outgoing.get(id) ?? [];
    if (relationships?.length) {
      const allow = new Set(relationships);
      edges = edges.filter((e) => allow.has(e.relationship));
    }
    return structuredClone(edges);
  }

  async getIncomingEdges(id: string, relationships?: string[]): Promise<GraphEdge[]> {
    this.ensureReady();
    let edges = this.incoming.get(id) ?? [];
    if (relationships?.length) {
      const allow = new Set(relationships);
      edges = edges.filter((e) => allow.has(e.relationship));
    }
    return structuredClone(edges);
  }

  async traverse(startId: string, options: TraversalOptions): Promise<GraphTraversalResult> {
    this.ensureReady();
    return traverseGraph({
      startId,
      nodesById: this.nodesById,
      outgoing: this.outgoing,
      incoming: this.incoming,
      options,
    });
  }

  async search(query: string, filters?: FilterOptions, limit?: number): Promise<SearchHit[]> {
    this.ensureReady();
    return lexicalSearchChunks({
      query,
      chunks: [...this.chunksById.values()],
      recordsById: this.recordsById,
      filters,
      limit,
    });
  }

  async getVideo(videoId: string): Promise<VideoView | undefined> {
    this.ensureReady();
    const indexEntry = this.videosById.get(videoId);
    const record = [...this.recordsById.values()].find((r) => r.video_id === videoId || r.id === videoId);
    if (!indexEntry && !record) return undefined;

    const chunks = structuredClone(this.chunksByVideoId.get(videoId) ?? []);
    const topicIds = new Set([...(record?.topics ?? []), ...(indexEntry?.['topics'] as string[] | undefined ?? [])]);
    const conceptIds = new Set(record?.concepts ?? []);
    const entityIds = new Set(record?.entities ?? []);

    for (const edge of [...(this.outgoing.get(videoId) ?? []), ...(this.incoming.get(videoId) ?? [])]) {
      if (edge.relationship === 'HAS_TOPIC') topicIds.add(edge.to === videoId ? edge.from : edge.to);
      if (edge.relationship === 'HAS_CONCEPT') conceptIds.add(edge.to === videoId ? edge.from : edge.to);
      if (edge.relationship === 'HAS_ENTITY') entityIds.add(edge.to === videoId ? edge.from : edge.to);
    }

    const topics = [...topicIds].map((id) => this.recordsById.get(id)).filter(Boolean) as KnowledgeRecord[];
    const concepts = [...conceptIds].map((id) => this.recordsById.get(id)).filter(Boolean) as KnowledgeRecord[];
    const entities = [...entityIds].map((id) => this.recordsById.get(id)).filter(Boolean) as KnowledgeRecord[];
    const frames = structuredClone(this.framesByVideo.get(videoId) ?? []);
    const frameAssets: ResolvedAsset[] = [];
    for (const frame of frames) {
      try {
        frameAssets.push(await resolveAsset(this.rootDir, frame.path));
      } catch {
        // already diagnosed during init
      }
    }

    const documentVideoLinks = structuredClone(this.linksByVideo.get(videoId) ?? []);
    const documentSections = documentVideoLinks
      .map((l) => this.recordsById.get(l.document_section_id))
      .filter(Boolean) as KnowledgeRecord[];

    let markdown: string | undefined;
    const mdCandidate = this.markdownFiles.find((f) => f.includes(videoId) || f.endsWith(`${videoId}.md`));
    if (mdCandidate) {
      markdown = fs.readFileSync(path.join(this.rootDir, mdCandidate), 'utf-8');
    }

    return {
      videoId,
      indexEntry: indexEntry ? structuredClone(indexEntry) : undefined,
      record: record ? structuredClone(record) : undefined,
      chunks,
      topics: structuredClone(topics),
      concepts: structuredClone(concepts),
      entities: structuredClone(entities),
      frames,
      frameAssets,
      documentSections: structuredClone(documentSections),
      documentVideoLinks,
      incomingEdges: structuredClone(this.incoming.get(videoId) ?? []),
      outgoingEdges: structuredClone(this.outgoing.get(videoId) ?? []),
      provenance: structuredClone(record?.provenance ?? []),
      markdown,
    };
  }

  async readCanonicalMarkdown(expanded = false): Promise<string> {
    this.ensureReady();
    const rel = expanded ? 'canonical/master-expanded.md' : 'canonical/master.md';
    const fallback = expanded ? 'markdown/master-expanded.md' : 'markdown/master.md';
    const abs = fs.existsSync(path.join(this.rootDir, rel))
      ? path.join(this.rootDir, rel)
      : path.join(this.rootDir, fallback);
    if (!fs.existsSync(abs)) throw new Error(`Canonical markdown not found: ${rel}`);
    return fs.readFileSync(abs, 'utf-8');
  }

  async readMarkdownPage(relativePath: string): Promise<string> {
    this.ensureReady();
    const abs = resolveUnderRoot(this.rootDir, relativePath);
    if (!abs.endsWith('.md') && !abs.endsWith('.markdown')) {
      throw new PathSafetyError(`Not a markdown path: ${relativePath}`);
    }
    return fs.readFileSync(abs, 'utf-8');
  }

  async resolveAsset(relativePath: string): Promise<ResolvedAsset> {
    this.ensureReady();
    return resolveAsset(this.rootDir, relativePath);
  }

  /** Flatten all knowledge into analysis-ready evidence documents (lossless text + metadata). */
  async toEvidenceDocuments(maxRecords = Number.POSITIVE_INFINITY): Promise<Array<Record<string, unknown>>> {
    this.ensureReady();
    const docs: Array<Record<string, unknown>> = [];
    let n = 0;
    for (const record of this.recordsById.values()) {
      docs.push({
        kind: 'knowledge_record',
        id: record.id,
        title: record.title,
        source_type: record.source_type,
        content_type: record.content_type,
        text: record.text,
        content_hash: record.content_hash,
        heading_path: record.heading_path,
        provenance: record.provenance,
        metadata: record.metadata,
        video_id: record.video_id,
        topics: record.topics,
        concepts: record.concepts,
        entities: record.entities,
        images: record.images,
        frames: record.frames,
        raw: this.rawRecordsById.get(record.id),
        isUserProvidedEvidence: true,
        isKnowledgeBaseEvidence: true,
      });
      n += 1;
      if (n >= maxRecords) break;
    }
    return docs;
  }
}

export { mimeForPath, optionalReadJson };
