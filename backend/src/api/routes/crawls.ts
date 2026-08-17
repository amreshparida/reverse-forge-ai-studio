import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import { prisma } from '../../database/client';
import { jobQueue } from '../../queue/job-queue';
import { runCrawl } from '../../crawler';
import { runAgentCrawl } from '../../agent/runner';
import { runCollaborativeCrawl } from '../../agent/multi-agent-runner';
import { runManualCrawl } from '../../crawler/manual';
import { analyzeSession } from '../../ai/analyzer';
import { getProjectGenerationStatus, runReportGeneration } from '../../generators/generation-runner';
import { readCheckpoint } from '../../generators/checkpoint';
import { logger } from '../../utils/logger';
import { crawlLogBus, emitCrawlLog } from '../../crawler/live-log';
import { crawlAbortRegistry } from '../../crawler/crawl-abort';
import { config } from '../../config';
import { removeDir } from '../../utils/file-system';
import type { LLMConfig } from '../../ai/llm';

export const crawlsRouter = Router({ mergeParams: true });
const ACTIVE_CRAWL_STATUSES = ['pending', 'awaiting_login', 'running'] as const;

// ── Literal routes first (must come before /:sessionId) ──────────────────

// GET /api/projects/:projectId/crawls
crawlsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessions = await prisma.crawlSession.findMany({
      where: { projectId: req.params['projectId'] },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { pages: true, networkCalls: true } } },
    });
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/crawls — start a new crawl
crawlsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params;
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const running = await prisma.crawlSession.findFirst({
      where: { projectId, status: { in: [...ACTIVE_CRAWL_STATUSES] } },
    });
    if (running) {
      return res.status(409).json({ error: 'A crawl is already running for this project', sessionId: running.id });
    }

    const session = await prisma.crawlSession.create({
      data: { projectId, status: 'pending' },
    });

    await jobQueue.addJob(
      'crawl',
      { projectId, sessionId: session.id, projectSlug: project.slug },
      `crawl-${session.id}`,
    );

    res.status(202).json({ session });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/crawls/manual — human-guided headed-browser capture
crawlsRouter.post('/manual', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params;
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const active = await prisma.crawlSession.findFirst({
      where: { projectId, status: { in: [...ACTIVE_CRAWL_STATUSES] } },
    });
    if (active) {
      return res.status(409).json({ error: 'A crawl is already active for this project', sessionId: active.id });
    }

    const session = await prisma.crawlSession.create({ data: { projectId, status: 'pending' } });
    await jobQueue.addJob(
      'manual-crawl',
      { projectId, sessionId: session.id, projectSlug: project.slug },
      `manual-${session.id}`,
    );
    res.status(202).json({ session, mode: 'manual' });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/crawls/collaborative — BFS + LLM agents run together
crawlsRouter.post('/collaborative', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params;
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const running = await prisma.crawlSession.findFirst({
      where: { projectId, status: { in: [...ACTIVE_CRAWL_STATUSES] } },
    });
    if (running) return res.status(409).json({ error: 'A crawl is already running', sessionId: running.id });

    const session = await prisma.crawlSession.create({ data: { projectId, status: 'pending' } });
    const llmConfig: LLMConfig = {
      baseUrl: project.llmBaseUrl ?? undefined,
      apiKey: project.llmApiKey ?? undefined,
      model: project.llmModel ?? undefined,
    };

    await jobQueue.addJob(
      'collaborative-crawl',
      { projectId, sessionId: session.id, projectSlug: project.slug, llmConfig },
      `collab-${session.id}`,
    );
    res.status(202).json({ session, mode: 'collaborative' });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/crawls/agent — start an AI-agentic crawl
crawlsRouter.post('/agent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params;
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!project.llmApiKey && !process.env['LLM_API_KEY']) {
      return res.status(400).json({ error: 'Agent crawl requires LLM_API_KEY to be configured' });
    }

    const running = await prisma.crawlSession.findFirst({
      where: { projectId, status: { in: [...ACTIVE_CRAWL_STATUSES] } },
    });
    if (running) return res.status(409).json({ error: 'A crawl is already running', sessionId: running.id });

    const session = await prisma.crawlSession.create({ data: { projectId, status: 'pending' } });
    const llmConfig: LLMConfig = {
      baseUrl: project.llmBaseUrl ?? undefined,
      apiKey: project.llmApiKey ?? undefined,
      model: project.llmModel ?? undefined,
    };

    await jobQueue.addJob('agent-crawl', { projectId, sessionId: session.id, projectSlug: project.slug, llmConfig }, `agent-${session.id}`);
    res.status(202).json({ session, mode: 'agent' });
  } catch (err) {
    next(err);
  }
});

// ── Dynamic :sessionId routes ─────────────────────────────────────────────

// GET /api/projects/:projectId/crawls/generation-status
crawlsRouter.get('/generation-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params;
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(getProjectGenerationStatus(projectId, project.slug));
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/crawls/generate-report - project-level report from all completed sessions
crawlsRouter.post('/generate-report', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params;
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const jobId = `project-report-${projectId}`;
    const existingJob = jobQueue.getJob(jobId);
    if (existingJob && (existingJob.status === 'waiting' || existingJob.status === 'active')) {
      return res.status(409).json({ error: 'Report generation is already running for this project' });
    }

    const completedSessions = await prisma.crawlSession.findMany({
      where: { projectId, status: 'completed' },
      orderBy: { createdAt: 'asc' },
    });
    if (completedSessions.length === 0) {
      return res.status(400).json({ error: 'No completed crawl sessions found for this project' });
    }

    const anchorSession = completedSessions[completedSessions.length - 1]!;
    const llmConfig: LLMConfig = {
      baseUrl: project.llmBaseUrl ?? undefined,
      apiKey: project.llmApiKey ?? undefined,
      model: project.llmModel ?? undefined,
    };

    await jobQueue.addJob('generate-report', {
      projectId,
      sessionId: anchorSession.id,
      sourceSessionIds: completedSessions.map((session) => session.id),
      projectSlug: project.slug,
      appName: project.name,
      llmConfig,
      resume: false,
    }, jobId);

    res.json({
      message: `Project report extraction started across ${completedSessions.length} completed session(s).`,
      jobId,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/crawls/resume-report
crawlsRouter.post('/resume-report', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params;
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const jobId = `project-report-${projectId}`;
    const existingJob = jobQueue.getJob(jobId);
    if (existingJob && (existingJob.status === 'waiting' || existingJob.status === 'active')) {
      return res.status(409).json({ error: 'Report generation is already running for this project' });
    }

    const checkpoint = readCheckpoint(project.slug);
    if (!checkpoint) {
      return res.status(400).json({ error: 'No generation checkpoint found to resume' });
    }
    if (checkpoint.status === 'completed') {
      return res.status(400).json({ error: 'Generation already completed — start a new extract to regenerate' });
    }

    const llmConfig: LLMConfig = {
      baseUrl: project.llmBaseUrl ?? undefined,
      apiKey: project.llmApiKey ?? undefined,
      model: project.llmModel ?? undefined,
    };

    await jobQueue.addJob('generate-report', {
      projectId,
      sessionId: checkpoint.sessionId,
      sourceSessionIds: checkpoint.sourceSessionIds,
      projectSlug: project.slug,
      appName: project.name,
      llmConfig,
      resume: true,
    }, jobId);

    res.json({
      message: `Resuming report generation from stage: ${checkpoint.currentStage ?? 'start'}`,
      jobId,
      resumeFrom: checkpoint.currentStage,
      completedStages: checkpoint.completedStages,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/crawls/:sessionId
crawlsRouter.get('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await prisma.crawlSession.findUnique({
      where: { id: req.params['sessionId'] },
      include: { _count: { select: { pages: true, networkCalls: true } } },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const job =
      jobQueue.getJob(`crawl-${req.params['sessionId']}`) ??
      jobQueue.getJob(`agent-${req.params['sessionId']}`) ??
      jobQueue.getJob(`collab-${req.params['sessionId']}`) ??
      jobQueue.getJob(`manual-${req.params['sessionId']}`) ??
      jobQueue.getJob(`report-${req.params['sessionId']}`) ??
      jobQueue.getJob(`project-report-${req.params['projectId']}`);
    res.json({ session, job: job ? { id: job.id, type: job.type, status: job.status, progress: job.progress } : null });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/crawls/:sessionId/logs
crawlsRouter.get('/:sessionId/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params['sessionId'];
    const afterId = Number.parseInt(String(req.query['afterId'] ?? '0'), 10) || 0;
    res.json({ logs: crawlLogBus.getLogs(sessionId, afterId) });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/crawls/:sessionId/stop
crawlsRouter.post('/:sessionId/stop', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params;

    // Cancel every crawl job id variant (BFS / agent / xpert)
    for (const jobId of [`crawl-${sessionId}`, `agent-${sessionId}`, `collab-${sessionId}`, `manual-${sessionId}`]) {
      await jobQueue.cancelJob(jobId).catch(() => undefined);
    }

    // Abort the running crawler so it exits loops and closes the browser
    crawlAbortRegistry.stop(sessionId, 'Stopped by user');
    emitCrawlLog(sessionId, 'warn', 'Stop requested — aborting crawl and closing browser');

    await prisma.crawlSession.update({
      where: { id: sessionId },
      data: { status: 'stopped', finishedAt: new Date(), errorMessage: 'Stopped by user' },
    }).catch(() => undefined);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/crawls/:sessionId/mark-complete
// Promote a failed/stopped session so analysis & reports treat it as completed.
crawlsRouter.post('/:sessionId/mark-complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId, sessionId } = req.params;

    const session = await prisma.crawlSession.findFirst({
      where: { id: sessionId, projectId },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (session.status === 'completed') {
      return res.json({ session });
    }

    if (session.status !== 'failed' && session.status !== 'stopped') {
      return res.status(409).json({
        error: `Only failed or stopped sessions can be marked complete (current: ${session.status})`,
      });
    }

    const pagesCount = await prisma.pageCapture.count({ where: { crawlSessionId: sessionId } });
    const updated = await prisma.crawlSession.update({
      where: { id: sessionId },
      data: {
        status: 'completed',
        finishedAt: session.finishedAt ?? new Date(),
        errorMessage: null,
        pagesCount,
      },
    });

    logger.info(`Crawl session marked complete: ${sessionId} (was ${session.status}, ${pagesCount} pages)`);
    emitCrawlLog(sessionId, 'info', `Session marked complete by user (was ${session.status})`);

    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:projectId/crawls/:sessionId — wipe session DB + disk. Requires confirmId === sessionId.
crawlsRouter.delete('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId, sessionId } = req.params;
    const confirmId = typeof req.body?.confirmId === 'string' ? req.body.confirmId.trim() : '';

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const session = await prisma.crawlSession.findFirst({
      where: { id: sessionId, projectId },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (!confirmId || confirmId !== session.id) {
      return res.status(400).json({
        error: 'Confirmation failed. Type the exact session ID to delete.',
      });
    }

    if (session.status === 'running' || session.status === 'awaiting_login') {
      return res.status(409).json({
        error: 'Stop the crawl before deleting this session.',
      });
    }

    for (const jobId of [`crawl-${sessionId}`, `agent-${sessionId}`, `collab-${sessionId}`, `manual-${sessionId}`, `report-${sessionId}`]) {
      await jobQueue.cancelJob(jobId).catch(() => undefined);
    }

    await prisma.report.deleteMany({ where: { crawlSessionId: sessionId } });
    await prisma.crawlSession.delete({ where: { id: sessionId } });

    const outputRoot = path.resolve(config.outputDir);
    const sessionDir = path.resolve(outputRoot, project.slug, sessionId);
    const deletedPaths: string[] = [];
    const rel = path.relative(outputRoot, sessionDir);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && removeDir(sessionDir)) {
      deletedPaths.push(sessionDir);
    }

    logger.info(`Crawl session deleted: ${sessionId} (project ${project.slug})`, { deletedPaths });
    res.json({ success: true, deletedPaths });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/crawls/:sessionId/analyze
crawlsRouter.post('/:sessionId/analyze', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId, sessionId } = req.params;
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const llmConfig: LLMConfig = {
      baseUrl: project.llmBaseUrl ?? undefined,
      apiKey: project.llmApiKey ?? undefined,
      model: project.llmModel ?? undefined,
    };

    await jobQueue.addJob('analyze', { projectId, sessionId, projectSlug: project.slug, llmConfig, appName: project.name });
    res.json({ message: 'AI analysis started in background.' });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/crawls/:sessionId/generate-report
crawlsRouter.post('/:sessionId/generate-report', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId, sessionId } = req.params;
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const jobId = `report-${sessionId}`;
    const existingJob = jobQueue.getJob(jobId);
    if (existingJob && (existingJob.status === 'waiting' || existingJob.status === 'active')) {
      return res.status(409).json({ error: 'Report generation is already running for this session' });
    }

    const llmConfig: LLMConfig = {
      baseUrl: project.llmBaseUrl ?? undefined,
      apiKey: project.llmApiKey ?? undefined,
      model: project.llmModel ?? undefined,
    };

    await jobQueue.addJob('generate-report', {
      projectId,
      sessionId,
      sourceSessionIds: [sessionId],
      projectSlug: project.slug,
      appName: project.name,
      llmConfig,
      resume: false,
    }, jobId);

    res.json({ message: 'Extract report workflow started in background.', jobId });
  } catch (err) {
    next(err);
  }
});

// Register job handlers
export function registerJobHandlers(): void {
  jobQueue.registerHandler<{ projectId: string; sessionId: string; projectSlug: string }>(
    'manual-crawl',
    async (job, updateProgress) => {
      const { projectId, sessionId, projectSlug } = job.data;
      const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      const session = await prisma.crawlSession.findUniqueOrThrow({ where: { id: sessionId } });
      const abortSignal = crawlAbortRegistry.begin(sessionId);
      emitCrawlLog(sessionId, 'info', 'Manual crawl browser started', { project: project.name });
      try {
        await runManualCrawl({
          project,
          session,
          projectSlug,
          abortSignal,
          onProgress: (info) => {
            // Manual sessions have no predetermined page count; keep active progress below completion.
            updateProgress(Math.min(90, info.capturedCount * 5));
            emitCrawlLog(sessionId, 'info', info.message, {
              capturedCount: info.capturedCount,
              currentUrl: info.currentUrl,
              status: info.status,
            });
          },
        });
        updateProgress(100);
        emitCrawlLog(sessionId, 'info', 'Manual crawl completed');
      } finally {
        crawlAbortRegistry.end(sessionId);
      }
    },
  );

  jobQueue.registerHandler<{ projectId: string; sessionId: string; projectSlug: string }>(
    'crawl',
    async (job, updateProgress) => {
      const { projectId, sessionId, projectSlug } = job.data;
      const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      const session = await prisma.crawlSession.findUniqueOrThrow({ where: { id: sessionId } });
      const abortSignal = crawlAbortRegistry.begin(sessionId);
      emitCrawlLog(sessionId, 'info', 'BFS crawl job started', { project: project.name });
      try {
        await runCrawl({
          project, session, projectSlug,
          abortSignal,
          onProgress: (info) => {
            updateProgress(Math.min(90, (info.visitedCount / (info.visitedCount + info.queuedCount + 1)) * 100));
            emitCrawlLog(sessionId, 'info', `${info.status}: ${info.currentUrl}`, {
              visitedCount: info.visitedCount,
              queuedCount: info.queuedCount,
            });
          },
        });
        updateProgress(100);
        emitCrawlLog(sessionId, 'info', 'BFS crawl completed');
      } finally {
        crawlAbortRegistry.end(sessionId);
      }
    },
  );

  jobQueue.registerHandler<{ projectId: string; sessionId: string; projectSlug: string; llmConfig: LLMConfig }>(
    'agent-crawl',
    async (job, updateProgress) => {
      const { projectId, sessionId, projectSlug, llmConfig } = job.data;
      const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      const session = await prisma.crawlSession.findUniqueOrThrow({ where: { id: sessionId } });
      const abortSignal = crawlAbortRegistry.begin(sessionId);
      emitCrawlLog(sessionId, 'info', 'AI agent crawl job started', { project: project.name });
      try {
        await runAgentCrawl({
          project, session, projectSlug, llmConfig,
          abortSignal,
          onProgress: (info) => {
            updateProgress(Math.min(90, info.step));
            emitCrawlLog(sessionId, 'info', `${info.action}: ${info.url}`, { step: info.step });
          },
        });
        updateProgress(100);
        emitCrawlLog(sessionId, 'info', 'AI agent crawl completed');
      } finally {
        crawlAbortRegistry.end(sessionId);
      }
    },
  );

  jobQueue.registerHandler<{ projectId: string; sessionId: string; projectSlug: string; llmConfig: LLMConfig }>(
    'collaborative-crawl',
    async (job, updateProgress) => {
      const { projectId, sessionId, projectSlug, llmConfig } = job.data;
      const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      const session = await prisma.crawlSession.findUniqueOrThrow({ where: { id: sessionId } });
      const abortSignal = crawlAbortRegistry.begin(sessionId);
      emitCrawlLog(sessionId, 'info', 'Collaborative crawl job started', { project: project.name });
      try {
        await runCollaborativeCrawl({
          project, session, projectSlug, llmConfig,
          abortSignal,
          onProgress: (info) => {
            const progress = Math.min(90, (info.visitedCount / Math.max(info.visitedCount + info.queuedCount, 1)) * 100);
            updateProgress(progress);
            logger.info(`[Collab] ${info.summary}`);
            emitCrawlLog(sessionId, 'info', info.summary, {
              visitedCount: info.visitedCount,
              queuedCount: info.queuedCount,
            });
          },
        });
        updateProgress(100);
        emitCrawlLog(sessionId, 'info', 'Collaborative crawl completed');
      } finally {
        crawlAbortRegistry.end(sessionId);
      }
    },
  );

  jobQueue.registerHandler<{
    projectId: string;
    sessionId: string;
    projectSlug: string;
    llmConfig: LLMConfig;
    appName: string;
  }>('analyze', async (job, updateProgress) => {
    const { sessionId, llmConfig, appName } = job.data;
    await analyzeSession(sessionId, llmConfig, appName);
    updateProgress(100);
  });

  jobQueue.registerHandler<{
    projectId: string;
    sessionId: string;
    sourceSessionIds?: string[];
    projectSlug: string;
    appName: string;
    llmConfig: LLMConfig;
    resume?: boolean;
  }>('generate-report', async (job, updateProgress) => {
    const { projectId, sessionId, projectSlug, appName, llmConfig, resume = false } = job.data;

    const allSessions = await prisma.crawlSession.findMany({
      where: { projectId, status: 'completed' },
      orderBy: { createdAt: 'asc' },
    });
    const sessionIds = allSessions.map((s) => s.id);
    const sourceSessionIds = job.data.sourceSessionIds?.length ? job.data.sourceSessionIds : sessionIds;
    logger.info(
      `${resume ? 'Resuming' : 'Generating'} report from ${sourceSessionIds.length} session(s): ${sourceSessionIds.join(', ')}`,
    );

    emitCrawlLog(sessionId, 'info', resume ? 'Resuming extract report workflow' : 'Extract report workflow started', {
      project: appName,
      resume,
    });

    await runReportGeneration({
      projectId,
      projectSlug,
      appName,
      sessionId,
      sourceSessionIds,
      llmConfig,
      resume,
      jobId: job.id,
      updateProgress,
    });

    emitCrawlLog(sessionId, 'info', 'Extract report workflow completed');
    logger.info(`Report generated. Covered ${sourceSessionIds.length} crawl session(s) for project ${projectId}`);
  });
}
