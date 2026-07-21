import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { prisma } from '../../database/client';
import { getReportsDir, getSessionOutputDir } from '../../utils/file-system';
import { config } from '../../config';

export const reportsRouter = Router({ mergeParams: true });

async function getProjectOr404(projectId: string | undefined) {
  if (!projectId) return null;
  return prisma.project.findUnique({ where: { id: projectId } });
}

async function getLatestReport(projectId: string | undefined) {
  if (!projectId) return null;
  return prisma.report.findFirst({
    where: { projectId, type: 'full' },
    orderBy: { createdAt: 'desc' },
  });
}

// GET /api/projects/:projectId/reports
reportsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params;
    const reports = await prisma.report.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ reports });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/reports/preview/latest - latest project-level report preview
reportsRouter.get('/preview/latest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await getLatestReport(req.params['projectId']);
    if (!report || !report.crawlSessionId) return res.status(404).json({ error: 'Report not generated yet' });

    const fullPath = path.resolve(process.cwd(), report.filePath);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Report file not found on disk' });
    }

    const outputDir = path.resolve(process.cwd(), config.outputDir);
    if (!fullPath.startsWith(outputDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    res.json({
      content,
      path: path.relative(process.cwd(), fullPath),
      report,
      sessionId: report.crawlSessionId,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/reports/export/latest - ZIP latest report anchor session outputs
reportsRouter.get('/export/latest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = await getProjectOr404(req.params['projectId']);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const report = await getLatestReport(req.params['projectId']);
    if (!report || !report.crawlSessionId) return res.status(404).json({ error: 'Report not generated yet' });

    const sessionDir = getSessionOutputDir(project.slug, report.crawlSessionId);
    if (!fs.existsSync(sessionDir)) {
      return res.status(404).json({ error: 'Report output not found' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${project.slug}-latest-report.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => next(err));
    archive.pipe(res);
    archive.directory(sessionDir, project.slug);
    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/reports/:reportId/download
reportsRouter.get('/:reportId/download', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await prisma.report.findUnique({ where: { id: req.params['reportId'] } });
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const fullPath = path.resolve(process.cwd(), report.filePath);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Report file not found on disk' });
    }

    // Security: ensure path is within outputDir
    const outputDir = path.resolve(process.cwd(), config.outputDir);
    if (!fullPath.startsWith(outputDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.download(fullPath);
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/crawls/:sessionId/export — download all outputs as ZIP
reportsRouter.get('/export/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = await prisma.project.findUnique({ where: { id: req.params['projectId'] } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const sessionDir = getSessionOutputDir(project.slug, req.params['sessionId']);

    if (!fs.existsSync(sessionDir)) {
      return res.status(404).json({ error: 'Session output not found' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${project.slug}-${req.params['sessionId']}.zip"`,
    );

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => next(err));
    archive.pipe(res);
    archive.directory(sessionDir, project.slug);
    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/reports/preview/:sessionId — inline markdown preview
reportsRouter.get('/preview/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = await prisma.project.findUnique({ where: { id: req.params['projectId'] } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const reportsDir = getReportsDir(project.slug, req.params['sessionId']);
    const reportPath = path.join(reportsDir, 'final-report.md');

    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ error: 'Report not generated yet' });
    }

    const content = fs.readFileSync(reportPath, 'utf-8');
    res.json({ content, path: path.relative(process.cwd(), reportPath) });
  } catch (err) {
    next(err);
  }
});
