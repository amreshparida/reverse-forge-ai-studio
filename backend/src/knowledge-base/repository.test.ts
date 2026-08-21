import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  KnowledgeBaseRepository,
  detectKnowledgeBaseRoot,
  defaultFixtureKbRoot,
  streamJsonlLines,
  JsonlParseError,
  resolveUnderRoot,
  PathSafetyError,
  writeJsonlSync,
} from './index';
import { KnowledgeRecordSchema, parsePassthrough } from './schemas';

const fixtureRoot = defaultFixtureKbRoot();

describe('knowledge-base path safety', () => {
  it('rejects traversal and absolute paths', () => {
    expect(() => resolveUnderRoot(fixtureRoot, '../secret')).toThrow(PathSafetyError);
    expect(() => resolveUnderRoot(fixtureRoot, '/etc/passwd')).toThrow(PathSafetyError);
  });

  it('resolves safe relative paths', () => {
    const abs = resolveUnderRoot(fixtureRoot, 'manifest.json');
    expect(abs).toBe(path.resolve(fixtureRoot, 'manifest.json'));
  });
});

describe('jsonl streaming', () => {
  it('streams lines and reports line-numbered errors', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-'));
    const file = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(file, '{"ok":1}\n{bad\n{"ok":2}\n', 'utf-8');
    const values: unknown[] = [];
    await expect(async () => {
      for await (const entry of streamJsonlLines(file)) {
        values.push(entry.value);
      }
    }).rejects.toBeInstanceOf(JsonlParseError);
    expect(values).toHaveLength(1);
  });
});

describe('schema passthrough', () => {
  it('retains unknown fields', () => {
    const parsed = parsePassthrough(
      KnowledgeRecordSchema,
      {
        id: 'x',
        source_type: 'document',
        content_type: 'document_section',
        title: 't',
        text: 'body',
        content_hash: 'h',
        source_file: 'a.docx',
        heading_path: [],
        video_refs: [],
        images: [],
        frames: [],
        entities: [],
        concepts: [],
        topics: [],
        provenance: [],
        metadata: {},
        custom_field: 'keep-me',
      },
      'test',
    );
    expect((parsed as Record<string, unknown>)['custom_field']).toBe('keep-me');
  });
});

describe('KnowledgeBaseRepository against sample fixture', () => {
  it('detects KB root', () => {
    expect(detectKnowledgeBaseRoot(path.dirname(fixtureRoot))).toBe(fixtureRoot);
    const nested = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-wrap-'));
    const output = path.join(nested, 'output');
    fs.cpSync(fixtureRoot, output, { recursive: true });
    expect(detectKnowledgeBaseRoot(nested)).toBe(output);
  });

  it('initializes and reconciles counts', async () => {
    const repo = new KnowledgeBaseRepository(fixtureRoot);
    await repo.initialize();
    const d = repo.getDiagnostics();
    expect(d.schemaVersion).toBe('1.0.0');
    expect(d.counts['structured_records']).toBe(5);
    expect(d.counts['chunks']).toBe(3);
    expect(d.counts['videos']).toBe(1);
    expect(d.counts['graph_nodes']).toBe(5);
    expect(d.counts['graph_edges']).toBe(4);
    expect(d.counts['frames']).toBe(1);
    expect(d.unresolvedVideoReferences).toBe(1);
    expect(d.resolvedVideoReferences).toBe(1);
    expect(d.validationStatus).toBe('PASS');
    expect(d.sourceDocumentSha256).toBe('abc123fixturesha');
  });

  it('preserves lossless raw records including unknown fields', async () => {
    const repo = new KnowledgeBaseRepository(fixtureRoot);
    await repo.initialize();
    const raw = repo.getRawRecord('sec-1');
    expect(raw?.['custom_field']).toBe('keep-me');
    const record = await repo.getRecord('sec-1');
    expect(record?.title).toBe('Admissions Overview');
    // Mutating returned object must not mutate store
    record!.title = 'mutated';
    expect((await repo.getRecord('sec-1'))?.title).toBe('Admissions Overview');
  });

  it('is case-sensitive for video ids', async () => {
    const repo = new KnowledgeBaseRepository(fixtureRoot);
    await repo.initialize();
    expect(await repo.getVideo('vid-orientation')).toBeTruthy();
    expect(await repo.getVideo('VID-ORIENTATION')).toBeUndefined();
  });

  it('resolves document-video links from index only', async () => {
    const repo = new KnowledgeBaseRepository(fixtureRoot);
    await repo.initialize();
    const links = await repo.getDocumentVideoLinks('sec-1');
    expect(links).toHaveLength(1);
    expect(links[0]?.video_id).toBe('vid-orientation');
    const unresolved = await repo.getDocumentVideoLinks('sec-missing');
    expect(unresolved[0]?.resolved).toBe(false);
    expect(unresolved[0]?.reason).toContain('no matching');
  });

  it('searches chunks lexically and joins source records', async () => {
    const repo = new KnowledgeBaseRepository(fixtureRoot);
    await repo.initialize();
    const hits = await repo.search('transcripts personal statement');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunk.chunk_id).toBe('chk-1');
    expect(hits[0]?.sourceRecord?.id).toBe('sec-1');
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it('traverses graph with cycle safety', async () => {
    const repo = new KnowledgeBaseRepository(fixtureRoot);
    await repo.initialize();
    const result = await repo.traverse('vid-orientation', {
      maxDepth: 2,
      relationships: ['HAS_TOPIC', 'HAS_CONCEPT', 'HAS_ENTITY'],
    });
    expect(result.nodes.map((n) => n.id).sort()).toEqual(
      ['con-admission', 'ent-registrar', 'top-admissions', 'vid-orientation'].sort(),
    );
  });

  it('resolves assets and markdown images', async () => {
    const repo = new KnowledgeBaseRepository(fixtureRoot);
    await repo.initialize();
    const asset = await repo.resolveAsset('assets/document-images/fig1.png');
    expect(asset.mimeType).toBe('image/png');
    expect(asset.bytes.length).toBeGreaterThan(0);
    const md = await repo.readMarkdownPage('markdown/document-sections/sec-1.md');
    expect(md).toContain('Admissions Overview');
  });

  it('returns provenance unchanged', async () => {
    const repo = new KnowledgeBaseRepository(fixtureRoot);
    await repo.initialize();
    const prov = await repo.getProvenance('sec-1');
    expect(prov[0]?.['path']).toBe('exports/document.docx');
  });

  it('classifies every fixture file', async () => {
    const repo = new KnowledgeBaseRepository(fixtureRoot);
    await repo.initialize();
    const inventory = repo.getFileInventory();
    const unclassified = inventory.filter((f) => f.classification === 'unclassified');
    expect(unclassified).toEqual([]);
  });

  it('lossless round-trip for every knowledge jsonl object', async () => {
    const repo = new KnowledgeBaseRepository(fixtureRoot);
    await repo.initialize();
    const file = path.join(fixtureRoot, 'structured/knowledge.jsonl');
    for await (const entry of streamJsonlLines(file)) {
      const src = entry.value as Record<string, unknown>;
      const id = String(src['id']);
      const raw = repo.getRawRecord(id);
      expect(raw).toEqual(src);
    }
  });

  it('json and jsonl knowledge sets match', async () => {
    const repo = new KnowledgeBaseRepository(fixtureRoot);
    await repo.initialize();
    const json = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'structured/knowledge.json'), 'utf-8')) as Array<{ id: string }>;
    const ids = new Set(json.map((r) => r.id));
    let count = 0;
    for await (const r of repo.streamKnowledge()) {
      expect(ids.has(r.id)).toBe(true);
      count += 1;
    }
    expect(count).toBe(ids.size);
  });
});

describe('writeJsonlSync helper', () => {
  it('writes readable jsonl', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-w-'));
    const file = path.join(dir, 'out.jsonl');
    writeJsonlSync(file, [{ a: 1 }, { b: 2 }]);
    const rows: unknown[] = [];
    for await (const e of streamJsonlLines(file)) rows.push(e.value);
    expect(rows).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
