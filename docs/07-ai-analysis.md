# 07 — AI Analysis Pipeline

## Overview

AI analysis is optional and requires an LLM API key. When enabled, each crawled page is sent through a multi-stage pipeline that extracts business intelligence from raw captured data.

**Analysis runs in two phases:**
1. **Per-page analysis** — runs during or after each crawl, analyzes one page at a time
2. **Project-level inference** — runs once after all pages are analyzed, synthesizes cross-page insights

---

## Per-Page Analysis

Triggered per page (if `aiEnabled = true`) or in bulk via **Run AI Analysis** on a completed session.

### Inputs

- Page title and URL
- Extracted text content (cleaned, 4,000 token limit)
- Form field list (labels, types, names)
- Table headers and row structures
- Navigation element labels
- Button labels
- Network calls (masked — no credential values)
- Screenshot (if vision model available)

### LLM Prompt strategy

A structured JSON schema is requested from the LLM — no free-form text. Example output:

```json
{
  "businessModule": "Order Management",
  "primaryEntity": "Sales Order",
  "secondaryEntities": ["Customer", "Invoice", "Shipment"],
  "purpose": "Create and fulfill customer sales orders, track invoices and shipments",
  "keyActions": [
    "Create sales order",
    "Assign customer",
    "Confirm fulfillment",
    "Issue invoice"
  ],
  "formPurposes": {
    "order-form": "Create or edit a sales order",
    "customer-form": "Add or update a customer account"
  },
  "dataRelationships": [
    "SalesOrder belongs to Customer",
    "Invoice is generated from SalesOrder"
  ],
  "navigationHierarchy": "Dashboard > Sales > Orders"
}
```

---

## Project-Level Inference

Run after all pages are analyzed. Four parallel inference steps run against the full page analysis corpus:

### 1. Entity Model Inference

Produces normalized entity definitions with fields, types, and relationships:

```json
{
  "name": "SalesOrder",
  "fields": [
    { "name": "orderNumber", "type": "string", "required": true },
    { "name": "orderDate", "type": "date", "required": true },
    { "name": "status", "type": "enum", "values": ["Draft","Confirmed","Shipped","Closed"] }
  ],
  "relationships": [
    { "target": "Customer", "type": "belongs-to" },
    { "target": "LineItem", "type": "has-many" }
  ]
}
```

### 2. Workflow Inference

Identifies business process state machines:

```json
{
  "name": "Order Fulfillment Workflow",
  "entity": "SalesOrder",
  "states": ["Draft", "Confirmed", "Picking", "Shipped", "Closed"],
  "transitions": [
    { "from": "Draft", "to": "Confirmed", "action": "Confirm", "actor": "SalesRep" },
    { "from": "Confirmed", "to": "Picking", "action": "Start Fulfillment" }
  ]
}
```

### 3. Permission Matrix Inference

Infers role-based access control from visible UI elements:

```json
{
  "entity": "SalesOrder",
  "roles": {
    "Admin": { "create": true, "read": true, "update": true, "delete": true },
    "Manager": { "create": true, "read": true, "update": true, "delete": false },
    "SalesRep": { "create": true, "read": true, "update": true, "delete": false }
  }
}
```

### 4. Architecture Inference

Synthesizes the full system architecture from network calls and JS intelligence:

- API patterns (REST, GraphQL, RPC)
- Frontend framework(s) detected
- State management libraries
- Authentication mechanism (JWT, session cookie, SAML)
- Identified third-party integrations
- Estimated module map

---

## Knowledge Graph

After all inference is complete, a knowledge graph is built linking:
- Entities to pages where they appear
- Entities to their related entities
- Business modules to contained entities
- Workflows to the entities they govern

This graph is used to produce the Mermaid `erDiagram` and `stateDiagram-v2` sections of the final report.

---

## Visual Analysis

When using a multimodal model (e.g. `gpt-4o`), screenshots are sent alongside page text. The LLM can identify:
- Dashboard KPI widgets
- Kanban boards or timeline views
- Map-based interfaces
- Complex data grid patterns
- Chart types and their likely data sources

To enable: set `LLM_MODEL` to a vision-capable model. The system detects capability automatically and falls back to text-only if the model doesn't support images.

---

## Safety in Prompts

The `SAFETY_SUMMARY` constant from `crawler/safety.ts` is injected into every LLM prompt used for navigation decisions:

> "You are a read-only observer. NEVER click: logout, sign out, delete, remove, terminate, submit, approve, reject, or any URL matching SSO/SAML logout patterns. Your job is to observe and document — not to trigger state changes."

This ensures even if the safety filter misses a novel button label, the LLM is explicitly instructed not to act on it.

---

## Model Recommendations

| Use Case | Recommended Model | Notes |
|---|---|---|
| Quick analysis, cost-efficient | `gpt-4o-mini` | Good for structured JSON extraction |
| Best accuracy | `gpt-4o` | Vision support, better reasoning |
| Local / private | `llama3.1:70b` via Ollama | No data leaves your machine |
| Fast local | `qwen2.5-coder:7b` | Lower accuracy |

Use `LLM_BASE_URL` to point to any OpenAI-compatible endpoint.
