import { EventEmitter } from 'events';

export type CrawlLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CrawlLogEntry {
  id: number;
  sessionId: string;
  level: CrawlLogLevel;
  message: string;
  timestamp: string;
  meta?: Record<string, unknown>;
}

const MAX_LOGS_PER_SESSION = 500;
let nextId = 1;

class CrawlLogBus extends EventEmitter {
  private readonly logsBySession = new Map<string, CrawlLogEntry[]>();

  emitLog(sessionId: string, level: CrawlLogLevel, message: string, meta?: Record<string, unknown>): CrawlLogEntry {
    const entry: CrawlLogEntry = {
      id: nextId++,
      sessionId,
      level,
      message,
      timestamp: new Date().toISOString(),
      meta,
    };

    const logs = this.logsBySession.get(sessionId) ?? [];
    logs.push(entry);
    if (logs.length > MAX_LOGS_PER_SESSION) logs.splice(0, logs.length - MAX_LOGS_PER_SESSION);
    this.logsBySession.set(sessionId, logs);
    this.emit('crawl:log', entry);
    return entry;
  }

  getLogs(sessionId: string, afterId = 0): CrawlLogEntry[] {
    return (this.logsBySession.get(sessionId) ?? []).filter((entry) => entry.id > afterId);
  }
}

export const crawlLogBus = new CrawlLogBus();

export function emitCrawlLog(
  sessionId: string,
  level: CrawlLogLevel,
  message: string,
  meta?: Record<string, unknown>,
): CrawlLogEntry {
  return crawlLogBus.emitLog(sessionId, level, message, meta);
}
