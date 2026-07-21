import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

export type JobStatus = 'waiting' | 'active' | 'completed' | 'failed';

export interface Job<T = unknown> {
  id: string;
  type: string;
  data: T;
  status: JobStatus;
  progress: number;
  result?: unknown;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

export type JobHandler<T = unknown> = (
  job: Job<T>,
  updateProgress: (progress: number) => void,
) => Promise<unknown>;

class SimpleJobQueue extends EventEmitter {
  private jobs = new Map<string, Job>();
  private handlers = new Map<string, JobHandler>();
  private activeCount = 0;
  private maxConcurrent = 2;
  private queue: string[] = [];

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = n;
  }

  registerHandler<T>(type: string, handler: JobHandler<T>): void {
    this.handlers.set(type, handler as JobHandler);
  }

  async addJob<T>(type: string, data: T, id?: string): Promise<Job<T>> {
    const jobId = id ?? `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job: Job<T> = {
      id: jobId,
      type,
      data,
      status: 'waiting',
      progress: 0,
      createdAt: new Date(),
    };
    this.jobs.set(jobId, job as Job);
    this.queue.push(jobId);
    this.emit('job:added', job);
    logger.info(`Job added: ${type} [${jobId}]`);
    setImmediate(() => this.processNext());
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  getAllJobs(): Job[] {
    return Array.from(this.jobs.values());
  }

  getActiveJobs(): Job[] {
    return this.getAllJobs().filter((j) => j.status === 'active');
  }

  async cancelJob(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.status === 'waiting') {
      this.queue = this.queue.filter((jid) => jid !== id);
      job.status = 'failed';
      job.error = 'Cancelled';
      job.finishedAt = new Date();
      this.emit('job:cancelled', job);
      return true;
    }

    // Active jobs cannot be yanked out of the handler; signal cancel and let
    // the runner abort + close the browser in its finally block.
    if (job.status === 'active') {
      job.error = 'Cancelled';
      this.emit('job:cancel-requested', job);
      return true;
    }

    return false;
  }

  private async processNext(): Promise<void> {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) return;

    const jobId = this.queue.shift();
    if (!jobId) return;

    const job = this.jobs.get(jobId);
    if (!job) return;

    const handler = this.handlers.get(job.type);
    if (!handler) {
      job.status = 'failed';
      job.error = `No handler registered for job type: ${job.type}`;
      job.finishedAt = new Date();
      logger.error(job.error);
      return;
    }

    job.status = 'active';
    job.startedAt = new Date();
    this.activeCount++;
    this.emit('job:started', job);
    logger.info(`Job started: ${job.type} [${job.id}]`);

    const updateProgress = (progress: number) => {
      job.progress = Math.min(100, Math.max(0, progress));
      this.emit('job:progress', job);
    };

    try {
      const result = await handler(job, updateProgress);
      job.status = 'completed';
      job.result = result;
      job.progress = 100;
      job.finishedAt = new Date();
      this.emit('job:completed', job);
      logger.info(`Job completed: ${job.type} [${job.id}]`);
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date();
      this.emit('job:failed', job);
      logger.error(`Job failed: ${job.type} [${job.id}]`, { error: job.error });
    } finally {
      this.activeCount--;
      setImmediate(() => this.processNext());
    }
  }
}

export const jobQueue = new SimpleJobQueue();
