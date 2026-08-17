import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import { z } from 'zod';
import slugify from 'slugify';
import { prisma } from '../../database/client';
import { config } from '../../config';
import { removeDir } from '../../utils/file-system';
import { jobQueue } from '../../queue/job-queue';
import { logger } from '../../utils/logger';

export const projectsRouter = Router();

function redactProjectSecret<T extends { llmApiKey?: string | null }>(project: T) {
  const { llmApiKey, ...safeProject } = project;
  return { ...safeProject, llmApiKeyConfigured: Boolean(llmApiKey) };
}

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  loginUrl: z.string().url().optional(),
  loginRequired: z.boolean().default(false),
  crawlDepth: z.number().int().min(1).max(10).default(3),
  allowedDomains: z.array(z.string()).default([]),
  excludedUrls: z.array(z.string()).default([]),
  screenshotEnabled: z.boolean().default(true),
  networkCaptureEnabled: z.boolean().default(true),
  aiEnabled: z.boolean().default(false),
  llmBaseUrl: z.string().url().optional(),
  llmApiKey: z.string().optional(),
  llmModel: z.string().optional(),
  safeClickSelectors: z.array(z.string()).default([]),
});

// GET /api/projects
projectsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { crawlSessions: true } },
      },
    });
    res.json({ projects: projects.map(redactProjectSecret) });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects
projectsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = CreateProjectSchema.parse(req.body);
    const slug = slugify(body.name, { lower: true, strict: true }) + '-' + Date.now();

    const project = await prisma.project.create({
      data: {
        ...body,
        slug,
        allowedDomains: JSON.stringify(body.allowedDomains),
        excludedUrls: JSON.stringify(body.excludedUrls),
        safeClickSelectors: JSON.stringify(body.safeClickSelectors),
      },
    });

    res.status(201).json({ project: redactProjectSecret(project) });
  } catch (err) {
    next(err);
  }
});

const CloneProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

// POST /api/projects/:id/clone — copy settings into a new empty project (no crawls/reports)
projectsRouter.post('/:id/clone', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = await prisma.project.findUnique({ where: { id: req.params['id'] } });
    if (!source) return res.status(404).json({ error: 'Project not found' });

    const body = CloneProjectSchema.parse(req.body ?? {});
    const name = (body.name?.trim() || `${source.name} (Copy)`).slice(0, 100);
    const slug = slugify(name, { lower: true, strict: true }) + '-' + Date.now();

    const project = await prisma.project.create({
      data: {
        name,
        slug,
        baseUrl: source.baseUrl,
        loginUrl: source.loginUrl,
        loginRequired: source.loginRequired,
        crawlDepth: source.crawlDepth,
        allowedDomains: source.allowedDomains,
        excludedUrls: source.excludedUrls,
        screenshotEnabled: source.screenshotEnabled,
        networkCaptureEnabled: source.networkCaptureEnabled,
        aiEnabled: source.aiEnabled,
        llmBaseUrl: source.llmBaseUrl,
        llmApiKey: source.llmApiKey,
        llmModel: source.llmModel,
        safeClickSelectors: source.safeClickSelectors,
      },
      include: {
        _count: { select: { crawlSessions: true } },
      },
    });

    logger.info(`Project cloned: ${source.name} → ${project.name} [${source.id} → ${project.id}]`);
    res.status(201).json({ project: redactProjectSecret(project) });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:id
projectsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params['id'] },
      include: {
        crawlSessions: {
          orderBy: { createdAt: 'desc' },
          include: { _count: { select: { pages: true, networkCalls: true } } },
        },
      },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: redactProjectSecret(project) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/projects/:id
projectsRouter.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = CreateProjectSchema.partial().parse(req.body);
    const data: Record<string, unknown> = { ...body };
    if (body.allowedDomains) data['allowedDomains'] = JSON.stringify(body.allowedDomains);
    if (body.excludedUrls) data['excludedUrls'] = JSON.stringify(body.excludedUrls);
    if (body.safeClickSelectors) data['safeClickSelectors'] = JSON.stringify(body.safeClickSelectors);

    const project = await prisma.project.update({
      where: { id: req.params['id'] },
      data,
    });
    res.json({ project: redactProjectSecret(project) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:id — full wipe (DB + disk). Requires confirmName matching project.name.
projectsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = req.params['id'];
    const confirmName = typeof req.body?.confirmName === 'string' ? req.body.confirmName.trim() : '';

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!confirmName || confirmName !== project.name) {
      return res.status(400).json({
        error: 'Confirmation failed. Type the exact project name to delete.',
      });
    }

    // Cancel any in-flight jobs tied to this project
    const jobIds = [
      `project-report-${projectId}`,
      ...jobQueue.getAllJobs()
        .filter((j) => {
          const data = j.data as { projectId?: string } | undefined;
          return data?.projectId === projectId && (j.status === 'waiting' || j.status === 'active');
        })
        .map((j) => j.id),
    ];
    for (const jobId of [...new Set(jobIds)]) {
      await jobQueue.cancelJob(jobId).catch(() => undefined);
    }

    // Tables without Prisma cascade from Project
    await prisma.entityModel.deleteMany({ where: { projectId } });
    await prisma.workflowModel.deleteMany({ where: { projectId } });
    await prisma.analysisFinding.deleteMany({ where: { projectId } });
    await prisma.analysisGraphEdge.deleteMany({ where: { projectId } });
    await prisma.analysisGraphNode.deleteMany({ where: { projectId } });

    // Cascades: CrawlSession → pages, networkCalls, reports, graph rows
    await prisma.project.delete({ where: { id: projectId } });

    // Disk: crawl output + browser session storage + generation checkpoint
    const outputRoot = path.resolve(config.outputDir);
    const sessionRoot = path.resolve(config.sessionDir);
    const projectOutputDir = path.resolve(outputRoot, project.slug);
    const projectSessionDir = path.resolve(sessionRoot, project.slug);

    const deletedPaths: string[] = [];
    const isSafeChild = (child: string, root: string) => {
      const rel = path.relative(root, child);
      return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    if (isSafeChild(projectOutputDir, outputRoot) && removeDir(projectOutputDir)) {
      deletedPaths.push(projectOutputDir);
    }
    if (isSafeChild(projectSessionDir, sessionRoot) && removeDir(projectSessionDir)) {
      deletedPaths.push(projectSessionDir);
    }

    logger.info(`Project deleted: ${project.name} [${projectId}]`, { deletedPaths });
    res.json({ success: true, deletedPaths });
  } catch (err) {
    next(err);
  }
});
