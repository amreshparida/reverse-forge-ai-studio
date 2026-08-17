# 05 — Configuration

All configuration is in `backend/.env`. Copy from `backend/.env.example`.

---

## Database

```env
# SQLite (default, no setup required)
DATABASE_URL="file:./dev.db"

# PostgreSQL (for production or team use)
DATABASE_URL="postgresql://user:password@localhost:5432/re_ai"
```

---

## Server

```env
PORT=3001
HOST=127.0.0.1
NODE_ENV=development
# Required before binding to a non-loopback host
API_AUTH_TOKEN=
```

The server binds to `127.0.0.1` by default because crawl artifacts may contain sensitive application data. Startup fails if `HOST` is changed to a non-loopback address without `API_AUTH_TOKEN`. Authenticated deployments accept either `Authorization: Bearer <token>` or `X-API-Key: <token>`. The browser client can use a token stored for the tab with `sessionStorage.setItem('reverseforge-api-token', '<token>')`.

---

## Output Directories

These are auto-resolved to `backend/project-output/` and `backend/sessions/` regardless of the working directory. Override only if you need a different location.

```env
OUTPUT_DIR=     # leave blank = backend/project-output/
SESSION_DIR=    # leave blank = backend/sessions/
```

---

## LLM / AI Analysis

Only `LLM_API_KEY` is required. Everything else has sensible defaults.

```env
# Required for AI analysis features
LLM_API_KEY=sk-...

# Optional — defaults to OpenAI's gpt-4o-mini
LLM_MODEL=gpt-4o-mini

# Optional — leave blank for OpenAI. Set for alternative providers:
#   Ollama:  http://localhost:11434/v1
#   Azure:   https://<resource>.openai.azure.com/openai/deployments/<deploy>
#   Groq:    https://api.groq.com/openai/v1
#   LMStudio: http://localhost:1234/v1
LLM_BASE_URL=
```

**Without `LLM_API_KEY`:** All crawl modes still work. AI analysis, entity inference, workflow inference, permission matrix, architecture inference, visual analysis, and knowledge graph generation are skipped. The final report is generated with structural data only.

---

## Crawler Behaviour

```env
# Page load timeout in milliseconds
CRAWL_TIMEOUT_MS=30000

# Polite delay between page visits (ms)
CRAWL_DELAY_MS=1000

# Max concurrent crawl jobs (increase for faster crawls on powerful machines)
CRAWL_MAX_CONCURRENCY=2

# Set to false to watch the browser (debugging)
# Default: true (headless)
CRAWL_HEADLESS=true

# Maximum human-guided session length before automatic finalization
MANUAL_CRAWL_MAX_MINUTES=240
```

---

## Rate Limiting (API server)

```env
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100
```

---

## Project-Level Settings

These are configured per-project in the UI (Edit Project) or via API:

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | — | Project display name |
| `baseUrl` | URL | — | Entry point for crawl |
| `loginUrl` | URL | null | Override login page URL (defaults to baseUrl) |
| `loginRequired` | boolean | false | Opens headed browser for manual login |
| `crawlDepth` | integer 1–10 | 3 | Max link-following depth |
| `allowedDomains` | string[] | [auto] | Domains to follow (auto-detected from baseUrl) |
| `excludedUrls` | string[] | [] | URL patterns to never visit |
| `screenshotEnabled` | boolean | true | Capture screenshots |
| `networkCaptureEnabled` | boolean | true | Record XHR/fetch calls |
| `aiEnabled` | boolean | false | Run AI analysis on each page |

### Excluded URLs example

For apps with SSO/SAML, add the SSO discovery endpoints to prevent the crawler from triggering re-authentication:

```
/sso/discovery
/Shibboleth.sso
/auth/logout
```

---

## Logging

Logs are written to `backend/logs/`:
- `combined.log` — all levels
- `error.log` — errors only

Console output uses colorized format in development. Both use Winston with structured JSON for production.

Log level is `debug` in development, `info` in production.
