/**
 * Detect Playwright errors that mean the browser/page/context is gone.
 * When this happens the crawl cannot continue and should stop immediately.
 */
export function isBrowserClosedError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('target page, context or browser has been closed') ||
    msg.includes('browser has been closed') ||
    msg.includes('context has been closed') ||
    msg.includes('page has been closed') ||
    msg.includes('target closed') ||
    msg.includes('browser closed') ||
    (msg.includes('protocol error') && msg.includes('session closed')) ||
    msg.includes('connection closed')
  );
}

export function browserClosedMessage(err?: unknown): string {
  const detail = err instanceof Error ? err.message : err ? String(err) : '';
  return detail
    ? `Browser/page was closed — crawl stopped. (${detail.slice(0, 200)})`
    : 'Browser/page was closed — crawl stopped.';
}
