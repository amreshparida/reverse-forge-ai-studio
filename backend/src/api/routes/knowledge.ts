import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { prisma } from '../../database/client';
import { config } from '../../config';
import { KnowledgeBaseRepository } from '../../knowledge-base';

export const knowledgeRouter = Router({ mergeParams: true });

async function getKbRepo(projectId: string, sessionId?: string): Promise<{
  repo: KnowledgeBaseRepository;
  sessionId: string;
} | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return null;

  let sid = sessionId;
  if (!sid) {
    const sessions = await prisma.crawlSession.findMany({
      where: { projectId, sourceType: 'upload' },
      orderBy: { createdAt: 'desc' },
    });
    for (const s of sessions) {
      const candidate = path.join(config.outputDir, project.slug, s.id, 'knowledge-base', 'manifest.json');
      if (fs.existsSync(candidate)) {
        sid = s.id;
        break;
      }
    }
  }
  if (!sid) return null;

  const kbDir = path.join(config.outputDir, project.slug, sid, 'knowledge-base');
  if (!fs.existsSync(path.join(kbDir, 'manifest.json'))) return null;
  const repo = new KnowledgeBaseRepository(kbDir);
  await repo.initialize();
  return { repo, sessionId: sid };
}

knowledgeRouter.get('/health', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await getKbRepo(req.params['projectId']!, req.query['sessionId'] as string | undefined);
    if (!loaded) return res.status(404).json({ error: 'No knowledge base found for this project' });
    const d = loaded.repo.getDiagnostics();
    res.json({
      ok: d.validationStatus !== 'FAIL',
      sessionId: loaded.sessionId,
      schemaVersion: d.schemaVersion,
      sourceDocumentSha256: d.sourceDocumentSha256,
      validationStatus: d.validationStatus,
      counts: d.counts,
      errors: d.errors.length,
      warnings: d.warnings.length,
    });
  } catch (err) {
    next(err);
  }
});

knowledgeRouter.get('/manifest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await getKbRepo(req.params['projectId']!, req.query['sessionId'] as string | undefined);
    if (!loaded) return res.status(404).json({ error: 'No knowledge base found' });
    res.json({ sessionId: loaded.sessionId, manifest: loaded.repo.getManifest() });
  } catch (err) {
    next(err);
  }
});

knowledgeRouter.get('/reports/validation', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await getKbRepo(req.params['projectId']!, req.query['sessionId'] as string | undefined);
    if (!loaded) return res.status(404).json({ error: 'No knowledge base found' });
    res.json({ sessionId: loaded.sessionId, diagnostics: loaded.repo.getDiagnostics() });
  } catch (err) {
    next(err);
  }
});

knowledgeRouter.get('/records/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await getKbRepo(req.params['projectId']!, req.query['sessionId'] as string | undefined);
    if (!loaded) return res.status(404).json({ error: 'No knowledge base found' });
    const record = await loaded.repo.getRecord(req.params['id']!);
    if (!record) return res.status(404).json({ error: 'Record not found' });
    res.json({ record, raw: loaded.repo.getRawRecord(req.params['id']!) });
  } catch (err) {
    next(err);
  }
});

knowledgeRouter.get('/chunks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await getKbRepo(req.params['projectId']!, req.query['sessionId'] as string | undefined);
    if (!loaded) return res.status(404).json({ error: 'No knowledge base found' });
    const chunk = await loaded.repo.getChunk(req.params['id']!);
    if (!chunk) return res.status(404).json({ error: 'Chunk not found' });
    res.json({ chunk, raw: loaded.repo.getRawChunk(req.params['id']!) });
  } catch (err) {
    next(err);
  }
});

knowledgeRouter.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await getKbRepo(req.params['projectId']!, req.query['sessionId'] as string | undefined);
    if (!loaded) return res.status(404).json({ error: 'No knowledge base found' });
    const q = String(req.query['q'] ?? '');
    const hits = await loaded.repo.search(q, {
      source_type: req.query['source_type'] as string | undefined,
      content_type: req.query['content_type'] as string | undefined,
      video_id: req.query['video_id'] as string | undefined,
      document_section_id: req.query['document_section_id'] as string | undefined,
    }, Number(req.query['limit'] ?? 20));
    res.json({ query: q, hits });
  } catch (err) {
    next(err);
  }
});

knowledgeRouter.get('/videos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await getKbRepo(req.params['projectId']!, req.query['sessionId'] as string | undefined);
    if (!loaded) return res.status(404).json({ error: 'No knowledge base found' });
    res.json({ videos: await loaded.repo.listVideos() });
  } catch (err) {
    next(err);
  }
});

knowledgeRouter.get('/videos/:videoId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await getKbRepo(req.params['projectId']!, req.query['sessionId'] as string | undefined);
    if (!loaded) return res.status(404).json({ error: 'No knowledge base found' });
    const view = await loaded.repo.getVideo(req.params['videoId']!);
    if (!view) return res.status(404).json({ error: 'Video not found' });
    // Omit raw frame bytes from JSON response
    res.json({
      video: {
        ...view,
        frameAssets: view.frameAssets.map((a) => ({
          relativePath: a.relativePath,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

knowledgeRouter.get('/sections/:sectionId/videos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await getKbRepo(req.params['projectId']!, req.query['sessionId'] as string | undefined);
    if (!loaded) return res.status(404).json({ error: 'No knowledge base found' });
    const links = await loaded.repo.getDocumentVideoLinks(req.params['sectionId']);
    res.json({ sectionId: req.params['sectionId'], links });
  } catch (err) {
    next(err);
  }
});

knowledgeRouter.get('/graph/nodes/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await getKbRepo(req.params['projectId']!, req.query['sessionId'] as string | undefined);
    if (!loaded) return res.status(404).json({ error: 'No knowledge base found' });
    const node = await loaded.repo.getNode(req.params['id']!);
    if (!node) return res.status(404).json({ error: 'Node not found' });
    res.json({
      node,
      outgoing: await loaded.repo.getOutgoingEdges(req.params['id']!),
      incoming: await loaded.repo.getIncomingEdges(req.params['id']!),
    });
  } catch (err) {
    next(err);
  }
});

knowledgeRouter.get('/graph/traverse', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await getKbRepo(req.params['projectId']!, req.query['sessionId'] as string | undefined);
    if (!loaded) return res.status(404).json({ error: 'No knowledge base found' });
    const startId = String(req.query['startId'] ?? '');
    if (!startId) return res.status(400).json({ error: 'startId is required' });
    const relationships = typeof req.query['relationships'] === 'string'
      ? req.query['relationships'].split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const result = await loaded.repo.traverse(startId, {
      maxDepth: Number(req.query['maxDepth'] ?? 2),
      limit: Number(req.query['limit'] ?? 100),
      relationships,
      direction: (req.query['direction'] as 'outgoing' | 'incoming' | 'both' | undefined) ?? 'outgoing',
    });
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

knowledgeRouter.use('/assets', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await getKbRepo(req.params['projectId']!, req.query['sessionId'] as string | undefined);
    if (!loaded) return res.status(404).json({ error: 'No knowledge base found' });
    const rel = req.path.replace(/^\/+/, '');
    const asset = await loaded.repo.resolveAsset(rel.startsWith('assets/') ? rel : `assets/${rel}`);
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(asset.bytes);
  } catch (err) {
    if (err instanceof Error && /Asset|Path|escapes/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});
