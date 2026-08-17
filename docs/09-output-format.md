# 09 — Output Format

## Directory Structure

All captured data lands under `backend/project-output/`:

```
backend/project-output/
└── <project-slug>/
    └── <session-id>/
        ├── screenshots/
        │   ├── 00-https-crm.acme.com-orders.png         # Viewport with overlay
        │   ├── full-00-https-crm.acme.com-orders.png    # Full-page, no overlay
        │   └── mobile-00-https-crm.acme.com-orders.png  # Mobile viewport
        ├── html/
        │   └── 00-https-crm.acme.com-orders.html        # Captured HTML source
        ├── pages/
        │   └── 00-https-crm.acme.com-orders.json        # Full extracted page data
        ├── api/
        │   ├── network-calls.json                    # All XHR/fetch captured
        │   ├── websocket.json                        # WebSocket messages
        │   ├── sse-endpoints.json                    # Detected SSE endpoints
        │   ├── openapi.json                          # OpenAPI spec (if found)
        │   ├── graphql-schema.json                   # GraphQL schema (if found)
        │   ├── source-maps.json                      # Source map URLs detected
        │   └── cookies.json                          # Cookie structure (masked)
        ├── har/
        │   └── 00-https-crm.acme.com-orders.har      # Per-page HAR 1.2 (full resource waterfall)
        ├── analysis/
        │   ├── entities.json                         # Inferred entity models
        │   ├── workflows.json                        # Inferred state machines
        │   ├── permissions.json                      # Inferred permission matrix
        │   ├── architecture.json                     # System architecture
        │   └── knowledge-graph.json                  # Cross-entity knowledge graph
        └── reports/
            ├── har-intelligence.json               # Deterministic HAR briefing
            ├── deep-research.json                  # LLM research dossier
            ├── final-report.md                       # Full Markdown report
            ├── final-report.pdf                      # PDF export
            ├── report-run-manifest.json              # Inventory of produced artifacts
            ├── redevelopment-blueprint.json          # Target modules, phases, unknowns
            ├── api-contract-catalog.json             # Observed, templated API contracts
            ├── implementation-backlog.json           # Evidence-derived implementation epics
            ├── traceability-matrix.csv                # Requirement-to-evidence mapping
            ├── validation-plan.json                   # Contract/workflow/data/NFR gates
            ├── REDEVELOPMENT-README.md                # Engineering handoff guide
            └── _generation/workspace/
                ├── network-calls/                    # Full API evidence for synthesis agents
                └── har/                              # Full HAR 1.2 files (same as session har/)
```

---

## Page JSON Format

`pages/<page>.json` contains the full `ComprehensivePageData` object:

```json
{
  "url": "https://crm.acme.com/orders",
  "title": "Sales Orders | Acme CRM",
  "extractedAt": "2026-01-01T12:00:00.000Z",
  "forms": [
    {
      "id": "order-form",
      "fields": [
        { "name": "orderNumber", "type": "text", "label": "Order Number", "required": true },
        { "name": "orderDate", "type": "date", "label": "Order Date" },
        { "name": "status", "type": "select", "label": "Status",
          "options": ["Draft", "Confirmed", "Shipped", "Closed"] }
      ]
    }
  ],
  "tables": [
    {
      "headers": ["Order Number", "Customer", "Total", "Status"],
      "rowCount": 25,
      "sampleRows": [
        ["SO-10482", "Northwind Traders", "12,450.00", "Confirmed"]
      ]
    }
  ],
  "navigation": {
    "mainMenu": ["Dashboard", "Sales", "Customers", "Reports", "Settings"],
    "breadcrumb": ["Home", "Sales", "Orders"],
    "tabs": ["Open", "Fulfilled", "Draft"]
  },
  "buttons": [
    { "text": "New Order", "type": "button" },
    { "text": "Export", "type": "button" }
  ],
  "techStack": {
    "framework": "react",
    "bundler": "webpack",
    "stateManagement": "redux",
    "uiLibrary": "antd"
  },
  "storage": {
    "localStorage": ["authToken", "userPreferences"],
    "sessionStorage": ["lastRoute"]
  },
  "jsIntelligence": {
    "windowGlobals": ["__APP_CONFIG__", "Sentry"],
    "appConfig": { "apiBaseUrl": "https://api.crm.acme.com", "version": "3.14" },
    "clientRoutes": ["/orders", "/orders/:id", "/customers/:id"],
    "reduxStateShape": { "orders": "object", "user": "object" }
  },
  "aiAnalysis": {
    "businessModule": "Order Management",
    "primaryEntity": "Sales Order",
    "secondaryEntities": ["Customer", "Invoice"],
    "purpose": "Create and track customer sales orders through fulfillment",
    "keyActions": ["Create order", "Assign customer", "Confirm shipment"]
  }
}
```

---

## Network Calls JSON

`api/network-calls.json` — array of captured XHR/fetch calls:

```json
[
  {
    "url": "https://api.crm.acme.com/v1/orders",
    "method": "GET",
    "status": 200,
    "requestHeaders": { "Authorization": "[MASKED]", "Content-Type": "application/json" },
    "requestBody": null,
    "responseHeaders": { "Content-Type": "application/json" },
    "responseBody": "[MASKED: 45 keys including id, orderNumber, status, ...]",
    "responseSchemaKeys": ["id", "orderNumber", "orderDate", "status", "customerId", "total"],
    "durationMs": 234,
    "capturedAt": "2026-01-01T12:00:01.000Z",
    "pageUrl": "https://crm.acme.com/orders"
  }
]
```

**Note:** Credential values, API tokens, and PII are masked before storage. The `responseSchemaKeys` field contains only top-level JSON field names — not values.

---

## Per-page HAR

`har/<page>.har` — full HAR 1.2 log for that page (document, scripts, CSS, XHR/fetch, etc.). Written alongside `api/<page>-api.json` whenever `networkCaptureEnabled` is true. Analysis/report stages load these **complete** files into the synthesis workspace and expert evidence package (file-count capped; content not summarized).

---

## Report (Markdown)

`reports/final-report.md` is the primary narrative deliverable. The six redevelopment files beside it form the machine-readable engineering handoff. Their presence and SHA-256 hashes are verified by `report-run-manifest.json`; missing required files mark the run degraded.

Sections:

1. **Executive Summary** — system name, detected modules, total pages, API count
2. **Business Modules** — each module with its entity list and navigation paths
3. **Entity Data Models** — per-entity fields, types, validations inferred
4. **Entity Relationship Diagram** — Mermaid `erDiagram`
5. **API Catalog** — all captured endpoints grouped by resource
6. **Workflows** — Mermaid `stateDiagram-v2` for each inferred workflow
7. **Permission Matrix** — role vs entity grid
8. **Technology Stack** — frontend framework, bundler, state management, libraries
9. **Advanced Captures** — OpenAPI spec presence, GraphQL schema, source maps
10. **Architecture Recommendations** — modernization and rebuild notes for a target platform

---

## Database Records

In addition to the file output, all data is stored in SQLite (or PostgreSQL):

| Table | Contains |
|---|---|
| `Project` | Project settings |
| `CrawlSession` | Crawl run metadata, status, timing |
| `PageCapture` | Per-page data: URL, title, screenshot paths, extracted JSON, AI analysis |
| `NetworkCall` | API calls with masked request/response |
| `EntityModel` | Inferred entity definitions (JSON) |
| `WorkflowModel` | Inferred workflow state machines (JSON) |
| `Report` | Report paths and generation status |

Use `npm run db:studio` (Prisma Studio) to browse the database:
```bash
cd backend
npm run db:studio
# → http://localhost:5555
```
