/** Lossless types — known fields plus open extension bags. */

export type Extensible = Record<string, unknown>;

export interface KnowledgeBaseManifest extends Extensible {
  schema_version: string;
  primary_paths?: Record<string, string>;
  statistics?: Record<string, number>;
  source?: Extensible;
  build?: Extensible;
}

export interface KnowledgeRecord extends Extensible {
  id: string;
  source_type: string;
  content_type: string;
  title: string;
  text: string;
  content_hash: string;
  source_file: string;
  source_path?: string | null;
  heading_path: string[];
  document_section_id?: string | null;
  video_id?: string | null;
  bundle_name?: string | null;
  video_refs: string[];
  images: string[];
  frames: string[];
  entities: string[];
  concepts: string[];
  topics: string[];
  provenance: Extensible[];
  metadata: Extensible;
}

export interface KnowledgeChunk extends Extensible {
  chunk_id: string;
  source_id: string;
  text: string;
  source_type?: string;
  content_type?: string;
  video_id?: string | null;
  document_section_id?: string | null;
  heading_path?: string[];
  topics?: string[];
  concepts?: string[];
  entities?: string[];
}

export interface GraphNode extends Extensible {
  id: string;
  label?: string;
  type?: string;
}

export interface GraphEdge extends Extensible {
  id?: string;
  from: string;
  to: string;
  relationship: string;
}

export interface VideoIndexEntry extends Extensible {
  video_id: string;
  bundle_name?: string;
  title?: string;
}

export interface DocumentVideoLink extends Extensible {
  document_section_id: string;
  video_id?: string | null;
  bundle_name?: string | null;
  resolved?: boolean;
  reason?: string | null;
}

export interface FrameIndexEntry extends Extensible {
  video_id: string;
  frame_key?: string;
  path: string;
}

export interface SourceIndexEntry extends Extensible {
  id?: string;
  source_file?: string;
  path?: string;
}

export interface NamedIndexEntry extends Extensible {
  id: string;
  name?: string;
  title?: string;
}

export interface ValidationReport extends Extensible {
  status?: string;
  warnings?: unknown[];
  errors?: unknown[];
}

export interface DiagnosticItem {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  path?: string;
}

export interface KnowledgeBaseDiagnostics {
  schemaVersion: string | null;
  sourceDocumentSha256: string | null;
  initialized: boolean;
  errors: DiagnosticItem[];
  warnings: DiagnosticItem[];
  info: DiagnosticItem[];
  counts: Record<string, number>;
  manifestStatistics: Record<string, number>;
  unresolvedVideoReferences: number;
  resolvedVideoReferences: number;
  validationStatus: 'PASS' | 'FAIL' | 'UNKNOWN';
  humanReport: string;
}

export interface FilterOptions {
  source_type?: string;
  content_type?: string;
  video_id?: string;
  document_section_id?: string;
  topics?: string[];
  concepts?: string[];
  entities?: string[];
  heading_path?: string[];
  ids?: string[];
}

export interface TraversalOptions {
  maxDepth?: number;
  limit?: number;
  relationships?: string[];
  direction?: 'outgoing' | 'incoming' | 'both';
}

export interface GraphTraversalResult {
  startId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: string[][];
}

export interface ResolvedAsset {
  absolutePath: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  bytes: Buffer;
}

export interface VideoView {
  videoId: string;
  indexEntry: VideoIndexEntry | undefined;
  record: KnowledgeRecord | undefined;
  chunks: KnowledgeChunk[];
  topics: KnowledgeRecord[];
  concepts: KnowledgeRecord[];
  entities: KnowledgeRecord[];
  frames: FrameIndexEntry[];
  frameAssets: ResolvedAsset[];
  documentSections: KnowledgeRecord[];
  documentVideoLinks: DocumentVideoLink[];
  incomingEdges: GraphEdge[];
  outgoingEdges: GraphEdge[];
  provenance: Extensible[];
  markdown?: string;
}

export interface SearchHit {
  chunk: KnowledgeChunk;
  score: number;
  explanation: string;
  sourceRecord?: KnowledgeRecord;
}

export interface FileInventoryEntry {
  relativePath: string;
  classification: 'parsed' | 'markdown' | 'report' | 'asset' | 'alternate-serialization' | 'unclassified';
}
