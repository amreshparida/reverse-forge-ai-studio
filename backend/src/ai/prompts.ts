import type { PageExtractedData } from '../extractor';

export function buildPageAnalysisPrompt(
  pageData: PageExtractedData,
  visibleText: string,
  appName?: string,
): string {
  const context = appName ? `This is a page from the application: "${appName}". ` : '';
  return `${context}Analyze this web application page and return a JSON object with the following structure:
{
  "businessModule": "e.g. Training Management, HR, Finance, CRM",
  "primaryEntity": "e.g. Employee, Training, Invoice, Customer",
  "relatedEntities": ["Entity1", "Entity2"],
  "pagePurpose": "Brief description of what this page does",
  "userActions": ["action1", "action2"],
  "formPurpose": "What the form is used for, if present",
  "tablePurpose": "What the table shows, if present",
  "workflowStage": "e.g. List, Create, Edit, Review, Approve, Dashboard",
  "possibleRoles": ["Role1", "Role2"],
  "businessRules": ["rule1", "rule2"],
  "nocobaseCollections": ["collection1", "collection2"],
  "nocobaseFields": [{"collection": "name", "field": "fieldName", "type": "string|number|date|boolean|select|relation", "options": []}],
  "relationships": [{"from": "Entity", "to": "Entity", "type": "hasMany|belongsTo|belongsToMany"}],
  "pluginSuggestions": ["plugin1"],
  "confidenceScore": 0.9
}

Page URL: ${pageData.url}
Page Title: ${pageData.title}
Page Type: ${pageData.pageType}
Breadcrumbs: ${pageData.breadcrumbs.join(' > ')}
Navigation Items: ${pageData.navigation.sidebar.map((i) => i.label).join(', ')}
Tabs: ${pageData.navigation.tabs.map((t) => t.label).join(', ')}
Buttons/Actions: ${pageData.allClickables.filter((c) => c.tag === 'button' || c.role === 'button').map((c) => c.text).join(', ')}
Forms: ${pageData.forms.map((f) => `${f.title || 'Form'} (${f.fields.map((fi) => fi.label || fi.name).join(', ')})`).join('; ')}
Tables: ${pageData.tables.map((t) => `${t.title || 'Table'} [${t.columns.map((c) => c.header).join(', ')}]`).join('; ')}
Headings: ${pageData.headings.map((h) => h.text).join(', ')}
Search boxes: ${pageData.searchBoxes.map((s) => s.placeholder).join(', ')}
Alerts: ${pageData.alerts.map((a) => `${a.type}: ${a.text}`).join('; ')}Tech stack: ${pageData.techStack.frameworks.join(', ')} / ${pageData.techStack.cssFramework ?? 'unknown CSS'}
JS Components: ${((pageData as unknown as Record<string, unknown>)['jsIntelligence'] as { reactComponents?: string[]; vueComponents?: string[] } | undefined)?.reactComponents?.join(', ') ?? 'n/a'}
JS Store keys: ${JSON.stringify(((pageData as unknown as Record<string, unknown>)['jsIntelligence'] as { storeShape?: Record<string, unknown> } | undefined)?.storeShape ?? {})}
JS App config: ${JSON.stringify(((pageData as unknown as Record<string, unknown>)['jsIntelligence'] as { appConfig?: Record<string, unknown> } | undefined)?.appConfig ?? {})}Visible Text: ${visibleText}

Return only valid JSON.`;
}

export function buildEntityInferencePrompt(
  pageAnalyses: unknown[],
  appName?: string,
): string {
  const context = appName ? `Application: "${appName}". ` : '';
  return `${context}Based on these page analyses from a web application, infer the complete entity model.

Return a JSON object with this structure:
{
  "entities": [
    {
      "name": "EntityName",
      "pluralName": "EntityNames",
      "description": "What this entity represents",
      "fields": [
        {
          "name": "fieldName",
          "type": "string|number|date|boolean|select|relation|uuid|text|email|url|file|image",
          "label": "Human readable label",
          "required": true,
          "unique": false,
          "defaultValue": null,
          "options": ["option1"],
          "relatedEntity": "OtherEntity"
        }
      ],
      "relationships": [
        {
          "type": "hasMany|belongsTo|belongsToMany|hasOne",
          "entity": "OtherEntity",
          "foreignKey": "otherId",
          "through": "JoinTable"
        }
      ],
      "primaryModule": "Module name",
      "hasStatus": true,
      "statusValues": ["Draft", "Active", "Archived"],
      "hasAuditFields": true,
      "isLookup": false,
      "estimatedRecordCount": "thousands"
    }
  ]
}

Page Analyses (summarized):
${JSON.stringify(pageAnalyses, null, 2)}

Return only valid JSON.`;
}

export function buildWorkflowInferencePrompt(
  pageAnalyses: unknown[],
  entities: unknown[],
  appName?: string,
): string {
  const context = appName ? `Application: "${appName}". ` : '';
  return `${context}Based on these page analyses and entities, identify all business workflows.

Return a JSON object:
{
  "workflows": [
    {
      "name": "Workflow Name",
      "description": "What this workflow accomplishes",
      "entityName": "PrimaryEntity",
      "states": ["Draft", "Submitted", "Approved", "Rejected"],
      "transitions": [
        {
          "from": "Draft",
          "to": "Submitted",
          "trigger": "Submit button",
          "actor": "Employee",
          "conditions": ["All required fields filled"],
          "notifications": ["Manager receives email"],
          "approvalRequired": false
        }
      ],
      "actors": ["Role1", "Role2"],
      "autoTransitions": [],
      "slaHours": null,
      "isApprovalWorkflow": false
    }
  ]
}

Entities: ${JSON.stringify(entities, null, 2)}
Page Analyses: ${JSON.stringify(pageAnalyses, null, 2)}

Return only valid JSON.`;
}

export function buildPermissionMatrixPrompt(
  pageAnalyses: unknown[],
  entities: unknown[],
  appName?: string,
): string {
  const context = appName ? `Application: "${appName}". ` : '';
  return `${context}Based on the page analyses, infer the role-based permission matrix.

Return a JSON object:
{
  "roles": [
    {
      "name": "RoleName",
      "description": "Role description",
      "level": "admin|manager|user|readonly",
      "permissions": [
        {
          "module": "Module",
          "resource": "Entity",
          "view": true,
          "create": false,
          "edit": false,
          "delete": false,
          "approve": false,
          "import": false,
          "export": false,
          "configure": false
        }
      ]
    }
  ],
  "modules": ["Module1", "Module2"]
}

Entities: ${JSON.stringify(entities, null, 2)}
Page Analyses: ${JSON.stringify(pageAnalyses, null, 2)}

Return only valid JSON.`;
}

export function buildNocoBaseBlueprintPrompt(
  entities: unknown[],
  workflows: unknown[],
  permissions: unknown[],
  appName?: string,
): string {
  const context = appName ? `Application: "${appName}". ` : '';
  return `${context}Generate a complete NocoBase implementation blueprint.

Return a JSON object:
{
  "recommendedPlugins": ["plugin-action-audit-log", "plugin-workflow", ...],
  "customPlugins": [{"name": "plugin-name", "purpose": "..."}],
  "collections": [
    {
      "name": "tableName",
      "title": "Human Title",
      "description": "...",
      "fields": [{"name": "...", "type": "...", "interface": "input|select|datePicker|...", "uiSchema": {}}],
      "indexes": [],
      "timestamps": true,
      "paranoid": false
    }
  ],
  "views": [{"title": "...", "type": "table|form|detail|calendar|kanban", "collection": "...", "filters": []}],
  "dashboards": [{"title": "...", "widgets": []}],
  "importJobs": [{"name": "...", "collection": "...", "format": "csv|excel", "mapping": {}}],
  "effortEstimate": {"totalWeeks": 12, "phases": []},
  "risks": ["risk1"],
  "assumptions": ["assumption1"]
}

Entities: ${JSON.stringify(entities, null, 2).slice(0, 3000)}
Workflows: ${JSON.stringify(workflows, null, 2).slice(0, 2000)}
Permissions: ${JSON.stringify(permissions, null, 2).slice(0, 1500)}

Return only valid JSON.`;
}

// ── New agentic prompts ────────────────────────────────────────────────────

export function buildVisualAnalysisPrompt(pageTitle: string, pageUrl: string): string {
  return `You are analyzing a screenshot of a web application page.
Page title: "${pageTitle}"
Page URL: ${pageUrl}

Describe in structured JSON what you see:
{
  "layoutType": "dashboard|list|form|detail|login|settings|report|calendar|kanban|other",
  "primaryContent": "What is the main content area showing?",
  "keyUIComponents": ["component1", "component2"],
  "dataDisplayed": ["what data is visible"],
  "userActions": ["what actions are available"],
  "colorScheme": "light|dark|custom",
  "navigationVisible": true,
  "estimatedComplexity": "simple|medium|complex",
  "businessContext": "What business domain/purpose is evident from the visual?"
}

Return only valid JSON.`;
}

export function buildArchitectureInferencePrompt(
  pageAnalyses: unknown[],
  networkCalls: unknown[],
  appName?: string,
  jsIntelSamples?: unknown[],
): string {
  const context = appName ? `Application: "${appName}". ` : '';
  const jsSection = jsIntelSamples && jsIntelSamples.length > 0
    ? `\nJS Intelligence: ${JSON.stringify(jsIntelSamples, null, 2)}`
    : '';
  return `${context}Based on page analyses, API calls, and JS intelligence, infer the technical architecture.

Return a JSON object:
{
  "frontendFramework": "React|Vue|Angular|Svelte|jQuery|other",
  "frontendLibraries": ["library1"],
  "cssFramework": "Tailwind|Bootstrap|MUI|Ant Design|other|none",
  "backendPattern": "REST|GraphQL|RPC|mixed",
  "apiBaseUrl": "/api/v1",
  "apiVersion": "v1",
  "authMechanism": "JWT|session|OAuth2|API Key|basic|unknown",
  "dataFormats": ["JSON"],
  "paginationStyle": "page-based|cursor-based|offset|none",
  "realtime": "WebSocket|SSE|polling|none",
  "fileUpload": true,
  "multiTenant": false,
  "i18n": false,
  "estimatedScale": "small(<1k users)|medium(1k-100k)|large(100k+)",
  "unusualPatterns": [],
  "securityObservations": [],
  "migrationChallenges": ["challenge1"]
}

Network calls: ${JSON.stringify(networkCalls, null, 2)}
Page analyses: ${JSON.stringify(pageAnalyses, null, 2)}${jsSection}

Return only valid JSON.`;
}

export function buildKnowledgeGraphPrompt(
  pages: unknown[],
  entities: unknown[],
  networkCalls: unknown[],
  appName?: string,
): string {
  const context = appName ? `Application: "${appName}". ` : '';
  return `${context}Build a knowledge graph from this application's pages, entities, and API calls.

Return a JSON knowledge graph:
{
  "nodes": [
    {"id": "unique-id", "type": "page|entity|api|module|role", "label": "Display name", "properties": {}}
  ],
  "edges": [
    {"source": "node-id", "target": "node-id", "type": "navigatesTo|hasField|calls|createdBy|manages|belongsTo", "label": "relationship"}
  ],
  "modules": [
    {"name": "Module", "pages": ["page-id"], "entities": ["entity-id"], "apis": ["api-id"]}
  ],
  "summary": {
    "totalPages": 0,
    "totalEntities": 0,
    "totalAPIs": 0,
    "topModules": ["module1"],
    "coreEntities": ["entity1"]
  }
}

Pages: ${JSON.stringify(pages, null, 2)}
Entities: ${JSON.stringify(entities, null, 2)}
APIs: ${JSON.stringify(networkCalls, null, 2)}

Return only valid JSON.`;
}

export function buildExpertReportAnalysisPrompt(
  evidence: unknown,
  appName?: string,
): string {
  const context = appName ? `Application: "${appName}". ` : '';
  return `${context}Perform a comprehensive enterprise reverse-engineering analysis using ALL provided evidence.

Act as a combined chief software engineer, solution architect, data engineer, senior developer, product owner, security reviewer, integration architect, and domain expert.

Use industry-standard analysis practices:
- Separate observed facts from reasoned inferences.
- Trace conclusions to pages, APIs, forms, tables, workflows, and captured evidence.
- Identify domain model, business capabilities, data flows, integration patterns, risks, gaps, and modernization considerations.
- Look across frontend, backend/API, data, security, product workflows, UX, operations, and migration planning.
- Do not invent unsupported details. If evidence is incomplete, state the limitation and what should be validated.
- Be detailed and expert-level, not generic.

Return JSON:
{
  "executiveAssessment": {
    "summary": "C-level summary of what the system does and its maturity",
    "businessDomain": "domain and subdomain",
    "systemPurpose": "core purpose",
    "maturity": "prototype|departmental|enterprise|mission-critical|unknown",
    "confidence": 0.85
  },
  "domainAnalysis": {
    "capabilities": [{"name": "Capability", "description": "What it does", "evidence": ["page/api/form/table"]}],
    "modules": [{"name": "Module", "purpose": "Purpose", "keyEntities": ["Entity"], "keyActions": ["Action"]}],
    "businessRules": ["rule"],
    "openQuestions": ["question"]
  },
  "productOwnerView": {
    "personas": [{"name": "Role", "goals": ["goal"], "evidence": ["evidence"]}],
    "userJourneys": [{"name": "Journey", "steps": ["step"], "painPoints": ["risk"], "evidence": ["evidence"]}],
    "featureInventory": [{"feature": "Feature", "module": "Module", "priority": "critical|high|medium|low", "evidence": ["evidence"]}]
  },
  "solutionArchitecture": {
    "architectureStyle": "REST|GraphQL|RPC|SPA|server-rendered|mixed|unknown",
    "frontend": {"framework": "framework", "libraries": ["library"], "observations": ["observation"]},
    "backend": {"patterns": ["pattern"], "apiFamilies": ["family"], "observations": ["observation"]},
    "integrationPatterns": [{"pattern": "pattern", "evidence": ["api"], "risk": "risk"}],
    "nonFunctionalObservations": {"performance": ["item"], "scalability": ["item"], "reliability": ["item"], "maintainability": ["item"]}
  },
  "dataEngineeringAnalysis": {
    "coreEntities": [{"name": "Entity", "description": "description", "fields": ["field"], "sourceEvidence": ["form/table/api"]}],
    "dataFlows": [{"name": "Flow", "source": "source", "destination": "destination", "apis": ["api"], "payloadObservations": ["observation"]}],
    "dataQualityRisks": ["risk"],
    "reportingAndAnalytics": ["observation"]
  },
  "apiAndIntegrationAnalysis": {
    "endpointGroups": [{"group": "group", "methods": ["GET"], "purpose": "purpose", "sampleEndpoints": ["url"], "requestResponseInsights": ["insight"]}],
    "authAndSessionSignals": ["signal"],
    "payloadAndResponseFindings": ["finding"],
    "contractRisks": ["risk"]
  },
  "securityAndCompliance": {
    "observedControls": ["control"],
    "sensitiveDataSignals": ["signal"],
    "risks": [{"risk": "risk", "severity": "critical|high|medium|low", "evidence": ["evidence"], "recommendation": "recommendation"}],
    "recommendedValidations": ["validation"]
  },
  "developerView": {
    "implementationSignals": ["signal"],
    "technicalDebt": [{"item": "item", "impact": "impact", "recommendation": "recommendation"}],
    "testingRecommendations": ["recommendation"],
    "refactoringOpportunities": ["opportunity"]
  },
  "migrationAndModernization": {
    "recommendedApproach": "approach",
    "phases": [{"name": "Phase", "goals": ["goal"], "deliverables": ["deliverable"], "risks": ["risk"]}],
    "estimationDrivers": ["driver"],
    "dependencyRisks": ["risk"]
  },
  "evidenceCoverage": {
    "pagesAnalyzed": 0,
    "apiCallsAnalyzed": 0,
    "payloadsAnalyzed": 0,
    "responseBodiesAnalyzed": 0,
    "coverageGaps": ["gap"]
  },
  "priorityRecommendations": [{"priority": "critical|high|medium|low", "recommendation": "recommendation", "rationale": "rationale", "owner": "Architect|Data|Product|Engineering|Security"}]
}

Evidence package:
${JSON.stringify(evidence, null, 2)}

Return only valid JSON.`;
}
