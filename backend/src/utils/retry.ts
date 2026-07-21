import { logger } from './logger';

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoffFactor?: number;
  shouldRetry?: (error: unknown) => boolean;
}

const defaultOptions: Required<RetryOptions> = {
  maxAttempts: 3,
  delayMs: 1000,
  backoffFactor: 2,
  shouldRetry: () => true,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
  label?: string,
): Promise<T> {
  const opts = { ...defaultOptions, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!opts.shouldRetry(err) || attempt === opts.maxAttempts) {
        throw err;
      }

      const delay = opts.delayMs * Math.pow(opts.backoffFactor, attempt - 1);
      logger.warn(`Retry ${attempt}/${opts.maxAttempts} for "${label ?? 'operation'}" in ${delay}ms`, {
        error: err instanceof Error ? err.message : String(err),
      });

      await sleep(delay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('connection error') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('socket') ||
    msg.includes('fetch failed')
  );
}

/** True for rate-limits, timeouts, 5xx, and common transport failures. */
export function isTransientLlmError(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  const status =
    err && typeof err === 'object' && 'status' in err ? Number((err as { status?: number }).status) : undefined;
  if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate.?limit|ResourceExhausted|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket|503|502|500/i.test(
    msg,
  );
}

/**
 * Keep calling until success. Backs off on every failure (never gives up).
 * Use for synthesis / expert stages where the user wants the job to finish eventually.
 */
export async function retryUntilSuccess<T>(
  fn: () => Promise<T>,
  options: {
    label?: string;
    delayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
    /** If false, still retries but logs as non-transient. Default: retry everything. */
    shouldRetry?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  let attempt = 0;
  let delay = Math.max(1_000, options.delayMs ?? 8_000);
  const maxDelay = Math.max(delay, options.maxDelayMs ?? 180_000);
  const factor = options.backoffFactor ?? 1.6;
  const shouldRetry = options.shouldRetry ?? (() => true);

  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      if (!shouldRetry(err)) {
        throw err;
      }
      const wait = Math.min(delay, maxDelay);
      logger.warn(
        `Persistent retry #${attempt} for "${options.label ?? 'operation'}" in ${wait}ms` +
          (isTransientLlmError(err) ? ' (transient)' : ''),
        { error: err instanceof Error ? err.message : String(err) },
      );
      await sleep(wait);
      delay = Math.min(Math.round(delay * factor), maxDelay);
    }
  }
}
