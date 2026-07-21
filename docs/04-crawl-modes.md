# 04 — Crawl Modes

## Overview

Three crawl modes are available, each optimized for different scenarios. All three share the same login flow and produce data into the same output structure.

| Mode | Button | LLM Required | Use When |
|---|---|---|---|
| BFS Crawler | 🕷 BFS Crawler | No | Fast full coverage of all linked pages |
| Agentic Crawler | 🤖 Agentic Crawler | Yes | Complex SPAs with tabs, dynamic content |
| Xpert Crawler | ⚡ Xpert Crawler | Optional (LLM enhances) | Best results — both strategies simultaneously |

---

## Login Flow (shared by all three modes)

When **Login Required** is enabled on the project, all three modes follow the same flow:

```
1. A Chromium browser opens at the login URL
2. The user fills in credentials and logs in manually
3. A purple "✓ Done — Start Crawling" button appears (bottom-right corner)
4. User clicks it → current URL is captured → session saved
5. Crawl starts from the captured post-login URL in the same browser tab
```

The session is saved to `backend/sessions/<project-slug>/session.json` for future crawls.

**Important:** The browser never navigates away from the post-login page. The crawl starts exactly where the user is when they click Done.

---

## 🕷 BFS Crawler

### How it works

Breadth-first search through all discoverable `<a href>` links and `data-href`/`data-url` attributes.

```
postLoginUrl
    ↓
Visit page → extract links → add to queue
                                   ↓
                            Visit next URL
                                   ↓
                            Extract links → add to queue
                                   ↓
                            ...until queue empty or max depth
```

One persistent browser tab is reused throughout. Navigation happens via `page.goto(url)` — no new tabs are opened per page.

### When to use

- When the app has standard `<a>` link navigation
- When you want complete coverage of all linked pages
- When you don't have an LLM API key
- As the first pass before a targeted Agentic crawl

### Limitations

- Does not explore content hidden behind tab panels, accordions, or `onclick` handlers
- Does not interact with dynamic content that requires scrolling/clicking to reveal
- May visit many similar list pages (pagination)

---

## 🤖 Agentic Crawler

### How it works

An LLM agent makes intelligent navigation decisions at each step, using a Planner → Navigator → Observer loop.

```
Observe page state
    ↓
Numbered element list sent to LLM Navigator
    ↓
LLM returns: { type: "click", elementIndex: 7, reason: "Orders tab not visited" }
    ↓
ActionBuilder executes in Playwright
    ↓
Every 15 steps: Planner LLM estimates coverage, suggests next priority
    ↓
Loop until coverage ≥ 90% or no unvisited navigation items
```

### Observer output (sent to LLM)

```
[0] a(nav): "Dashboard"
[1] a(nav): "Orders" → /orders
[2] button: "Search"
[3] a(nav): "Reports"
[4] role=tab: "Active Employees"
[5] role=tab: "Archived Employees"
...
```

The LLM picks an index, never sees raw HTML.

### When to use

- SPAs with React/Vue/Angular and complex client-side routing
- Apps where important content is hidden behind tab panels
- When you want smarter coverage over systematic coverage
- As a second pass after BFS to fill gaps

### Configuration

```env
LLM_API_KEY=sk-...    # Required
LLM_MODEL=gpt-4o-mini # gpt-4o for better results
```

---

## ⚡ Xpert Crawler (Collaborative)

### How it works

Two agents run **simultaneously** in the same browser window (two tabs), sharing a live `SharedCrawlState`:

```
One browser window
├── Tab 1: BFS Explorer (fast, breadth)
│   - Follows all <a href> links
│   - When it finds tabs/accordions: marks URL as needsDeep=true
│   - Adds discovered URLs to shared queue
│
└── Tab 2: LLM Navigator (smart, depth)
    - Prefers needsDeep=true pages from shared queue
    - Clicks through tabs, panels, accordions
    - Reports discovered features and entities back to shared state
    - Adds URLs BFS would have missed
```

### SharedCrawlState

Both agents communicate through a shared in-memory object:

- `urlQueue` — BFS prefers non-deep URLs; LLM prefers `needsDeep=true`
- `visitedUrls` — global deduplication across both agents
- `discoveredFeatures` — modules and entities found
- `stats` — per-agent page counts and timing

Node.js is single-threaded, so queue operations are atomic — no locking required.

### LLM agent head start

The LLM agent sleeps for 3 seconds at startup to let BFS seed the queue with real URLs before the LLM starts competing for them.

### When to use

- For the most comprehensive documentation pass
- When the app is a complex enterprise SPA
- When you have an LLM API key (LLM required for the second agent; BFS runs alone if no key)

### Tab behaviour

Both tabs are in the **same browser context** — same cookies, same session, same browser window. The user sees two tabs crawling simultaneously.

---

## Annotated Screenshots

All three modes produce **two screenshots per page**:

1. **Viewport screenshot** (`screenshots/<page>.png`) — shows the page with colored numbered boxes overlaid on every detected interactive element
2. **Full-page screenshot** (`screenshots/full_<page>.png`) — clean, no overlay

### Overlay color legend

| Color | Meaning |
|---|---|
| 🔵 Blue | Navigation link / tab / menu item |
| 🟢 Green | Form input / select / textarea |
| 🟠 Orange | Safe button |
| 🟣 Purple | Other interactive element |
| 🔴 Red | **Unsafe** — blocked, never clicked |

A red box means the safety system identified the element as a destructive action (delete, logout, approve, etc.). These are never clicked by any crawl mode.

---

## Report synthesis (after page AI analysis)

By default (`SYNTHESIS_AGENT=true`), these stages use a **local file-tool agent** (Cursor-style) with **coverage gates** (cannot write the artifact until all required evidence files are drained via `read_next_unread_*`):

| Stage | Evidence drained | Artifact |
|---|---|---|
| Entity | All page analyses → seeds `working-notes.json` + coverage | `entity-model.json` |
| Workflow / permission | Reuses shared page coverage + notes (no full re-read) | `workflow-model.json`, `permission-matrix.json` |
| Architecture & knowledge graph | Reuses page notes when available; drains all network calls | `architecture.json`, `knowledge-graph.json` |
| Specialist graph agents | All graph chunks | `*-findings.json` |

Workspace root: `reports/_generation/workspace/`.

Optional **synthesis-only** OpenAI-compatible endpoint (e.g. NVIDIA NIM) so page analysis can stay on `LLM_*`:

- `SYNTHESIS_LLM_BASE_URL` — e.g. `https://integrate.api.nvidia.com/v1`
- `SYNTHESIS_LLM_API_KEY` — provider key (`nvapi-...`)
- `SYNTHESIS_LLM_MODEL` — e.g. `nvidia/nemotron-3-ultra-550b-a55b`

Set `SYNTHESIS_AGENT=false` for legacy one-shot prompts. Raise `SYNTHESIS_AGENT_MAX_STEPS` (default **120**) for larger corpora.
