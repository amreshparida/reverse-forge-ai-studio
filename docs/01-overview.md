# 01 — Project Overview

## What Is This?

**AI Reverse Engineering Studio** is an open-source tool for systematically documenting existing enterprise web applications — CRM, ERP, HRIS, billing portals, and operations dashboards — without access to source code or database schemas.

It automates what a senior business analyst would otherwise spend weeks doing manually: logging into an application, navigating every screen, cataloguing every form and table, recording every API call, and producing structured documentation.

---

## Problem Statement

Enterprise software migrations and rebuilds consistently fail or overrun because teams underestimate the complexity of the existing system. Analysts typically:

- Miss screens that require specific roles or workflows to reach
- Fail to capture all form validation rules and field constraints
- Overlook API contracts that must be replicated in the new system
- Produce documentation that is immediately stale

This tool solves the problem by **automating the documentation phase** with a browser-driven, AI-enhanced extraction pipeline.

---

## Core Capabilities

### Crawling
- **BFS Crawler** — Breadth-first discovery of all linked pages
- **Agentic Crawler** — LLM-driven exploration that understands UI context
- **Xpert Crawler** — Dual-agent mode: BFS + LLM running concurrently with a shared knowledge base

### Extraction (per page)
- Full HTML DOM
- Deep form extraction: every field, type, label, placeholder, validation rules, dropdown options
- Table structures: columns, sample rows, pagination, filters, row actions
- All interactive elements with safety classification
- Navigation structure: sidebar, tabs, breadcrumbs, dropdown menus
- Modals, cards, charts, alert messages
- Browser storage (localStorage, sessionStorage) — auth tokens flagged
- Console errors and warnings
- Tech stack detection: React, Vue, Angular, Next.js, Tailwind, Bootstrap, etc.
- JavaScript intelligence: window globals, React component names, Redux store shape, app config, feature flags

### Network Recording (per page)
- Every XHR/fetch call: method, URL, query params, headers, request body, response body
- GraphQL detection with operation name extraction
- Response schema keys (top-level JSON field names)
- All sensitive values masked automatically

### Advanced Capture (per session)
- OpenAPI/Swagger spec auto-discovery (probes 16 common paths)
- GraphQL schema introspection
- WebSocket message capture
- Server-Sent Events endpoint detection
- Source map references
- Cookie structure analysis
- IndexedDB schema
- Mobile viewport screenshots

### AI Analysis
- Per-page: business module, primary entity, page purpose, workflow stage, user roles, business rules
- Entity model inference across all pages
- Workflow state machine detection
- Permission matrix generation (role × resource × action)
- Technical architecture inference
- Knowledge graph generation
- Visual analysis via vision LLM (GPT-4o)

### Output
- Final report: Markdown + PDF
- Entity model JSON
- Workflow model JSON
- Permission matrix CSV
- Architecture analysis JSON
- Knowledge graph JSON
- Annotated screenshots (colored numbered boxes on detected elements)

---

## Non-Goals

This tool is designed exclusively for **read-only analysis** of applications you own or have explicit permission to analyze. It will never:

- Submit forms or create records
- Approve, reject, or modify workflow items
- Send emails or notifications
- Make payments or financial transactions
- Delete or archive data
- Log out of the application

---

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22+ |
| Language | TypeScript (strict mode) |
| Browser automation | Playwright (Chromium) |
| API server | Express.js |
| Database | SQLite (default) / PostgreSQL |
| ORM | Prisma |
| AI/LLM | OpenAI SDK (any OpenAI-compatible provider) |
| Frontend | React + Vite + Tailwind CSS |
| Job queue | In-memory (no Redis required) |
| PDF generation | Playwright headless |
