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
  /** Pages BFS flagged for LLM deep-pass while still in-progress */
  private readonly pendingDeep = new Set<string>();
  private readonly pendingDeepDepth = new Map<string, number>();
  private readonly deepCompleted = new Set<string>();
  /** URLs the LLM agent has finished exploring (may overlap BFS visited). */
  private readonly llmExplored = new Set<string>();
  private readonly llmInProgress = new Set<string>();
  /** Post-login start URL reserved for the LLM window (BFS may claim the same URL separately). */
  private llmSeedUrl: string | null = null;

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
    this.llmSeedUrl = this.normalizeUrl(baseUrl);
    this.urlQueue.push({
      url: this.llmSeedUrl,
      depth: 0,
      needsDeep: false,
      addedBy: 'system',
    });
  }

  /** Stop both agents ASAP — clears queue and marks agents done. */
  abort(reason: string): void {
    if (this.aborted) return;
    this.aborted = true;
    this.abortReason = reason;
    this.urlQueue.length = 0;
    this.pendingDeep.clear();
    this.pendingDeepDepth.clear();
    this.llmInProgress.clear();
    this.bfsDone = true;
    this.llmDone = true;
    this.emit('aborted', reason);
    logger.warn(`[SharedState] Crawl aborted: ${reason}`);
  }

  /** Replace queue after login with the real post-login URL (normalized). */
  reseed(startUrl: string): void {
    this.urlQueue.length = 0;
    this.visitedUrls.clear();
    this.inProgressUrls.clear();
    this.pendingDeep.clear();
    this.pendingDeepDepth.clear();
    this.deepCompleted.clear();
    this.llmExplored.clear();
    this.llmInProgress.clear();
    const norm = this.normalizeUrl(startUrl);
    this.llmSeedUrl = norm;
    this.urlQueue.push({
      url: norm,
      depth: 0,
      needsDeep: false,
      addedBy: 'system',
    });
  }

  // ── URL Queue operations (atomic — no await between check and splice) ─

  /**
   * BFS and LLM run in separate Chromium windows — they may explore the same
   * start URL in parallel. LLM also re-visits BFS shell captures to open menus.
   */
  claimUrl(agentType: 'bfs' | 'llm'): QueueEntry | null {
    if (this.aborted) return null;
    const free = (u: QueueEntry) => !this.inProgressUrls.has(this.normalizeUrl(u.url));

    if (agentType === 'llm') {
      // Deep pages first, then URLs the LLM itself discovered.
      // Do NOT drain BFS's shell queue (addedBy bfs/system) — that left BFS at 1 page.
      const deepIdx = this.urlQueue.findIndex((u) => u.needsDeep && free(u) && !this.llmExplored.has(this.normalizeUrl(u.url)));
      if (deepIdx !== -1) {
        const item = this.urlQueue.splice(deepIdx, 1)[0]!;
        const norm = this.normalizeUrl(item.url);
        this.inProgressUrls.add(norm);
        this.llmInProgress.add(norm);
        return item;
      }
      const ownIdx = this.urlQueue.findIndex(
        (u) => u.addedBy === 'llm' && free(u) && !this.llmExplored.has(this.normalizeUrl(u.url)),
      );
      if (ownIdx !== -1) {
        const item = this.urlQueue.splice(ownIdx, 1)[0]!;
        const norm = this.normalizeUrl(item.url);
        this.inProgressUrls.add(norm);
        this.llmInProgress.add(norm);
        return item;
      }
      // Only take BFS leftovers after BFS has finished discovering
      if (this.bfsDone) {
        const anyIdx = this.urlQueue.findIndex(
          (u) => free(u) && !this.llmExplored.has(this.normalizeUrl(u.url)),
        );
        if (anyIdx !== -1) {
          const item = this.urlQueue.splice(anyIdx, 1)[0]!;
          const norm = this.normalizeUrl(item.url);
          this.inProgressUrls.add(norm);
          this.llmInProgress.add(norm);
          return item;
        }
      }

      // Dedicated seed: explore post-login URL in the LLM window even if BFS already claimed it
      if (
        this.llmSeedUrl &&
        !this.llmExplored.has(this.llmSeedUrl) &&
        !this.llmInProgress.has(this.llmSeedUrl)
      ) {
        this.llmInProgress.add(this.llmSeedUrl);
        // needsDeep=false → multi-step navigator (menus). true would only run tab deepExplore.
        return { url: this.llmSeedUrl, depth: 0, needsDeep: false, addedBy: 'system' };
      }

      // Re-visit BFS shell pages for menu/interaction discovery (separate window — safe)
      for (const [norm, knowledge] of this.pageKnowledge) {
        if (knowledge.capturedBy !== 'bfs') continue;
        if (this.llmExplored.has(norm) || this.llmInProgress.has(norm)) continue;
        this.llmInProgress.add(norm);
        return { url: norm, depth: 1, needsDeep: false, addedBy: 'bfs' };
      }
    } else {
      // BFS: shell-capture any non-deep URL, including ones the LLM discovered.
      // (Previously we skipped addedBy==='llm' until llmDone — that left BFS stuck at 1
      // page while the queue filled with Import/Configure routes the LLM had found.)
      const bfsIdx = this.urlQueue.findIndex((u) => !u.needsDeep && free(u));
      if (bfsIdx !== -1) {
        const item = this.urlQueue.splice(bfsIdx, 1)[0]!;
        this.inProgressUrls.add(this.normalizeUrl(item.url));
        return item;
      }
    }
    return null;
  }

  releaseUrl(url: string, success: boolean, agent: 'bfs' | 'llm' = 'bfs'): void {
    const norm = this.normalizeUrl(url);
    if (agent === 'llm') {
      this.llmInProgress.delete(norm);
      // Seed/follow-up claims are not always in the shared in-progress set
      this.inProgressUrls.delete(norm);
      if (success) {
        this.llmExplored.add(norm);
        this.visitedUrls.add(norm);
      }
      this.emit('url-released');
      return;
    }
    this.inProgressUrls.delete(norm);
    if (success) {
      this.visitedUrls.add(norm);
    }
    this.flushPendingDeep(norm);
    this.emit('url-released');
  }

  /** True when LLM still has seed or BFS-shell pages to explore. */
  hasPendingLlmWork(): boolean {
    if (
      this.llmSeedUrl &&
      !this.llmExplored.has(this.llmSeedUrl) &&
      !this.llmInProgress.has(this.llmSeedUrl)
    ) {
      return true;
    }
    for (const [norm, knowledge] of this.pageKnowledge) {
      if (
        knowledge.capturedBy === 'bfs' &&
        !this.llmExplored.has(norm) &&
        !this.llmInProgress.has(norm)
      ) {
        return true;
      }
    }
    return false;
  }

  markDeepCompleted(url: string): void {
    this.deepCompleted.add(this.normalizeUrl(url));
    this.stats.deepExploreHandled++;
  }

  /**
   * Add a URL to the queue if not already seen. Returns true if added.
   */
  addUrl(url: string, depth: number, needsDeep: boolean, addedBy: 'bfs' | 'llm'): boolean {
    const norm = this.normalizeUrl(url);
    if (
      this.visitedUrls.has(norm) ||
      this.inProgressUrls.has(norm) ||
      this.urlQueue.some((u) => this.normalizeUrl(u.url) === norm) ||
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
   * Mark a URL as needing deep LLM exploration (has real tabs, etc.)
   */
  flagForDeepExplore(url: string, depth: number): void {
    const norm = this.normalizeUrl(url);
    if (this.deepCompleted.has(norm)) return;

    const existing = this.urlQueue.find((u) => this.normalizeUrl(u.url) === norm);
    if (existing) {
      existing.needsDeep = true;
      this.emit('deep-flagged', norm);
      return;
    }
    if (this.inProgressUrls.has(norm)) {
      this.pendingDeep.add(norm);
      this.pendingDeepDepth.set(norm, depth);
      this.emit('deep-flagged', norm);
      return;
    }
    // Shell already visited — still allow a deep-only LLM pass
    if (this.visitedUrls.has(norm)) {
      this.urlQueue.push({ url: norm, depth, needsDeep: true, addedBy: 'bfs' });
      this.emit('deep-flagged', norm);
      return;
    }
    this.addUrl(norm, depth, true, 'bfs');
    this.emit('deep-flagged', norm);
  }

  /** After BFS releases a page, enqueue any pending deep LLM pass. */
  flushPendingDeep(url: string): void {
    const norm = this.normalizeUrl(url);
    if (!this.pendingDeep.has(norm) || this.deepCompleted.has(norm)) return;
    this.pendingDeep.delete(norm);
    const depth = this.pendingDeepDepth.get(norm) ?? 0;
    this.pendingDeepDepth.delete(norm);
    if (this.urlQueue.some((u) => this.normalizeUrl(u.url) === norm && u.needsDeep)) return;
    if (this.inProgressUrls.has(norm)) return;
    this.urlQueue.push({ url: norm, depth, needsDeep: true, addedBy: 'bfs' });
    logger.debug(`[SharedState] Queued pending deep explore: ${norm}`);
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
      this.pendingDeep.size === 0 &&
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

  /**
   * Normalize for dedupe while KEEPING SPA hash routes (#/Module/...).
   * Stripping the hash was collapsing Essential Cloud (and similar) into one URL
   * and emptying the collab queue after a handful of real /path links.
   */
  normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const p = parsed.pathname.replace(/\/$/, '') || '/';
      let result = `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}${p}`;
      if (parsed.search) result += parsed.search;
      const hash = parsed.hash || '';
      if (hash && hash !== '#' && hash.length > 1) {
        // Keep #/route — drop trailing slash inside hash path
        const cleaned = hash.replace(/\/$/, '') || hash;
        result += cleaned;
      }
      return result;
    } catch {
      return url;
    }
  }

  private isUrlAllowed(url: string): boolean {
    try {
      if (isSessionEndingUrl(url)) return false;
      return isUrlSafe(url, this.allowedDomains, this.excludedUrls);
    } catch {
      return false;
    }
  }
}
