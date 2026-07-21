import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/client';
import { jobQueue } from '../../queue/job-queue';

export const analysisRouter = Router({ mergeParams: true });

// GET /api/projects/:projectId/analysis/entities
analysisRouter.get('/entities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params;
    const entities = await prisma.entityModel.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });

    const parsed = entities.map((e) => ({
      ...e,
      fields: JSON.parse(e.fields),
      relationships: JSON.parse(e.relationships),
    }));

    res.json({ entities: parsed });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/analysis/workflows
analysisRouter.get('/workflows', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params;
    const workflows = await prisma.workflowModel.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });

    const parsed = workflows.map((w) => ({
      ...w,
      states: JSON.parse(w.states),
      transitions: JSON.parse(w.transitions),
      actors: w.actors ? JSON.parse(w.actors) : [],
    }));

    res.json({ workflows: parsed });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/analysis/network
analysisRouter.get('/network', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params;
    const { sessionId } = req.query;

    const where = sessionId
      ? { crawlSessionId: String(sessionId) }
      : {
          crawlSession: { projectId },
        };

    const page = parseInt(req.query['page'] as string ?? '1', 10);
    const limit = Math.min(parseInt(req.query['limit'] as string ?? '50', 10), 200);

    const [calls, total] = await Promise.all([
      prisma.networkCall.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          method: true,
          url: true,
          responseStatus: true,
          timingMs: true,
          resourceType: true,
          queryParams: true,
          requestPayload: true,
          requestContentType: true,
          responseBody: true,
          responseContentType: true,
          responseSchemaKeys: true,
          requestHeaders: true,
          responseHeaders: true,
          isGraphQL: true,
          graphQLOperationName: true,
          createdAt: true,
          pageCapture: { select: { url: true, title: true } },
        },
      }),
      prisma.networkCall.count({ where }),
    ]);

    res.json({ calls, total, page, limit });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/analysis/jobs
analysisRouter.get('/jobs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const jobs = jobQueue.getAllJobs().slice(-50);
    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});
