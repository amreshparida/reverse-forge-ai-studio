import type { FilterOptions, KnowledgeChunk, KnowledgeRecord, SearchHit } from './types';

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length > 1);
}

export function matchesFilters(
  item: {
    source_type?: string | null;
    content_type?: string | null;
    video_id?: string | null;
    document_section_id?: string | null;
    topics?: string[] | null;
    concepts?: string[] | null;
    entities?: string[] | null;
    heading_path?: string[] | null;
    id?: string;
    chunk_id?: string;
  },
  filters?: FilterOptions,
): boolean {
  if (!filters) return true;
  if (filters.source_type && item.source_type !== filters.source_type) return false;
  if (filters.content_type && item.content_type !== filters.content_type) return false;
  if (filters.video_id && item.video_id !== filters.video_id) return false;
  if (filters.document_section_id && item.document_section_id !== filters.document_section_id) {
    return false;
  }
  if (filters.ids?.length) {
    const id = item.id ?? item.chunk_id;
    if (!id || !filters.ids.includes(id)) return false;
  }
  if (filters.topics?.length) {
    const topics = item.topics ?? [];
    if (!filters.topics.every((t) => topics.includes(t))) return false;
  }
  if (filters.concepts?.length) {
    const concepts = item.concepts ?? [];
    if (!filters.concepts.every((c) => concepts.includes(c))) return false;
  }
  if (filters.entities?.length) {
    const entities = item.entities ?? [];
    if (!filters.entities.every((e) => entities.includes(e))) return false;
  }
  if (filters.heading_path?.length) {
    const path = item.heading_path ?? [];
    if (!filters.heading_path.every((h, i) => path[i] === h)) return false;
  }
  return true;
}

/**
 * Deterministic BM25-style lexical scorer over chunks.
 * Returns complete chunk objects; score/explanation are separate.
 */
export function lexicalSearchChunks(args: {
  query: string;
  chunks: KnowledgeChunk[];
  recordsById: Map<string, KnowledgeRecord>;
  filters?: FilterOptions;
  limit?: number;
}): SearchHit[] {
  const tokens = tokenize(args.query);
  if (tokens.length === 0) return [];

  const docs = args.chunks.filter((c) => matchesFilters(c, args.filters));
  const N = docs.length || 1;
  const avgdl = docs.reduce((s, d) => s + tokenize(d.text).length, 0) / N;
  const k1 = 1.2;
  const b = 0.75;

  const df = new Map<string, number>();
  for (const doc of docs) {
    const uniq = new Set(tokenize(doc.text));
    for (const t of uniq) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const hits: SearchHit[] = [];
  for (const chunk of docs) {
    const terms = tokenize(chunk.text);
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    const dl = terms.length || 1;
    let score = 0;
    const matched: string[] = [];
    for (const q of tokens) {
      const f = tf.get(q) ?? 0;
      if (f === 0) continue;
      matched.push(q);
      const n = df.get(q) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl)));
    }
    if (score <= 0) continue;
    hits.push({
      chunk,
      score,
      explanation: `matched tokens: ${matched.join(', ')}`,
      sourceRecord: args.recordsById.get(chunk.source_id),
    });
  }

  hits.sort((a, b) => b.score - a.score || a.chunk.chunk_id.localeCompare(b.chunk.chunk_id));
  return hits.slice(0, args.limit ?? 20);
}
