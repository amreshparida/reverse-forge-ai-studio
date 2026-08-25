# Essential Cloud — Project Output & Sessions Structure

Deep dive into how Reverse Forge stores crawl, upload, analysis, and report artifacts for **Essential Cloud**.

| | |
|---|---|
| **App name** | Essential Cloud |
| **Project slug** | `essential-cloud-1787255177369` |
| **Project ID** | `88ad2317-e791-42a7-8f78-c88772e37b4e` |
| **Target site** | `https://eag.essentialintelligence.com` |
| **Crawl / session runs** | 27 UUID folders under `project-output` |
| **Browser auth session** | `backend/sessions/essential-cloud-1787255177369/session.json` |
| **Report generation status** | Completed (`generation-checkpoint.json`) |
| **Primary report session** | `e9c7f73a-fd58-4d7e-8759-56416e6d6f3f` |
| **SQLite database** | `backend/prisma/dev.db` (~882 MB) |
| **Prisma schema** | `backend/prisma/schema.prisma` |

Paths are relative to the repo root unless noted. On disk they live under `backend/` (see `backend/src/config.ts`: `OUTPUT_DIR` → `project-output`, `SESSION_DIR` → `sessions`; `DATABASE_URL=file:./dev.db` resolves under `backend/prisma/`).

---

## Big picture

```
backend/
├── prisma/
│   ├── schema.prisma                             # Data models (source of truth)
│   └── dev.db                                    # SQLite DB — projects, sessions, pages, APIs, graph, findings
│
├── sessions/
│   └── essential-cloud-1787255177369/
│       └── session.json                          # Playwright storage state (cookies + localStorage)
│
└── project-output/
    └── essential-cloud-1787255177369/            # One folder per project
        ├── generation-checkpoint.json            # Cross-run report pipeline status
        └── <session-uuid>/                       # One folder per crawl / upload / agent run
            ├── screenshots/                      # PNG captures (desktop + mobile_*)
            ├── html/                             # Raw page HTML
            ├── pages/                            # Structured page JSON + JS intel
            ├── api/                              # Captured API / XHR summaries
            ├── har/                              # Full HAR network traces
            ├── analysis/                         # OCR + agent rolling context
            ├── uploaded-evidence/                # User ZIP/file imports (any shape)
            ├── knowledge-base/                   # Indexed KB package (when detected)
            ├── reports/                          # Synthesis / expert / final report artifacts
            ├── _zip-import/                      # Temp unzip staging during evidence import
            └── upload-manifest.json              # Manifest of what was uploaded
```

**Mental model**

1. **`prisma/dev.db`** — structured index of everything (projects, crawl sessions, page/API rows, entity/workflow models, analysis graph, findings, report pointers). UUIDs here match folder names under `project-output/`.
2. **`sessions/`** — browser login state so crawls can reuse an authenticated Essential Cloud session (not in SQLite).
3. **`project-output/<slug>/`** — bulky on-disk artifacts (screenshots, HTML, HARs, uploads, KB files, markdown reports).
4. **`<session-uuid>/`** — each crawl, upload, or synthesis job; same ID as `CrawlSession.id` in the DB.

---

## `backend/sessions/essential-cloud-1787255177369/`

| File | Purpose |
|------|---------|
| `session.json` | Playwright **storage state** for `eag.essentialintelligence.com` |

### What `session.json` contains

Top-level keys: `cookies`, `origins`.

- **`cookies`** — auth / tenant cookies (`JSESSIONID*`, `tenant`, `eip.session.id`, bearer/refresh tokens, analytics, i18n, etc.). Used to resume logged-in crawls without re-login.
- **`origins[].localStorage`** — UI state for Viewer / EDM (DataTables prefs, `pageHistory`, repo selection, editor settings, etc.).

> **Security note:** this file holds live session tokens. Do not commit or paste it into docs/PRs. Treat it like a secret.

There is **one** project-level session file (not one per crawl UUID). Crawl UUIDs live only under `project-output/`.

---

## `backend/project-output/essential-cloud-1787255177369/`

### Project-level file: `generation-checkpoint.json`

Tracks the multi-stage **report generation** pipeline across all source sessions.

| Field | Meaning (current snapshot) |
|-------|----------------------------|
| `appName` | `Essential Cloud` |
| `projectSlug` | `essential-cloud-1787255177369` |
| `sessionId` | Primary write target: `e9c7f73a-fd58-4d7e-8759-56416e6d6f3f` |
| `sourceSessionIds` | All **27** crawl/upload sessions merged into the report |
| `status` | `completed` |
| `currentStage` / `stageLabel` | `final-report` / Final report writing |
| `progress` | `100` |
| `reportPath` | `…/e9c7f73a-…/reports/final-report.md` |
| `artifacts` | Paths to entity model, workflow model, permission matrix, architecture, deep research, expert analysis |

---

## Per-run folder layout (`<session-uuid>/`)

Created by helpers in `backend/src/utils/file-system.ts` (`getScreenshotsDir`, `getHtmlDir`, `getPagesDir`, `getApiDir`, `getHarDir`, `getAnalysisDir`, plus evidence import / report writers).

### Standard crawl artifact dirs

| Folder | Contents |
|--------|----------|
| **`screenshots/`** | PNG screenshots of visited URLs. Filenames are URL-sanitized (e.g. `viewer__289236b3a93c0117d8b1_1__report.png`). `mobile_*` variants are mobile viewport captures. |
| **`html/`** | Full HTML dump per page (`*.html`), same basename as the screenshot. |
| **`pages/`** | Structured page extraction JSON. Typical files: `<name>.json` (DOM/UI summary) and `<name>-js-intel.json` (scripts, globals, routes, framework hints). |
| **`api/`** | Per-page API/network call summaries (`*-api.json`) — endpoints, methods, payloads observed while on that page. |
| **`har/`** | Full HTTP Archive traces (`*.har`) for deep network / auth / API reconstruction. |
| **`analysis/`** | Post-processing for that run (see below). |

#### `pages/*.json` (page capture) — typical keys

`url`, `title`, `pageType`, `headings`, `visibleText`, `paragraphs`, `breadcrumbs`, `allClickables`, `forms`, `tables`, `navigation`, `modals`, …

#### `pages/*-js-intel.json` — typical keys

`inlineScripts`, `externalScripts`, `windowGlobals`, `reactComponents`, `vueComponents`, `clientRoutes`, `storeShape`, `appConfig`, `sourceMaps`, `eventListenerHints`, `webWorkers`, `webSockets`, …

### `analysis/`

| File | Present when | Purpose |
|------|--------------|---------|
| `image-ocr-results.json` | Almost every run (27/27) | Vision/OCR over screenshots + evidence images. Shape: `sessionId`, `analyzedAt`, `totalImages`, `results[]`. |
| `rolling-context.json` | Agent/LLM exploration runs (~6) | Live agent memory snapshot: `explorationGoals`, `activeInstructions`, `rollingSummaries`, `interactionHistoryCount`, `recentInteractions`. |

### Evidence import dirs (only on upload-heavy runs)

| Path | Purpose |
|------|---------|
| **`uploaded-evidence/`** | Raw user uploads (ZIPs extracted here). Any folder shape is preserved. Includes `_structure-inventory.json` indexing the tree. |
| **`knowledge-base/`** | When an upload matches a structured KB layout, it is copied/indexed here for RAG / GraphRAG. |
| **`_zip-import/`** | Temporary extract root while importing ZIPs (`import-service.ts`). |
| **`upload-manifest.json`** | Record of uploaded files, destinations, and KB detection results. |

### `reports/` (synthesis / final deliverables)

Created when report or multi-agent synthesis runs. Notable contents:

| Path / pattern | Purpose |
|----------------|---------|
| `final-report.md` | End-user redevelopment / reverse-engineering report |
| `REDEVELOPMENT-README.md` | Short pointer / intro for the report pack |
| `entity-model.json` | Extracted domain entities |
| `workflow-model.json` | User / system workflows |
| `permission-matrix.json` | Roles × capabilities |
| `architecture.json` | System architecture synthesis |
| `deep-research.json` | Deep research agent output |
| `har-intelligence.json` | Aggregated HAR insights |
| `knowledge-graph.json` | Graph built for synthesis |
| `*-agent-findings.json` | Specialist agents (UI/UX, API, data, security, domain, solution architect, …) |
| `expert-analysis-chunk-*.json` | Chunked expert analysis over evidence |
| `traceability-matrix.csv` | Evidence → finding traceability |
| `validation-plan.json` | Suggested validation steps |
| **`_generation/`** | Scratch / intermediate generation state |
| **`_generation/workspace/`** | Synthesis workspace: `MANIFEST.json`, `EVIDENCE-INDEX.json`, `coverage-state.json`, copied evidence shards (`graph-chunks/`, `har/`, `page-analyses/`, `uploaded-evidence/`, `network-calls/`), working models |

---

## What’s actually on disk for Essential Cloud (file counts)

Counts = files under each folder (`-` means folder missing).

| Session UUID | screenshots | html | pages | api | har | analysis | uploaded-evidence | knowledge-base | reports |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `00bf800e-…` | 2 | 2 | 2 | 2 | 2 | 1 | 0 | 0 | — |
| `1a360e2a-…` | 1 | 1 | 1 | 1 | 1 | 2 | 0 | 0 | — |
| `258a626f-…` | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | — |
| `2a8dc910-…` | 2 | 2 | 2 | 2 | 2 | 1 | 0 | 0 | — |
| `2b1dc38e-…` | 1 | 1 | 1 | 1 | 1 | 2 | 0 | 0 | — |
| `4314a9e6-…` | 2 | 2 | 2 | 2 | 2 | 2 | 0 | 0 | — |
| `4efe2e75-…` | **66** | 66 | 62 | 67 | 66 | 1 | 0 | 0 | — |
| `4fb24832-…` | **94** | 77 | **154** | 77 | 77 | 1 | 0 | 0 | **~15k** |
| `61afd52a-…` | 1 | 1 | 1 | 1 | 1 | 1 | 0 | 0 | — |
| `924b5ec3-…` | 1 | 1 | 1 | 1 | 1 | 2 | 0 | 0 | — |
| `9887661a-…` | 2 | 2 | 2 | 2 | 2 | 1 | 0 | 0 | — |
| `a50330df-…` | 1 | 2 | 3 | 2 | 2 | 1 | 0 | 0 | — |
| `ad7225c3-…` | 7 | 7 | 7 | 7 | 7 | 2 | 0 | 0 | — |
| `aef5b3b5-…` | 2 | 3 | 4 | 3 | 3 | 1 | 0 | 0 | — |
| `af8c1336-…` | 2 | 2 | 2 | 2 | 2 | 1 | 0 | 0 | — |
| `b4f76f7a-…` | 6 | 6 | 7 | 6 | 6 | 1 | 0 | 0 | — |
| `c6b8dbb5-…` | 9 | 9 | 9 | 9 | 9 | 2 | 0 | 0 | — |
| `c898632a-…` | 3 | 4 | 4 | 4 | 4 | 1 | 0 | 0 | — |
| `d7fbd498-…` | 1 | 2 | 3 | 2 | 2 | 1 | 0 | 0 | — |
| `dc4ec9fc-…` | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | — |
| `dc657818-…` | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | — |
| `e1b3604f-…` | **175** | 176 | 172 | 176 | 176 | 1 | 0 | 0 | — |
| `e9c7f73a-…` | 0 | 0 | 0 | 1 | 0 | 1 | **1483** | 0 | **~19.7k** |
| `f55b16c7-…` | 1 | 1 | 1 | 1 | 1 | 1 | 0 | 0 | — |
| `f5c816b4-…` | 2 | 2 | 2 | 2 | 2 | 1 | 0 | 0 | — |
| `fae5f2ba-…` | 3 | 3 | 3 | 3 | 3 | 1 | 0 | 0 | — |
| `fc639c05-…` | 0 | 0 | 0 | 0 | 0 | 1 | **5165** | **2842** | — |

### How to read the table

- **Small runs (1–9 pages)** — exploratory / agent / partial crawls.
- **`e1b3604f-…`** — largest pure crawl (~175 pages of Viewer / portal coverage).
- **`4efe2e75-…` / `4fb24832-…`** — medium–large crawls; `4fb24832` also has a full `reports/_generation` workspace.
- **`fc639c05-…`** — **Essential University KB upload** (no live crawl); KB indexed under `knowledge-base/`.
- **`e9c7f73a-…`** — **standalone Essential v6.2.11 package upload** + primary **final report** output.
- **Empty capture dirs + only `analysis/`** — session scaffolded or OCR-only; little/no navigation yet.

---

## Deep dive: notable sessions

### 1. `fc639c05-8944-422f-9306-90cc082ffc78` — Essential University knowledge base

Upload-centric run. No crawl screenshots/pages; rich KB + raw evidence.

```
fc639c05-…/
├── analysis/image-ocr-results.json          # OCR over KB images/frames (~6.7 MB)
├── upload-manifest.json
├── _zip-import/
├── uploaded-evidence/
│   ├── _structure-inventory.json
│   └── essential-university/
│       ├── document.docx                    # Source doc (~45 MB)
│       ├── exports/                         # knowledge-base.json(l), videos, wiki-markdown, wiki.html
│       ├── output/                          # Prebuilt KB tree (mirrors knowledge-base/)
│       ├── tools/build_kb/                  # Python KB builder
│       └── NODEJS_KB_READER_IMPLEMENTATION_PROMPT.md
└── knowledge-base/                          # Canonical indexed package used by the app
    ├── README.md
    ├── manifest.json
    ├── _reader-diagnostics.json
    ├── ingestion/                           # chunks, documents, entities, topics, concepts, videos (json/jsonl)
    ├── structured/knowledge.json(l)         # Rich structured KB for agentic retrieval
    ├── graph/nodes.jsonl + edges.jsonl      # GraphRAG
    ├── canonical/master.md + master-expanded.md
    ├── markdown/                            # document-sections, videos, concepts, entities, topics
    ├── assets/document-images/ + video-frames/
    ├── indexes/                             # concept, entity, topic, video, frame, source indexes
    └── reports/                             # build-report, validation
```

From `knowledge-base/manifest.json` (stats): ~1411 chunks, 89 entities, 164 concepts, 83 videos, 477 document images, 944 video frames.

**Primary RAG file:** `knowledge-base/ingestion/chunks.jsonl`.

---

### 2. `e9c7f73a-fd58-4d7e-8759-56416e6d6f3f` — Standalone Essential + final report

Primary session referenced by `generation-checkpoint.json`.

```
e9c7f73a-…/
├── analysis/image-ocr-results.json
├── upload-manifest.json
├── _zip-import/
├── uploaded-evidence/
│   ├── _structure-inventory.json
│   └── standalone_essential_v6211/          # Full on-prem Essential drop
│       ├── jre/                             # Bundled JDK
│       ├── tomcat/                          # App server + webapps/docs
│       ├── repositories/                    # Protege / ontology repos
│       ├── protege/
│       ├── index.html
│       └── readme.md
├── api/                                     # Sparse (upload-driven)
├── knowledge-base/                          # Present but empty / unused for this pack
├── reports/                                 # ★ Final deliverables live here
│   ├── final-report.md
│   ├── REDEVELOPMENT-README.md
│   ├── entity-model.json
│   ├── workflow-model.json
│   ├── permission-matrix.json
│   ├── architecture.json
│   ├── deep-research.json
│   ├── har-intelligence.json
│   ├── knowledge-graph.json
│   ├── *-agent-findings.json
│   ├── expert-analysis-chunk-*.json         # Hundreds of chunk analyses
│   ├── traceability-matrix.csv
│   ├── validation-plan.json
│   └── _generation/workspace/               # Synthesis scratch + evidence shards
└── (many Tomcat howto *.html at run root)   # Side-effect of merging export tree into session dir
```

Also contains many `*.html` / docs files at the **session root** (Tomcat howto pages, `RELEASE-NOTES.txt`, etc.) from merging the standalone package export into the session directory during import.

---

### 3. `4fb24832-9a32-4728-94c0-5e1d44a0b6ac` — Rich Viewer crawl + synthesis workspace

Strong live crawl of Essential Viewer / tenant admin, plus a large `reports/_generation/workspace` used during synthesis (page-analyses, graph-chunks, HAR copies, network-calls, uploaded-evidence mirrors).

Screenshot names show Viewer report surfaces, e.g.:

- Application catalogue / dashboard / cost / deployment
- Business capability / process / value stream views
- Technology / data / EA principles / portal pages
- `tenant-admin.png`, `import__289236b3a93c0117d8b1.png`

---

### 4. `e1b3604f-527c-4b68-bf33-f85122b82e9e` — Largest crawl coverage

~175 screenshots / HTML / HAR pairs — broadest automated coverage of the cloud Viewer without a full report pack in this folder.

---

## End-to-end data flow

```
┌─────────────────────────────┐
│ sessions/.../session.json   │  Authenticated browser state
└──────────────┬──────────────┘
               │ used by crawler / agent
               ▼
┌─────────────────────────────┐     ┌──────────────────────────┐
│ project-output/.../<uuid>/  │◄───►│ prisma/dev.db            │
│  screenshots html pages     │     │  Project                 │
│  api har analysis           │     │  CrawlSession            │
│  uploaded-evidence + KB     │     │  PageCapture             │
└──────────────┬──────────────┘     │  NetworkCall             │
               │                    │  Entity/WorkflowModel    │
               ▼                    │  AnalysisGraph*          │
┌─────────────────────────────┐     │  AnalysisFinding         │
│ reports/ (+ _generation)    │     │  Report (filePath ptr)   │
│ generation-checkpoint.json  │     └──────────────────────────┘
│ final-report.md             │
└─────────────────────────────┘
```

**DB ↔ disk link:** `CrawlSession.id` === `project-output/<slug>/<session-uuid>/`.  
`PageCapture.screenshotPath` / HTML on disk; `Report.filePath` points at `…/reports/final-report.md`. Large blobs often live on disk; SQLite holds metadata + JSON text fields (`extractedData`, `aiAnalysis`, payloads, graph `properties`).

---

## SQLite database (`backend/prisma/dev.db`)

| | |
|---|---|
| **Engine** | SQLite via Prisma |
| **Schema** | `backend/prisma/schema.prisma` |
| **Client** | `backend/src/database/client.ts` (`prisma`) |
| **URL** | `DATABASE_URL="file:./dev.db"` (from `backend/.env`, relative to `backend/prisma/`) |
| **Size (Essential Cloud workspace)** | ~882 MB |
| **Projects in this DB** | 1 (`Essential Cloud`) |

Prisma maps model names 1:1 to SQLite tables (`Project`, `CrawlSession`, …). Several “structured” fields are stored as **JSON strings** in `TEXT` columns (SQLite has no native JSON type in this schema).

### Entity-relationship overview

```
Project 1──* CrawlSession 1──* PageCapture 1──* NetworkCall
   │              │                  │
   │              ├──* NetworkCall (also session-scoped)
   │              ├──* AnalysisGraphNode
   │              ├──* AnalysisGraphEdge
   │              ├──* AnalysisFinding
   │              └──* Report
   │
   ├──* Report
   ├──  EntityModel      (project-scoped; no FK in schema, keyed by projectId)
   └──  WorkflowModel    (project-scoped; no FK in schema, keyed by projectId)
```

Cascade: deleting a `Project` removes its `CrawlSession`s and `Report`s; deleting a `CrawlSession` removes pages, network calls, graph nodes/edges, and findings. `NetworkCall.pageCaptureId` is `ON DELETE SET NULL`.

### Models (fields & purpose)

#### `Project` — one app under reverse-engineering

| Field | Type | Notes |
|-------|------|--------|
| `id` | UUID PK | Essential Cloud: `88ad2317-e791-42a7-8f78-c88772e37b4e` |
| `name` | string | `Essential Cloud` |
| `slug` | string unique | `essential-cloud-1787255177369` → folder name under `project-output/` & `sessions/` |
| `baseUrl` | string | `https://eag.essentialintelligence.com/` |
| `loginUrl` | string? | optional login page |
| `loginRequired` | bool | `true` for Essential Cloud |
| `crawlDepth` | int | `10` |
| `allowedDomains` / `excludedUrls` / `safeClickSelectors` | JSON string | arrays as text; currently `[]` |
| `screenshotEnabled` / `networkCaptureEnabled` | bool | both `true` |
| `aiEnabled` | bool | `false` at project row (agents still used in report pipeline) |
| `llmBaseUrl` / `llmApiKey` / `llmModel` | string? | optional LLM override |
| `createdAt` / `updatedAt` | DateTime | stored as epoch-ms integers in this DB |

#### `CrawlSession` — one crawl or upload run

| Field | Type | Notes |
|-------|------|--------|
| `id` | UUID PK | **Same as** `project-output/.../<id>/` |
| `projectId` | FK → Project | cascade delete |
| `status` | string | e.g. `pending`, `completed` |
| `sourceType` | string | `crawl` (live browser) or `upload` (ZIP/evidence) |
| `uploadSummary` | JSON string? | upload stats + KB diagnostics |
| `startedAt` / `finishedAt` | DateTime? | |
| `errorMessage` | string? | |
| `pagesCount` | int | reported page/index count |
| `createdAt` | DateTime | |

**Essential Cloud:** 27 sessions — **25** `crawl` + **2** `upload`, all `completed`.

| `sourceType` | Count | Sum of `pagesCount` |
|--------------|------:|--------------------:|
| `crawl` | 25 | 724 |
| `upload` | 2 | 13,889 |

Upload sessions:

| Session | ZIP | Indexed pages (reported) | Notes |
|---------|-----|--------------------------|--------|
| `fc639c05-…` | `essential-university.zip` | 12,407 | `importedKnowledgeBase: true` |
| `e9c7f73a-…` | `standalone_essential_v6211.zip` | 1,482 | `importedFromExport: true` |

#### `PageCapture` — one page (or uploaded “page” artifact)

| Field | Type | Notes |
|-------|------|--------|
| `id` | UUID PK | |
| `crawlSessionId` | FK → CrawlSession | |
| `url` | string | Live URL or `upload://…` style for imports |
| `title` | string? | |
| `breadcrumbs` | JSON/text? | |
| `html` / `visibleText` | text? | Often also on disk under `html/` |
| `screenshotPath` / `fullScreenshotPath` | string? | Paths under `screenshots/` |
| `accessibilityTree` | text? | |
| `extractedData` | JSON string? | Structured UI extract (forms, tables, clickables, …) — mirrors `pages/*.json` |
| `aiAnalysis` | JSON/text? | Per-page AI analysis when present |
| `depth` | int | Crawl depth |
| `loadTimeMs` | float? | |
| `createdAt` | DateTime | |

**Essential Cloud:** **8,652** `PageCapture` rows. Live crawl URLs concentrate on Viewer reports, workspace-data-management, import, tenant-admin, login.

#### `NetworkCall` — one HTTP/XHR/fetch (optional GraphQL)

| Field | Type | Notes |
|-------|------|--------|
| `id` | UUID PK | |
| `crawlSessionId` | FK → CrawlSession | |
| `pageCaptureId` | FK? → PageCapture | nullable; SET NULL on page delete |
| `method` / `url` | string | |
| `queryParams` / `requestPayload` / `responseBody` | text? | Often JSON strings |
| `requestContentType` / `responseContentType` | string? | |
| `responseStatus` | int? | |
| `responseSchemaKeys` | text? | Inferred response keys |
| `requestHeaders` / `responseHeaders` | text? | |
| `timingMs` | float? | |
| `resourceType` | string? | xhr, fetch, document, … |
| `isGraphQL` / `graphQLOperationName` | bool / string? | |
| `createdAt` | DateTime | |

**Essential Cloud:** **3,099** network calls (crawl sessions only; uploads indexed 0 network calls).

#### `EntityModel` — inferred domain entities (project-level)

| Field | Type | Notes |
|-------|------|--------|
| `id` | string PK | Often `{projectId}-{slugified-name}` |
| `projectId` | string | no Prisma relation, but scoped by project |
| `name` | string | entity display name |
| `fields` | JSON string | array of `{name, type, label, …}` |
| `relationships` | JSON string | links to other entities |
| `source` | string? | originating `CrawlSession.id` |
| `createdAt` / `updatedAt` | DateTime | |

**Essential Cloud:** **27** entities (many Tomcat/standalone-oriented names from synthesis), including: User, Role, Tomcat Server, Web Application, HttpSession, Uploaded File, Connector, Virtual Host, Servlet, JSP Page, WebSocket Endpoint, Product, Shopping Cart, …

#### `WorkflowModel` — inferred workflows / state machines

| Field | Type | Notes |
|-------|------|--------|
| `id` | string PK | |
| `projectId` | string | |
| `name` | string | |
| `entityName` | string? | related entity |
| `states` / `transitions` | JSON string | FSM definition |
| `actors` | JSON string? | |
| `source` | string? | session id |

**Essential Cloud:** **7** workflows, e.g. User Onboarding & Account Setup, Project Creation & Configuration, CI/CD Pipeline Execution, Incident Response & Rollback, Feature Flag Progressive Rollout, Team Collaboration & Code Review, Secrets Management & Rotation.

#### `Report` — pointer to generated report file

| Field | Type | Notes |
|-------|------|--------|
| `id` | UUID PK | |
| `projectId` | FK → Project | |
| `crawlSessionId` | FK? → CrawlSession | primary session for the report |
| `type` | string | e.g. `full` |
| `filePath` | string | relative path to markdown/HTML on disk |
| `createdAt` | DateTime | |

**Essential Cloud:** 1 row —

- `type`: `full`
- `crawlSessionId`: `e9c7f73a-fd58-4d7e-8759-56416e6d6f3f`
- `filePath`: `project-output/essential-cloud-1787255177369/e9c7f73a-…/reports/final-report.md`

#### `AnalysisGraphNode` / `AnalysisGraphEdge` — evidence knowledge graph

**Node**

| Field | Type | Notes |
|-------|------|--------|
| `id` | UUID PK | |
| `projectId` / `crawlSessionId` | string / FK | |
| `kind` | string | node type (see below) |
| `key` | string | stable key within session+kind (unique with kind) |
| `label` | string | human label |
| `properties` | JSON string | arbitrary payload |
| `source` / `confidence` | string? / float? | |
| Unique | `(crawlSessionId, kind, key)` | |

**Edge**

| Field | Type | Notes |
|-------|------|--------|
| `fromNodeId` / `toNodeId` | string | node ids |
| `kind` | string | relationship type |
| Unique | `(crawlSessionId, fromNodeId, toNodeId, kind)` | |

**Essential Cloud graph size:** **38,362** nodes · **47,302** edges.

| Top node `kind` | Count | Top edge `kind` | Count |
|-----------------|------:|-----------------|------:|
| `RAW_ARTIFACT` | 11,516 | `PROJECT_HAS_RAW_ARTIFACT` | 11,516 |
| `PAGE` | 8,390 | `PAGE_IN_MODULE` | 8,731 |
| `COLUMN` | 6,001 | `HAS_PAGE` | 8,390 |
| `API_CALL` | 3,099 | `TABLE_HAS_COLUMN` | 6,001 |
| `RESPONSE_BODY` | 2,965 | `ENDPOINT_HAS_CALL` | 3,099 |
| `TABLE` | 1,431 | `CALL_HAS_RESPONSE_BODY` | 2,965 |
| `FIELD` | 1,393 | `PAGE_CALLS_API` | 1,513 |
| `MODAL` / `FORM` / `MODULE` | … | `PAGE_HAS_*` / `FORM_HAS_FIELD` | … |
| `ENTITY` / `ROLE` / `WORKFLOW` / `PROJECT` | 27 / 8 / 7 / 1 | `HAS_ENTITY` / `HAS_ROLE` / `HAS_WORKFLOW` | 27 / 8 / 7 |

#### `AnalysisFinding` — multi-agent findings

| Field | Type | Notes |
|-------|------|--------|
| `id` | UUID PK | |
| `projectId` / `crawlSessionId` | string / FK | |
| `agent` | string | which specialist wrote it |
| `category` | string | ux, data, architecture, … |
| `severity` | string? | low / medium / … |
| `title` / `detail` | string | |
| `evidenceNodeIds` | JSON string? | links into analysis graph |
| `recommendation` | string? | |
| `confidence` | float? | |

**Essential Cloud:** **131** findings.

| Agent | Category | Count |
|-------|----------|------:|
| `ui-ux-agent` | ux | 46 |
| `data-engineer-agent` | data | 42 |
| `solution-architect-agent` | architecture | 15 |
| `coverage-validator` | auditability | 14 |
| `domain-product-agent` | domain | 11 |
| `api-integration-agent` | api | 1 |
| `gap-validator` | coverage / api-coverage | 2 |

### Essential Cloud row counts (this DB)

| Table | Rows |
|-------|-----:|
| `Project` | 1 |
| `CrawlSession` | 27 |
| `PageCapture` | 8,652 |
| `NetworkCall` | 3,099 |
| `EntityModel` | 27 |
| `WorkflowModel` | 7 |
| `Report` | 1 |
| `AnalysisGraphNode` | 38,362 |
| `AnalysisGraphEdge` | 47,302 |
| `AnalysisFinding` | 131 |

### Useful queries

```bash
# From backend/
sqlite3 prisma/dev.db "SELECT id, name, slug, baseUrl FROM Project;"

sqlite3 prisma/dev.db "
  SELECT id, status, sourceType, pagesCount
  FROM CrawlSession
  WHERE projectId = '88ad2317-e791-42a7-8f78-c88772e37b4e'
  ORDER BY createdAt;"

sqlite3 prisma/dev.db "
  SELECT agent, category, COUNT(*) 
  FROM AnalysisFinding
  WHERE projectId = '88ad2317-e791-42a7-8f78-c88772e37b4e'
  GROUP BY agent, category;"
```

Or via Prisma Client: `import { prisma } from './src/database/client'`.

---

## Quick navigation cheat sheet

| I want… | Go to… |
|---------|--------|
| SQLite DB file | `backend/prisma/dev.db` |
| Prisma data models | `backend/prisma/schema.prisma` |
| Project / session / page rows | SQLite tables `Project`, `CrawlSession`, `PageCapture` |
| Analysis graph + findings | `AnalysisGraphNode`, `AnalysisGraphEdge`, `AnalysisFinding` |
| Report DB pointer | `Report.filePath` → `…/e9c7f73a-…/reports/final-report.md` |
| Login cookies / storage | `backend/sessions/essential-cloud-1787255177369/session.json` |
| Report pipeline status | `…/project-output/essential-cloud-1787255177369/generation-checkpoint.json` |
| Final written report | `…/e9c7f73a-…/reports/final-report.md` |
| Biggest live crawl | `…/e1b3604f-…/` |
| Viewer screenshots + page JSON | `…/4fb24832-…/screenshots` + `pages` |
| Essential University RAG chunks | `…/fc639c05-…/knowledge-base/ingestion/chunks.jsonl` |
| Standalone Essential install dump | `…/e9c7f73a-…/uploaded-evidence/standalone_essential_v6211/` |
| OCR over images | any run’s `analysis/image-ocr-results.json` |
| Agent exploration memory | runs with `analysis/rolling-context.json` |

---

*Generated from the on-disk Essential Cloud project tree and `backend/prisma/dev.db`. Counts and checkpoint fields reflect the workspace state at documentation time.*
