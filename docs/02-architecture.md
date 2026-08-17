# 02 — Architecture

## Repository Structure

```
reverse-engineering-ai/
├── backend/                    # Node.js API server
│   ├── src/
│   │   ├── api/                # Express routes
│   │   │   └── routes/         # projects, crawls, pages, analysis, reports
│   │   ├── agent/              # Agentic crawl system
│   │   │   ├── types.ts        # AgentAction, PageState, AgentMemory
│   │   │   ├── observer.ts     # Page state capture (TypeScript wrapper)
│   │   │   ├── browser-observe.js  # Browser-side observe script (plain JS)
│   │   │   ├── browser-overlay.js  # Element overlay rendering (plain JS)
│   │   │   ├── navigator.ts    # LLM prompt builders
│   │   │   ├── action-builder.ts   # Playwright action executor
│   │   │   ├── overlay.ts      # Overlay injection/removal
│   │   │   ├── runner.ts       # Agentic crawl orchestrator
│   │   │   ├── shared-state.ts # Collaborative crawl shared memory
│   │   │   └── multi-agent-runner.ts  # Xpert Crawler orchestrator
│   │   ├── ai/                 # LLM integration
│   │   │   ├── llm.ts          # OpenAI SDK client abstraction
│   │   │   ├── prompts.ts      # All LLM prompt templates
│   │   │   └── analyzer.ts     # Analysis orchestration
│   │   ├── crawler/            # BFS crawl system
│   │   │   ├── index.ts        # Main BFS crawl loop
│   │   │   ├── safety.ts       # Safety rules and URL/text filters
│   │   │   └── session.ts      # Login session management
│   │   ├── extractor/          # Page data extraction
│   │   │   ├── types.ts        # ComprehensivePageData type definitions
│   │   │   ├── index.ts        # Entry point (delegates to deep.ts)
│   │   │   ├── deep.ts         # Deep extractor (TypeScript wrapper)
│   │   │   ├── browser-extract.js  # Browser-side extraction (plain JS)
│   │   │   ├── js-intel.js     # JS intelligence extraction (plain JS)
│   │   │   ├── js-intelligence.ts  # JS intel TypeScript wrapper
│   │   │   └── advanced-capture.ts # GraphQL, OpenAPI, source maps, etc.
│   │   ├── generators/         # Report generation
│   │   │   ├── report.ts       # Markdown + PDF report generator
│   │   │   └── checkpoint.ts   # Resumable generation stages (see also generation-runner)
│   │   ├── inference/          # AI-powered inference
│   │   │   ├── entity.ts       # Entity model inference
│   │   │   ├── workflow.ts     # Workflow state machine inference
│   │   │   └── permissions.ts  # Permission matrix inference
│   │   ├── recorder/           # Network call recording
│   │   │   └── index.ts        # XHR/fetch/WebSocket + per-page HAR 1.2
│   │   ├── queue/              # Job queue
│   │   │   └── job-queue.ts    # In-memory job queue with SSE events
│   │   ├── database/           # Prisma client
│   │   │   └── client.ts
│   │   ├── utils/              # Shared utilities
│   │   │   ├── logger.ts       # Winston logger
│   │   │   ├── mask.ts         # Secret/PII masking
│   │   │   ├── retry.ts        # Retry with backoff
│   │   │   └── file-system.ts  # Output directory helpers
│   │   ├── cli/                # CLI entry point
│   │   │   └── index.ts
│   │   └── config.ts           # Central configuration
│   ├── prisma/
│   │   └── schema.prisma       # Database schema
│   ├── project-output/         # Runtime: captured data (gitignored)
│   ├── sessions/               # Runtime: browser session files (gitignored)
│   └── logs/                   # Runtime: log files (gitignored)
│
├── frontend/                   # React + Vite dashboard
│   └── src/
│       ├── pages/              # Route-level components
│       ├── components/         # Shared components
│       ├── api/                # API client
│       └── types/              # TypeScript interfaces
│
└── docs/                       # This directory
```

---

## Data Flow

### BFS Crawl

```
User starts crawl
    │
    ▼
[Login Flow]                         (if loginRequired=true)
  waitForLoginAndSaveSession()
  → headless=false browser opens
  → user logs in manually
  → Done button captures postLoginUrl
  → session.json saved
    │
    ▼
[BFS Crawl Loop]                     (crawler/index.ts)
  crawlPage = existing post-login page
  queue = [{ url: postLoginUrl }]
    │
    ├─ for each URL in queue:
    │   ├─ isUrlSafe() check
    │   ├─ Skip goto if already there (post-login case)
    │   ├─ observePage() → inject overlay → screenshot (viewport)
    │   ├─ Remove overlay → screenshot (full-page)
    │   ├─ extractPageData() → browser-extract.js
    │   ├─ extractJsIntelligence() → js-intel.js
    │   ├─ Advanced captures: source maps, IndexedDB, mobile viewport
    │   ├─ networkRecorder.getCalls() → save to DB + api/*-api.json
    │   ├─ networkRecorder.getHar() → save har/*.har (HAR 1.2 waterfall)
    │   └─ discoverLinks() → add new URLs to queue
    │
    └─ Session-level: OpenAPI probe, GraphQL introspection,
                      WebSocket captures, cookie structure
```

### Agentic Crawl

```
[Login Flow]  (same as BFS)
    │
    ▼
[Agent Loop]                          (agent/runner.ts)
  page = post-login page (already there)
    │
    ├─ for each step (max 150):
    │   ├─ observePage() → numbered element list
    │   ├─ LLM Navigator call → AgentAction JSON
    │   ├─ validateAction() → safety check
    │   ├─ executeAction() → Playwright click/navigate/scroll
    │   │   └─ Pre-click: check text + href against logout patterns
    │   ├─ Capture page if new URL
    │   └─ every 15 steps: Planner LLM → coverage estimate
    │
    └─ Stops when: coverage ≥ 90% OR no unvisited navigation items
```

### Xpert Crawl (Collaborative)

```
[Login Flow]  (same — postLoginUrl captured)
    │
    ▼
[SharedCrawlState]                    (agent/shared-state.ts)
  urlQueue seeded with postLoginUrl
    │
    ├── Tab 1: BFS Agent               (agent/multi-agent-runner.ts)
    │   → claimUrl('bfs') → prefers non-deep URLs
    │   → marks tabs/accordions as needsDeep=true
    │   → discovers links → addUrl() to shared queue
    │
    └── Tab 2: LLM Agent               (agent/multi-agent-runner.ts)
        → claimUrl('llm') → prefers needsDeep=true URLs
        → clicks through tabs/panels
        → discovers hidden URLs → adds to shared queue
        │
Both agents read/write to SharedCrawlState concurrently.
Node.js single-thread ensures queue operations are atomic.
```

---

## Database Schema (SQLite / PostgreSQL)

```
Project
  └── CrawlSession[]
        ├── PageCapture[]
        │     └── NetworkCall[]
        ├── EntityModel[]
        ├── WorkflowModel[]
        └── Report[]
```

Key design decisions:
- `PageCapture.extractedData` — full JSON blob of all extracted UI elements
- `PageCapture.aiAnalysis` — LLM analysis result per page
- `NetworkCall.responseSchemaKeys` — top-level JSON field names from API responses
- All sensitive fields masked before storage (`maskBody`, `maskHeaders`)

---

## Browser Script Architecture

Browser-side code that runs inside `page.evaluate()` is written as **plain JavaScript** (not TypeScript) to avoid esbuild's `__name` helper functions being injected at module scope. These helpers are defined outside the function body and are unavailable when Playwright serializes the function for browser execution.

| File | Purpose |
|---|---|
| `browser-extract.js` | Full deep page extraction (forms, tables, nav, etc.) |
| `browser-observe.js` | Compact page state for LLM agent navigation |
| `browser-overlay.js` | Colored numbered bounding boxes on elements |
| `js-intel.js` | Window globals, component trees, store shape, routes |

---

## Real-time Communication

Job progress is streamed to the frontend via **Server-Sent Events** (`GET /api/events`). The in-memory job queue emits events on `job:added`, `job:started`, `job:progress`, `job:completed`, `job:failed`.

The frontend subscribes once at Layout level and updates a floating progress bar without polling.
