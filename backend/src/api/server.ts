import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { connectDatabase } from '../database/client';
import { logger } from '../utils/logger';
import { projectsRouter } from './routes/projects';
import { crawlsRouter, registerJobHandlers } from './routes/crawls';
import { pagesRouter } from './routes/pages';
import { analysisRouter } from './routes/analysis';
import { reportsRouter } from './routes/reports';
import { jobQueue } from '../queue/job-queue';
import { ensureDir } from '../utils/file-system';
import { crawlLogBus } from '../crawler/live-log';
import { generationProgressBus } from '../generators/progress-bus';
import { reconcileStaleCheckpoints } from '../generators/checkpoint';
import { prisma } from '../database/client';
import { timingSafeEqual } from 'crypto';

const app = express();

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// ── Security middleware ──────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow static screenshots
    contentSecurityPolicy: false, // relaxed for local tool
  }),
);

// Optional deployment authentication. Local-only binding remains the safe default.
app.use(['/api', '/static'], (req, res, next) => {
  const expected = config.security.apiAuthToken;
  if (!expected || req.originalUrl.startsWith('/api/health')) return next();
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const apiKey = req.header('x-api-key');
  if (tokenMatches(bearer, expected) || tokenMatches(apiKey, expected)) return next();
  res.status(401).json({ error: 'Authentication required' });
});

app.use(
  cors({
    origin: ['http://localhost:5173', 'http://localhost:3000'],
    credentials: true,
  }),
);

// ── Rate limiting ──────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// ── Body parsing ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Static file serving for screenshots ───────────────────────────────────
const outputDir = path.resolve(process.cwd(), config.outputDir);
ensureDir(outputDir);
app.use('/static', express.static(outputDir));

// ── API Routes ────────────────────────────────────────────────────────────
app.use('/api/projects', projectsRouter);
app.use('/api/projects/:projectId/crawls', crawlsRouter);
app.use('/api/projects/:projectId/crawls/:sessionId/pages', pagesRouter);
app.use('/api/projects/:projectId/analysis', analysisRouter);
app.use('/api/projects/:projectId/reports', reportsRouter);

// ── SSE endpoint for real-time job progress ───────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const handlers: Array<[string, (...args: unknown[]) => void]> = [
    ['job:added', (job) => sendEvent('job', job)],
    ['job:started', (job) => sendEvent('job', job)],
    ['job:progress', (job) => sendEvent('job', job)],
    ['job:completed', (job) => sendEvent('job', job)],
    ['job:failed', (job) => sendEvent('job', job)],
    ['job:cancelled', (job) => sendEvent('job', job)],
    ['crawl:log', (entry) => sendEvent('crawl-log', entry)],
    ['generation:progress', (entry) => sendEvent('generation', entry)],
  ];

  for (const [event, handler] of handlers) {
    if (event === 'crawl:log') crawlLogBus.on(event, handler);
    else if (event === 'generation:progress') generationProgressBus.on(event, handler);
    else jobQueue.on(event, handler);
  }

  // Heartbeat
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    for (const [event, handler] of handlers) {
      if (event === 'crawl:log') crawlLogBus.off(event, handler);
      else if (event === 'generation:progress') generationProgressBus.off(event, handler);
      else jobQueue.off(event, handler);
    }
  });
});

// ── Health check ─────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

// ── Serve React frontend in production ───────────────────────────────────
// When running from backend/, frontend/dist is one level up
const frontendDist = path.resolve(__dirname, '../../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// ── Global error handler ──────────────────────────────────────────────────
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof Error) {
    // Zod validation errors
    if ('issues' in err) {
      return res.status(400).json({ error: 'Validation error', details: (err as { issues: unknown }).issues });
    }
    logger.error('Unhandled error', { message: err.message, stack: err.stack });
    return res.status(500).json({
      error: config.nodeEnv === 'production' ? 'Internal server error' : err.message,
    });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ───────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  await connectDatabase();
  registerJobHandlers();
  jobQueue.setMaxConcurrent(config.crawler.maxConcurrency);

  ensureDir(config.outputDir);
  ensureDir(config.sessionDir);

  // Any generation left "running" after a crash becomes paused so the UI can offer Resume
  try {
    const projects = await prisma.project.findMany({ select: { slug: true } });
    for (const project of projects) {
      reconcileStaleCheckpoints(project.slug);
    }
  } catch (err) {
    logger.warn('Failed to reconcile generation checkpoints: ' + (err instanceof Error ? err.message : String(err)));
  }

  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.security.apiAuthToken) {
    throw new Error('API_AUTH_TOKEN is required when HOST is not loopback');
  }

  app.listen(config.port, config.host, () => {
    logger.info(`🚀 ReverseForge AI Studio running on http://${config.host}:${config.port}`);
    logger.info(`   API: http://${config.host}:${config.port}/api`);
    logger.info(`   Docs: http://${config.host}:${config.port}/api/health`);
  });
}

start().catch((err) => {
  logger.error('Failed to start server', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

export default app;
