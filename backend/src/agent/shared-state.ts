import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { isSessionEndingUrl, isUrlSafe } from '../crawler/safety';

export interface QueueEntry {
  url: string;
  depth: number;
  /** True = has tabs/accordions/dynamic content → LLM agent should handle */
  needsDeep: boolean;
  /** Which agent added this */
  addedBy: 'bfs' | 'llm' | 'system';
}

export interface PageKnowledge {
  title: string;
  pageType: string;
  formCount: number;
  tableCount: number;
  tabCount: number;
  hasModal: boolean;
  features: string[];
  capturedBy: 'bfs' | 'llm';
}

export interface CollaborativeStats {
  bfsPages: number;
  llmPages: number;
  networkCalls: number;
  startedAt: Date;
  deepExploreHandled: number;
  urlsAddedByLLM: number;   // pages BFS would have missed
  urlsAddedByBFS: number;
}

/**
 * Shared mutable state that both the BFS crawler and LLM navigator
 * read from and write to concurrently.
 *
 * Node.js is single-threaded — all queue operations are atomic at the
 * JS level as long as we don't `await` between check-and-modify steps.
 */
export class SharedCrawlState extends EventEmitter {
  // ── URL Management ────────────────────────────────────────────────────
  readonly urlQueue: QueueEntry[] = [];
  readonly visitedUrls = new Set<string>();
  readonly inProgressUrls = new Set<string>();

  // ── Knowledge base ────────────────────────────────────────────────────
  readonly pageKnowledge = new Map<string, PageKnowledge>();
  readonly discoveredFeatures = new Set<string>();
  readonly discoveredEntities = new Set<string>();
  readonly discoveredModules = new Set<string>();

  // ── Coordination signals ──────────────────────────────────────────────
  bfsDone = false;
  llmDone = false;
  /** Set when crawl must stop early (e.g. browser closed by user) */
  aborted = false;
  abortReason: string | null = null;

  // ── Stats ─────────────────────────────────────────────────────────────
  readonly stats: CollaborativeStats = {
    bfsPages: 0,
    llmPages: 0,
    networkCalls: 0,
    startedAt: new Date(),
    deepExploreHandled: 0,
    urlsAddedByLLM: 0,
    urlsAddedByBFS: 0,
  };

  constructor(
    private readonly baseUrl: string,
    private readonly maxDepth: number,
    private readonly allowedDomains: string[],
    private readonly excludedUrls: string[],
  ) {
    super();
    // Seed the queue with the base URL
    this.urlQueue.push({ url: baseUrl, depth: 0, needsDeep: false, addedBy: 'system' });
  }

  /** Stop both agents ASAP — clears queue and marks agents done. */
  abort(reason: string): void {
    if (this.aborted) return;
    this.aborted = true;
    this.abortReason = reason;
    this.urlQueue.length = 0;
    this.bfsDone = true;
    this.llmDone = true;
    this.emit('aborted', reason);
    logger.warn(`[SharedState] Crawl aborted: ${reason}`);
  }

  // ── URL Queue operations (atomic — no await between check and splice) ─

  /**
   * BFS agent prefers non-deep URLs.
   * LLM agent prefers deep URLs; falls back to any URL if no deep ones exist.
   */
  claimUrl(agentType: 'bfs' | 'llm'): QueueEntry | null {
    if (this.aborted) return null;
    if (agentType === 'llm') {
      // Prefer deep-explore pages
      const deepIdx = this.urlQueue.findIndex(
        (u) => u.needsDeep && !this.inProgressUrls.has(u.url),
      );
      if (deepIdx !== -1) {
        const item = this.urlQueue.splice(deepIdx, 1)[0]!;
        this.inProgressUrls.add(item.url);
        return item;
      }
      // Fall back to any available URL when deep queue is empty
      const anyIdx = this.urlQueue.findIndex((u) => !this.inProgressUrls.has(u.url));
      if (anyIdx !== -1) {
        const item = this.urlQueue.splice(anyIdx, 1)[0]!;
        this.inProgressUrls.add(item.url);
        return item;
      }
    } else {
      // BFS prefers regular (non-deep) URLs
      const regularIdx = this.urlQueue.findIndex(
        (u) => !u.needsDeep && !this.inProgressUrls.has(u.url),
      );
      if (regularIdx !== -1) {
        const item = this.urlQueue.splice(regularIdx, 1)[0]!;
        this.inProgressUrls.add(item.url);
        return item;
      }
      // Fall back to deep URLs if no regular ones
      const anyIdx = this.urlQueue.findIndex((u) => !this.inProgressUrls.has(u.url));
      if (anyIdx !== -1) {
        const item = this.urlQueue.splice(anyIdx, 1)[0]!;
        this.inProgressUrls.add(item.url);
        return item;
      }
    }
    return null;
  }

  releaseUrl(url: string, success: boolean): void {
    this.inProgressUrls.delete(url);
    if (success) {
      this.visitedUrls.add(url);
    }
    this.emit('url-released');
  }

  /**
   * Add a URL to the queue if not already seen. Returns true if added.
   */
  addUrl(url: string, depth: number, needsDeep: boolean, addedBy: 'bfs' | 'llm'): boolean {
    const norm = this.normalizeUrl(url);
    if (
      this.visitedUrls.has(norm) ||
      this.inProgressUrls.has(norm) ||
      this.urlQueue.some((u) => u.url === norm) ||
      !this.isUrlAllowed(norm) ||
      depth > this.maxDepth
    ) {
      return false;
    }

    this.urlQueue.push({ url: norm, depth, needsDeep, addedBy });

    if (addedBy === 'llm') this.stats.urlsAddedByLLM++;
    else this.stats.urlsAddedByBFS++;

    this.emit('url-added', norm);
    return true;
  }

  /**
   * Mark a URL as needing deep LLM exploration (has tabs, accordions, etc.)
   */
  flagForDeepExplore(url: string, depth: number): void {
    const norm = this.normalizeUrl(url);
    if (this.visitedUrls.has(norm) || this.inProgressUrls.has(norm)) return;
    // If already in queue, upgrade it
    const existing = this.urlQueue.find((u) => u.url === norm);
    if (existing) {
      existing.needsDeep = true;
    } else {
      this.addUrl(norm, depth, true, 'bfs');
    }
    this.emit('deep-flagged', norm);
  }

  // ── Knowledge base operations ─────────────────────────────────────────

  recordPage(url: string, knowledge: PageKnowledge, networkCallCount: number): void {
    const norm = this.normalizeUrl(url);
    this.pageKnowledge.set(norm, knowledge);

    if (knowledge.features.length > 0) {
      knowledge.features.forEach((f) => this.discoveredFeatures.add(f));
    }

    this.stats.networkCalls += networkCallCount;

    if (knowledge.capturedBy === 'bfs') this.stats.bfsPages++;
    else {
      this.stats.llmPages++;
      if (knowledge.tabCount > 0) this.stats.deepExploreHandled++;
    }

    logger.debug(
      `[SharedState] ${knowledge.capturedBy.toUpperCase()} captured: ${knowledge.title || url} ` +
      `(forms:${knowledge.formCount} tables:${knowledge.tableCount} tabs:${knowledge.tabCount})`,
    );
  }

  recordEntity(entity: string): void { this.discoveredEntities.add(entity); }
  recordModule(module: string): void { this.discoveredModules.add(module); }

  // ── Status ────────────────────────────────────────────────────────────

  get isDone(): boolean {
    return (
      this.urlQueue.length === 0 &&
      this.inProgressUrls.size === 0 &&
      (this.bfsDone || this.llmDone)
    );
  }

  get totalPagesVisited(): number {
    return this.visitedUrls.size;
  }

  getSummary(): string {
    const elapsed = Math.round((Date.now() - this.stats.startedAt.getTime()) / 1000);
    return (
      `Pages: ${this.visitedUrls.size} (BFS:${this.stats.bfsPages} LLM:${this.stats.llmPages}) | ` +
      `Queue: ${this.urlQueue.length} | Deep: ${this.stats.deepExploreHandled} | ` +
      `LLM-discovered: ${this.stats.urlsAddedByLLM} | Network: ${this.stats.networkCalls} | ${elapsed}s`
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const p = parsed.pathname.replace(/\/$/, '') || '/';
      return `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}${p}${parsed.search}`;
    } catch {
      return url;
    }
  }

  private isUrlAllowed(url: string): boolean {
    try {
      if (isSessionEndingUrl(url)) return false;
      // Reuse the same domain/excluded/unsafe checks as standalone BFS
      return isUrlSafe(url, this.allowedDomains, this.excludedUrls);
    } catch {
      return false;
    }
  }
}
