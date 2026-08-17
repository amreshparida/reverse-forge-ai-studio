import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryUntilSuccess } from './retry';

describe('bounded persistent retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws after the configured attempt budget', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('still broken'));

    await expect(
      retryUntilSuccess(operation, { label: 'test operation', maxAttempts: 1 }),
    ).rejects.toThrow('Retry budget exhausted for "test operation" after 1 attempt');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('returns when a later bounded attempt succeeds', async () => {
    vi.useFakeTimers();
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce('ok');

    const resultPromise = retryUntilSuccess(operation, {
      maxAttempts: 2,
      delayMs: 1,
      maxDelayMs: 1,
    });
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
