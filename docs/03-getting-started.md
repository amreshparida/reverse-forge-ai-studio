# 03 — Getting Started

## Prerequisites

- Node.js 20 or later
- npm 9 or later
- Git

For headed browser mode (watching the crawl): a display is required (Windows/macOS work natively; Linux needs Xvfb).

---

## Installation

```bash
# 1. Clone the repository
git clone <repo-url>
cd reverse-engineering-ai

# 2. Install backend dependencies
cd backend
npm install

# 3. Install Playwright browser
npx playwright install chromium

# 4. Set up environment
cp .env.example .env
# Edit .env — minimum required: DATABASE_URL is pre-set to SQLite

# 5. Initialize database
npm run db:push

# 6. Install frontend dependencies
cd ../frontend
npm install
```

---

## Running

Open two terminals:

**Terminal 1 — Backend API server**
```bash
cd backend
npm run dev
# → http://localhost:3001
```

**Terminal 2 — Frontend dashboard**
```bash
cd frontend
npm run dev
# → http://localhost:5173
```

Open **http://localhost:5173** in your browser.

---

## Docker (alternative)

```bash
cd backend
cp .env.example .env
# Set LLM_API_KEY in .env if needed
docker-compose up --build
# → http://localhost:3001 (serves both API and frontend)
```

---

## First Crawl (quick start)

1. Click **New Project**
2. Enter:
   - **Name**: any label
   - **Base URL**: the app you want to document (e.g. `https://demo.yoursystem.com`)
   - **Crawl Depth**: `2` for a quick test
   - **Login Required**: toggle ON if the app requires authentication
3. Click **Create Project**
4. On the project page, click **🕷 BFS Crawler**

If Login Required is enabled:
- A browser window opens at the login page
- Log in normally
- Click the purple **"✓ Done — Start Crawling"** button that appears in the bottom-right corner
- The crawl starts automatically from the page you're on

5. Watch the **Crawl Progress** page — page count increments in real time
6. When complete, click **View Pages** to browse captured screenshots and extracted data
7. Click **Reports** → **Preview Report** to see the generated documentation

---

## First AI Analysis (requires LLM key)

Add to `backend/.env`:
```env
LLM_API_KEY=sk-...          # OpenAI key, or any OpenAI-compatible provider
LLM_MODEL=gpt-4o-mini       # or gpt-4o, claude-3-5-sonnet, llama3, etc.
```

Restart the backend. After a crawl completes:
1. Go to the crawl progress page
2. Click **🤖 Run AI Analysis**
3. Click **📄 Generate Report**

The report will include entity models, workflow diagrams, permission matrix, architecture analysis, and a knowledge graph.

---

## CLI Usage

```bash
cd backend

# Create a project
npm run cli -- create-project --name "Acme CRM" --url https://crm.acme.com

# Login (opens browser, click Done when logged in)
npm run cli -- login --project acme-crm-*

# Run BFS crawl
npm run cli -- crawl --project acme-crm-*

# Run AI analysis
npm run cli -- analyze --project acme-crm-*

# Generate report
npm run cli -- generate-report --project acme-crm-*

# List all projects
npm run cli -- list-projects
```

---

## Using an Alternative LLM Provider

The LLM client uses the OpenAI SDK which is compatible with any OpenAI-format API:

```env
# Ollama (local)
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=llama3

# Azure OpenAI
LLM_BASE_URL=https://<resource>.openai.azure.com/openai/deployments/<deploy>
LLM_API_KEY=<azure-key>
LLM_MODEL=gpt-4o

# Groq
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=gsk_...
LLM_MODEL=llama-3.1-70b-versatile
```

Leave `LLM_BASE_URL` blank to use OpenAI directly.

---

## Watching the Browser (debug mode)

To see the browser navigate in real time:
```env
CRAWL_HEADLESS=false
```

Useful for verifying that the crawler isn't clicking logout or visiting unexpected pages.
</content>
