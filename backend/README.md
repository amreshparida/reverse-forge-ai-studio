# AI Reverse Engineering Studio

An open-source tool for reverse-engineering enterprise web applications (LMS, TMS, CRM, ERP, HRMS). It logs in, crawls pages, captures screenshots, records API calls, extracts UI structure, and generates full documentation + NocoBase implementation blueprints using AI.

> ⚠️ **Ethical use only.** Use this tool only on applications you own or have explicit permission to analyze. Do not use it for unauthorized access or scraping.

---

## Features

- 🔐 **Automated & manual login** — credential-based or browser popup
- 🕷️ **Smart crawler** — follows internal links, avoids destructive actions
- 📸 **Screenshot capture** — per-page and full-page screenshots
- 📄 **HTML + DOM extraction** — saves full page HTML and visible text
- 🔌 **Network recorder** — captures XHR/fetch calls with masked secrets
- 🧩 **Page extractor** — extracts forms, tables, buttons, navigation, cards, tabs
- 🤖 **AI analysis** — OpenAI-compatible LLM analysis per page
- 🧠 **Entity inference** — aggregates entities, fields, relationships
- 🔄 **Workflow inference** — detects lifecycle workflows and approvals
- 🛡️ **Permission matrix** — infers roles and RBAC permissions
- 🏗️ **NocoBase blueprint** — generates collections, fields, workflows, views
- 📑 **Full report** — Markdown + PDF final-report with all findings
- 🖥️ **React dashboard** — visual UI for all stages
- ⌨️ **CLI** — scriptable commands

---

## Quick Start

### Prerequisites

- Node.js 20+
- npm 9+

### 1. Clone & Install

```bash
git clone https://github.com/your-org/reverse-engineering-ai.git
cd reverse-engineering-ai
cp .env.example .env
npm install
npx playwright install chromium
```

### 2. Initialize Database

```bash
npm run db:push
```

### 3. Start the API Server

```bash
npm run dev
# → http://localhost:3001
```

### 4. Start the Frontend (separate terminal)

```bash
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

---

## Docker

```bash
cp .env.example .env
# Edit .env to set LLM_API_KEY if needed
docker-compose up --build
# → http://localhost:3001
```

---

## CLI Usage

```bash
# Create a project
npm run cli -- create-project --name "My TMS" --url https://tms.example.com --login-mode manual

# Login (opens browser for manual login)
npm run cli -- login --project my-tms

# Crawl the application
npm run cli -- crawl --project my-tms

# Run AI analysis (requires LLM API key)
npm run cli -- analyze --project my-tms

# Generate full report
npm run cli -- generate-report --project my-tms

# List all projects
npm run cli -- list-projects
```

---

## Web UI Workflow

1. Go to **http://localhost:5173**
2. Click **New Project** and fill in the form
3. Click **🔑 Login** to authenticate
4. Click **▶ Start Crawl** to begin crawling
5. Monitor progress in real-time
6. After crawl completes: **View Pages**, **View API Calls**
7. Click **🤖 Run AI Analysis** (requires API key)
8. Click **📄 Generate Report** to produce documentation
9. Go to **Reports** to preview and download

---

## Project Structure

```
src/
├── api/               # Express API server + routes
│   └── routes/
├── crawler/           # Playwright crawler + session management
├── extractor/         # Page element extractor (forms, tables, nav)
├── recorder/          # Network request/response recorder
├── ai/                # LLM abstraction + page analyzer + prompts
├── inference/         # Entity, workflow, permission inference
├── generators/        # Report generator + NocoBase blueprint
├── database/          # Prisma client
├── queue/             # Simple in-memory job queue
├── cli/               # Commander.js CLI
└── utils/             # Logger, masker, retry, file utilities

frontend/
├── src/
│   ├── pages/         # React pages
│   ├── components/    # Shared components
│   ├── api/           # API client
│   └── types/         # TypeScript types
│
prisma/
└── schema.prisma      # SQLite/PostgreSQL schema
```

---

## Output Structure

```
project-output/
└── {project-slug}/
    └── {session-id}/
        ├── screenshots/     # PNG screenshots per page
        ├── html/            # Full HTML per page
        ├── pages/           # Extracted JSON per page
        ├── api/             # API calls per page
        ├── analysis/        # AI analysis results
        └── reports/
            ├── final-report.md
            ├── final-report.pdf
            ├── entity-model.json
            ├── workflow-model.json
            ├── permission-matrix.csv
            ├── nocobase-blueprint.md
            ├── nocobase-collections.json
            └── nocobase-workflows.json
```

---

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | SQLite or PostgreSQL URL | `file:./dev.db` |
| `PORT` | API server port | `3001` |
| `OUTPUT_DIR` | Output directory | `./project-output` |
| `SESSION_DIR` | Browser session storage | `./sessions` |
| `LLM_BASE_URL` | OpenAI-compatible API URL | OpenAI |
| `LLM_API_KEY` | API key for LLM | *(required for AI)* |
| `LLM_MODEL` | Model name | `gpt-4o-mini` |
| `CRAWL_TIMEOUT_MS` | Page load timeout | `30000` |
| `CRAWL_DELAY_MS` | Delay between pages | `1000` |

---

## Safety

The crawler **never** clicks:
- Delete / Remove / Destroy
- Submit / Approve / Reject / Confirm
- Logout / Sign Out
- Payment / Checkout
- Archive / Disable / Deactivate

It **only** follows safe actions: View, Search, Filter, Expand, Tab navigation, Next page.

---

## LLM Provider Compatibility

Any OpenAI-compatible API works:
- **OpenAI** (GPT-4o, GPT-4o-mini)
- **Azure OpenAI**
- **Ollama** (local: `http://localhost:11434/v1`)
- **LM Studio**
- **Anthropic** (via proxy)
- **Groq**, **Together.ai**, etc.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js + TypeScript |
| Browser | Playwright (Chromium) |
| API | Express.js |
| Database | SQLite (default) / PostgreSQL |
| ORM | Prisma |
| AI | OpenAI SDK (any compatible provider) |
| Frontend | React + Vite + Tailwind CSS |
| Queue | In-memory job queue |
| PDF | Playwright |

---

## License

MIT — Free for personal and commercial use.

---

## Disclaimer

This tool is designed for legitimate reverse engineering of applications you own or have explicit written permission to analyze. The authors are not responsible for misuse.
