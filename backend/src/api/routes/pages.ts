import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/client';

export const pagesRouter = Router({ mergeParams: true });

// GET /api/projects/:projectId/crawls/:sessionId/pages
pagesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params;
    const page = parseInt(req.query['page'] as string ?? '1', 10);
    const limit = Math.min(parseInt(req.query['limit'] as string ?? '50', 10), 100);
    const skip = (page - 1) * limit;

    const [pages, total] = await Promise.all([
      prisma.pageCapture.findMany({
        where: { crawlSessionId: sessionId },
        orderBy: { depth: 'asc' },
        skip,
        take: limit,
        select: {
          id: true,
          url: true,
          title: true,
          depth: true,
          screenshotPath: true,
          loadTimeMs: true,
          createdAt: true,
          aiAnalysis: true,
          breadcrumbs: true,
          _count: { select: { networkCalls: true } },
        },
      }),
      prisma.pageCapture.count({ where: { crawlSessionId: sessionId } }),
    ]);

    res.json({ pages, total, page, limit });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/crawls/:sessionId/pages/:pageId
pagesRouter.get('/:pageId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pageCapture = await prisma.pageCapture.findUnique({
      where: { id: req.params['pageId'] },
      include: {
        networkCalls: {
          take: 50,
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            method: true,
            url: true,
            responseStatus: true,
            timingMs: true,
            resourceType: true,
          },
        },
      },
    });
    if (!pageCapture) return res.status(404).json({ error: 'Page not found' });

    // Parse JSON fields
    const result = {
      ...pageCapture,
      extractedData: pageCapture.extractedData ? JSON.parse(pageCapture.extractedData) : null,
      aiAnalysis: pageCapture.aiAnalysis ? JSON.parse(pageCapture.aiAnalysis) : null,
      breadcrumbs: pageCapture.breadcrumbs ? JSON.parse(pageCapture.breadcrumbs) : [],
    };

    res.json({ page: result });
  } catch (err) {
    next(err);
  }
});
