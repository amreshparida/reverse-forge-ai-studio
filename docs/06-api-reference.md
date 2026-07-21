# 06 — API Reference

Base URL: `http://localhost:3001/api`

All request/response bodies are JSON. All endpoints return appropriate HTTP status codes.

---

## Projects

### `GET /projects`
List all projects.

**Response**
```json
{
  "projects": [
    {
      "id": "uuid",
      "name": "Acme CRM",
      "slug": "acme-crm-1234567890",
      "baseUrl": "https://crm.acme.com",
      "loginRequired": true,
      "crawlDepth": 3,
      "screenshotEnabled": true,
      "networkCaptureEnabled": true,
      "aiEnabled": false,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "_count": { "crawlSessions": 5 }
    }
  ]
}
```

### `POST /projects`
Create a project.

**Request**
```json
{
  "name": "Acme CRM",
  "baseUrl": "https://crm.acme.com",
  "loginRequired": false,
  "loginUrl": "https://crm.acme.com/login",
  "crawlDepth": 3,
  "allowedDomains": ["crm.acme.com"],
  "excludedUrls": ["/logout", "/admin/reset"],
  "screenshotEnabled": true,
  "networkCaptureEnabled": true,
  "aiEnabled": false
}
```

### `GET /projects/:id`
Get project with recent crawl sessions.

### `PUT /projects/:id`
Update project fields (partial update).

### `DELETE /projects/:id`
Delete project and all associated data (cascade).

---

## Crawl Sessions

### `GET /projects/:projectId/crawls`
List all crawl sessions for a project.

### `POST /projects/:projectId/crawls`
Start a **BFS crawl** session.

**Response** `202 Accepted`
```json
{ "session": { "id": "uuid", "status": "pending", "pagesCount": 0 } }
```

### `POST /projects/:projectId/crawls/agent`
Start an **Agentic crawl** session. Requires `LLM_API_KEY`.

**Response** `202 Accepted`
```json
{ "session": { "id": "uuid", "status": "pending" }, "mode": "agent" }
```

**Error** `400 Bad Request` — if no LLM key configured.

### `POST /projects/:projectId/crawls/collaborative`
Start a **Xpert (collaborative) crawl** session.

**Response** `202 Accepted`
```json
{ "session": { "id": "uuid", "status": "pending" }, "mode": "collaborative" }
```

**Error** `409 Conflict` — if a crawl is already running.

### `GET /projects/:projectId/crawls/:sessionId`
Get session status and job progress.

**Response**
```json
{
  "session": {
    "id": "uuid",
    "status": "running",
    "pagesCount": 42,
    "startedAt": "...",
    "errorMessage": null
  },
  "job": { "status": "active", "progress": 35 }
}
```

**Session status values:**
- `pending` — queued, not started
- `awaiting_login` — browser open, waiting for user to log in and click Done
- `running` — actively crawling
- `completed` — finished successfully
- `failed` — error occurred (see `errorMessage`)
- `stopped` — manually stopped

### `POST /projects/:projectId/crawls/:sessionId/stop`
Stop a running crawl.

### `POST /projects/:projectId/crawls/:sessionId/mark-complete`
Mark a `failed` or `stopped` session as `completed` so it can be used for analysis and report generation. Clears `errorMessage` and refreshes `pagesCount`.

### `POST /projects/:projectId/crawls/:sessionId/analyze`
Run AI analysis on all pages in a session (background job).

### `POST /projects/:projectId/crawls/:sessionId/generate-report`
Generate the full documentation report (background job). Combines all completed sessions for the project.

---

## Pages

### `GET /projects/:projectId/crawls/:sessionId/pages`
List captured pages (paginated).

**Query params:** `page=1`, `limit=50`

**Response**
```json
{
  "pages": [
    {
      "id": "uuid",
      "url": "https://crm.acme.com/orders",
      "title": "Sales Orders",
      "depth": 1,
      "screenshotPath": "acme-crm/session-id/screenshots/orders.png",
      "loadTimeMs": 1240,
      "aiAnalysis": { "businessModule": "Order Management", "primaryEntity": "Sales Order" },
      "_count": { "networkCalls": 8 }
    }
  ],
  "total": 142,
  "page": 1,
  "limit": 50
}
```

### `GET /projects/:projectId/crawls/:sessionId/pages/:pageId`
Get full page data including extracted elements and network calls.

---

## Analysis

### `GET /projects/:projectId/analysis/entities`
Get inferred entity models for the project.

### `GET /projects/:projectId/analysis/workflows`
Get inferred workflow state machines.

### `GET /projects/:projectId/analysis/network`
Get recorded network calls.

**Query params:** `sessionId=uuid`, `page=1`, `limit=50`

### `GET /projects/:projectId/analysis/jobs`
Get recent job queue entries.

---

## Reports

### `GET /projects/:projectId/reports`
List generated reports.

### `GET /projects/:projectId/reports/:reportId/download`
Download a report file.

### `GET /projects/:projectId/reports/preview/:sessionId`
Get the Markdown content of the final report.

### `GET /projects/:projectId/reports/export/:sessionId`
Download all session output as a ZIP archive.

---

## System

### `GET /health`
Health check.

**Response**
```json
{ "status": "ok", "version": "1.0.0", "timestamp": "..." }
```

### `GET /events`
Server-Sent Events stream for real-time job progress.

**Event format:**
```
event: job
data: {"id":"...", "type":"crawl", "status":"active", "progress":42}
```
