import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { prisma } from '../../database/client';
import { config } from '../../config';
import { jobQueue } from '../../queue/job-queue';
import { ensureDir } from '../../utils/file-system';
import { processEvidenceImport, type UploadedFileInput } from '../../evidence/import-service';
import { logger } from '../../utils/logger';

export const evidenceRouter = Router({ mergeParams: true });

const uploadTempDir = path.join(os.tmpdir(), 'reverseforge-evidence-uploads');
ensureDir(uploadTempDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir(uploadTempDir);
      cb(null, uploadTempDir);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  // No upload size / file-count caps — accept any number and size of evidence files.
});

// POST /api/projects/:projectId/evidence/upload
evidenceRouter.post(
  '/upload',
  upload.array('files'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { projectId } = req.params;
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (uploaded.length === 0) {
        return res.status(400).json({ error: 'No files uploaded. Use multipart field name "files".' });
      }

      const session = await prisma.crawlSession.create({
        data: {
          projectId,
          status: 'pending',
          sourceType: 'upload',
        },
      });

      const files: UploadedFileInput[] = uploaded.map((file) => ({
        originalName: file.originalname,
        tempPath: file.path,
        size: file.size,
        mimetype: file.mimetype,
      }));

      const job = await jobQueue.addJob(
        'import-evidence',
        {
          projectId,
          projectSlug: project.slug,
          sessionId: session.id,
          files,
        },
        `import-evidence-${session.id}`,
      );

      logger.info(`Evidence upload queued for project ${project.slug}: ${files.length} file(s), session ${session.id}`);

      res.status(202).json({
        session,
        jobId: job.id,
        message: `${files.length} file(s) queued for import. They will be merged with crawler captures as additional evidence for analysis and report generation.`,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/projects/:projectId/evidence/:sessionId/manifest
evidenceRouter.get('/:sessionId/manifest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId, sessionId } = req.params;
    const session = await prisma.crawlSession.findFirst({
      where: { id: sessionId, projectId },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const manifestPath = path.join(
      config.outputDir,
      project.slug,
      sessionId,
      'upload-manifest.json',
    );

    if (!fs.existsSync(manifestPath)) {
      return res.json({
        session,
        manifest: session.uploadSummary ? JSON.parse(session.uploadSummary) : null,
      });
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
    res.json({ session, manifest });
  } catch (err) {
    next(err);
  }
});

export function registerEvidenceJobHandlers(): void {
  jobQueue.registerHandler<{
    projectId: string;
    projectSlug: string;
    sessionId: string;
    files: UploadedFileInput[];
  }>('import-evidence', async (job, updateProgress) => {
    const { projectId, projectSlug, sessionId, files } = job.data;
    updateProgress(10);

    await prisma.crawlSession.update({
      where: { id: sessionId },
      data: { status: 'running', startedAt: new Date() },
    });

    try {
      const result = await processEvidenceImport({
        projectId,
        projectSlug,
        sessionId,
        files,
      });
      updateProgress(100);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.crawlSession.update({
        where: { id: sessionId },
        data: {
          status: 'failed',
          errorMessage: message,
          finishedAt: new Date(),
        },
      });
      throw err;
    }
  });
}
