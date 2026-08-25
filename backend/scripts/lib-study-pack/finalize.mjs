import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  writeText,
  writeJson,
  appendJsonl,
  fileSize,
  formatBytes,
  countTree,
  sha256FileSync,
} from './fs-utils.mjs';
import {
  DEST,
  REPO_ROOT,
  EXPECTED,
  INCLUDE_SENSITIVE,
  warnings,
  manifest,
  sourceMap,
  discoveryRows,
  startedAt,
  trackGenerated,
  agentsDoc,
  readmeDoc,
  addManifest,
} from './core.mjs';

export function exportCrossReference(ctx) {
  const dir = ensureDir(path.join(DEST, '14-cross-reference'));
  const uni = ctx.universityManifest?.statistics || {};
  const entities = ctx.snapshotCounts.EntityModel;
  const suspiciousEntities = [
    'Tomcat Server',
    'Tomcat Manager UI',
    'Tomcat Host Manager',
    'HttpSession',
    'Servlet',
    'JSP Page',
    'Snake Game',
    'Number Guess Game',
    'Shopping Cart',
  ];

  writeText(
    path.join(dir, 'OBSERVED-VS-UNIVERSITY.md'),
    `# Observed Cloud vs Essential University

| Axis | Observed (eag.essentialintelligence.com) | University |
|------|------------------------------------------|------------|
| Nature | Live authenticated deployment crawl | Training/docs KB |
| Authority for UI behavior | **Higher** | Conceptual |
| Authority for terminology | Supporting | **Higher** |
| Sessions | crawl sessions | \`${ctx.universitySession?.id || 'n/a'}\` |

## Rule

Never assume a University feature was observed in the cloud deployment without a page/screenshot/API hit.

University stats (manifest): chunks=${uni.chunks ?? 'n/a'}, entities=${uni.entities ?? 'n/a'}, concepts=${uni.concepts ?? 'n/a'}, videos=${uni.videos ?? 'n/a'}.
`,
  );

  writeText(
    path.join(dir, 'OBSERVED-VS-STANDALONE.md'),
    `# Observed Cloud vs Standalone v6.2.11

| Axis | Observed Cloud | Standalone package |
|------|----------------|--------------------|
| Delivery | Hosted SaaS-style at eag.essentialintelligence.com | Local Tomcat+Protege distribution |
| Version | **Not proven** equal to 6.2.11 | Folder/readme → v6.2.11 standalone |
| Evidence | Screenshots, HAR, PageCapture | WARs, ontology, configs |

Standalone ≠ Cloud unless proven by explicit version markers in live HTML/API.
`,
  );

  writeText(
    path.join(dir, 'UNIVERSITY-VS-STANDALONE.md'),
    `# University vs Standalone

University teaches product concepts/workflows.

Standalone shows an open-source **implementation/runtime** shape (Viewer WAR, Import Utility, metamodel).

Overlap is expected at the conceptual level (Viewer, metamodel, import) but packaging differs from cloud.
`,
  );

  writeText(
    path.join(dir, 'CONCEPT-MAPPING.md'),
    `# Concept mapping (starter)

| Concept | University | Observed | Standalone | Status |
|---------|------------|----------|------------|--------|
| Essential Viewer | Likely in KB topics | Many \`/viewer/...\` pages | \`essential_viewer.war\` | STRONG MATCH |
| Import utility | Check KB | \`/import/...\` pages | \`essential_import_utility.war\` | STRONG MATCH |
| Tenant admin | Check KB | \`/tenant-admin\` pages | Not clearly identical | PARTIAL |
| Protege modeller | Training may cover | Not primary in cloud crawl | \`protege/\` | STANDALONE ONLY (for this crawl) |
| Tomcat Manager | Unlikely product concept | Not a cloud product surface | Present in package/examples | STANDALONE ONLY |
`,
  );

  writeText(
    path.join(dir, 'API-IMPLEMENTATION-MAPPING.md'),
    `# API ↔ implementation mapping

Observed NetworkCall URLs target \`eag.essentialintelligence.com\`.

Standalone WARs may expose analogous Viewer/Import routes on localhost — **do not assume identical handlers or contracts**.

Use \`05-network-and-api/API-CATALOG.jsonl\` for observed endpoints; inspect WAR contents only as implementation hints for standalone edition.
`,
  );

  writeText(
    path.join(dir, 'DATA-MAPPING.md'),
    `# Data mapping

| Store | Role |
|-------|------|
| SQLite PageCapture/NetworkCall | Observed structured index |
| AnalysisGraph* | Reverse Forge evidence graph |
| University graph/nodes\|edges.jsonl | University GraphRAG |
| EntityModel/WorkflowModel | Inferred — verify |
`,
  );

  writeText(
    path.join(dir, 'VERSION-DIFFERENCES.md'),
    `# Version differences

- Observed: Essential Cloud @ eag.essentialintelligence.com (edition/version not asserted here)
- Uploaded: Essential Open Source Standalone **v6.2.11** (package path evidence)

${ctx.standaloneVersionEvidence || ''}
`,
  );

  // Feature traceability jsonl — heuristic
  const features = [
    {
      feature: 'Viewer reports',
      university: 'SEARCH_KB',
      observed: 'CONFIRMED',
      standalone: 'STRONG MATCH (essential_viewer.war)',
      status: 'STRONG MATCH',
    },
    {
      feature: 'Workspace data management',
      university: 'SEARCH_KB',
      observed: 'CONFIRMED (/workspace-data-management)',
      standalone: 'UNKNOWN',
      status: 'OBSERVED ONLY (pending University confirm)',
    },
    {
      feature: 'Tenant administration',
      university: 'SEARCH_KB',
      observed: 'CONFIRMED (/tenant-admin)',
      standalone: 'PARTIAL',
      status: 'PARTIAL',
    },
    {
      feature: 'Tomcat Host Manager',
      university: 'NOT FOUND (product)',
      observed: 'NOT FOUND',
      standalone: 'STANDALONE ONLY',
      status: 'STANDALONE ONLY',
    },
    {
      feature: 'Essential University curriculum',
      university: 'CONFIRMED',
      observed: 'NOT FOUND as live app',
      standalone: 'NOT FOUND',
      status: 'UNIVERSITY ONLY',
    },
  ];

  const ftPath = path.join(dir, 'FEATURE-TRACEABILITY.jsonl');
  if (fs.existsSync(ftPath)) fs.rmSync(ftPath);
  appendJsonl(
    ftPath,
    features.map((f) => ({
      ...f,
      evidence: {
        live: '04-live-application/PAGE-CATALOG.jsonl',
        network: '05-network-and-api/API-CATALOG.jsonl',
        university: '12-essential-university/',
        standalone: '13-standalone-essential-v6.2.11/',
      },
    })),
  );

  writeText(
    path.join(dir, 'FEATURE-TRACEABILITY.md'),
    `# Feature traceability\n\nStatuses used: CONFIRMED, STRONG MATCH, LIKELY MATCH, PARTIAL, NOT FOUND, UNIVERSITY ONLY, OBSERVED ONLY, STANDALONE ONLY, UNKNOWN.\n\nMachine file: \`FEATURE-TRACEABILITY.jsonl\`\n\n| Feature | Status |\n|---------|--------|\n${features.map((f) => `| ${f.feature} | ${f.status} |`).join('\n')}\n\n## Suspicious inferred DB entities (likely standalone-influenced)\n\n${suspiciousEntities.map((e) => `- ${e}`).join('\n')}\n\nThese appear among ${entities} EntityModel rows — flag as misaligned until proven in live cloud evidence.\n`,
  );

  // Also copy to root FEATURE-TRACEABILITY.md
  fs.copyFileSync(path.join(dir, 'FEATURE-TRACEABILITY.md'), path.join(DEST, 'FEATURE-TRACEABILITY.md'));

  const provPath = path.join(dir, 'PROVENANCE-MATRIX.jsonl');
  if (fs.existsSync(provPath)) fs.rmSync(provPath);
  appendJsonl(
    provPath,
    sourceMap.map((s) => ({ ...s, type: 'source-map' })),
  );
  fs.copyFileSync(provPath, path.join(DEST, 'PROVENANCE-MATRIX.md'.replace('.md', '.jsonl')));
  writeText(
    path.join(DEST, 'PROVENANCE-MATRIX.md'),
    `# Provenance matrix\n\nSee \`14-cross-reference/PROVENANCE-MATRIX.jsonl\` and \`SOURCE-MAP.md\`.\n`,
  );

  writeText(
    path.join(dir, 'README.md'),
    readmeDoc({
      What: 'Cross-domain mapping between observed cloud, University, standalone, DB inferences, and reports.',
      Critical: 'Prevents false equivalence across editions and evidence types.',
    }),
  );
  writeText(
    path.join(dir, 'AGENTS.md'),
    agentsDoc({
      title: '14-cross-reference',
      authority: 'Methodology for reconciling conflicting evidence domains.',
      prefer: ['FEATURE-TRACEABILITY.jsonl', 'OBSERVED-VS-* docs', 'raw evidence for confirmation'],
      never: ['Forcing matches', 'Equating University/standalone/cloud without status'],
      related: ['12-essential-university/', '13-standalone-essential-v6.2.11/', '04-live-application/'],
    }),
  );
}

export function exportAiIngestion(ctx) {
  const dir = ensureDir(path.join(DEST, '15-ai-ingestion'));
  const files = {
    'sources.jsonl': [],
    'documents.jsonl': [],
    'pages.jsonl': [],
    'api-endpoints.jsonl': [],
    'database-tables.jsonl': [],
    'findings.jsonl': [],
    'university-knowledge.jsonl': [],
    'concepts.jsonl': [],
    'entities.jsonl': [],
    'workflows.jsonl': [],
    'traceability.jsonl': [],
  };

  files['sources.jsonl'].push(
    {
      id: 'src-project-output',
      type: 'source-root',
      title: 'project-output',
      provenance: 'reverse-forge',
      sourcePath: `backend/project-output/${EXPECTED.slug}/`,
      canonicalPath: `99-raw-archive/${EXPECTED.slug}/`,
    },
    {
      id: 'src-sqlite',
      type: 'database',
      title: 'essential-cloud.db',
      provenance: 'VACUUM INTO',
      sourcePath: 'backend/prisma/dev.db',
      canonicalPath: '02-database/raw/essential-cloud.db',
      metadata: ctx.snapshotCounts,
    },
    {
      id: 'src-university',
      type: 'university-kb',
      title: 'Essential University',
      canonicalPath: '12-essential-university/canonical-kb/',
      related: [ctx.universitySession?.id],
    },
    {
      id: 'src-standalone',
      type: 'standalone-package',
      title: 'Essential Standalone v6.2.11',
      canonicalPath: '13-standalone-essential-v6.2.11/package/',
      related: [ctx.standaloneSession?.id],
    },
  );

  for (const [t, c] of Object.entries(ctx.snapshotCounts)) {
    files['database-tables.jsonl'].push({
      id: `table-${t}`,
      type: 'db-table',
      title: t,
      provenance: 'sqlite',
      sourcePath: '02-database/raw/essential-cloud.db',
      canonicalPath: `02-database/tables/${t}.md`,
      metadata: { rows: c },
    });
  }

  files['university-knowledge.jsonl'].push({
    id: 'uni-manifest',
    type: 'university-manifest',
    title: 'University KB manifest',
    canonicalPath: '12-essential-university/canonical-kb/manifest.json',
    metadata: ctx.universityManifest || {},
  });
  files['university-knowledge.jsonl'].push({
    id: 'uni-chunks',
    type: 'university-chunks',
    title: 'Primary RAG chunks',
    canonicalPath: '12-essential-university/canonical-kb/ingestion/chunks.jsonl',
    metadata: { chunks: ctx.universityManifest?.statistics?.chunks },
  });

  files['entities.jsonl'].push({
    id: 'entities-index',
    type: 'entity-model-index',
    title: 'EntityModel index',
    canonicalPath: '06-models-and-domain/entity-model-index.json',
    metadata: { count: ctx.snapshotCounts.EntityModel },
  });
  files['workflows.jsonl'].push({
    id: 'workflows-index',
    type: 'workflow-model-index',
    title: 'WorkflowModel index',
    canonicalPath: '06-models-and-domain/workflow-model-index.json',
    metadata: { count: ctx.snapshotCounts.WorkflowModel },
  });
  files['findings.jsonl'].push({
    id: 'findings-catalog',
    type: 'findings',
    title: 'AnalysisFinding catalog',
    canonicalPath: '08-agent-findings/FINDING-CATALOG.jsonl',
    metadata: { count: ctx.findingsCount },
  });
  files['pages.jsonl'].push({
    id: 'page-catalog',
    type: 'pages',
    title: 'Page catalog',
    canonicalPath: '04-live-application/PAGE-CATALOG.jsonl',
    metadata: { count: ctx.pageCount },
  });
  files['api-endpoints.jsonl'].push({
    id: 'api-catalog',
    type: 'api',
    title: 'API catalog',
    canonicalPath: '05-network-and-api/API-CATALOG.jsonl',
    metadata: { count: ctx.networkCallCount },
  });
  files['traceability.jsonl'].push({
    id: 'feature-traceability',
    type: 'traceability',
    title: 'Feature traceability',
    canonicalPath: '14-cross-reference/FEATURE-TRACEABILITY.jsonl',
  });
  files['concepts.jsonl'].push({
    id: 'uni-concepts',
    type: 'concepts',
    title: 'University concepts index',
    canonicalPath: '12-essential-university/canonical-kb/indexes/concept-index.json',
    metadata: { concepts: ctx.universityManifest?.statistics?.concepts },
  });
  files['documents.jsonl'].push({
    id: 'final-report',
    type: 'report',
    title: 'Final report',
    canonicalPath: '10-final-reports/final-report.md',
  });

  for (const [name, rows] of Object.entries(files)) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) fs.rmSync(p);
    appendJsonl(p, rows);
  }

  writeText(
    path.join(dir, 'README.md'),
    readmeDoc({
      What: 'Lightweight machine-oriented indexes for RAG/agents. No binary payloads.',
      Start: '`sources.jsonl` then domain jsonl files.',
    }),
  );
  writeText(
    path.join(dir, 'AGENTS.md'),
    agentsDoc({
      title: '15-ai-ingestion',
      authority: 'Entry indexes only — follow canonicalPath into authoritative stores.',
      prefer: ['sources.jsonl', 'pages/api/findings/university jsonl', 'then raw/DB'],
      never: ['Ingesting HAR secrets', 'Loading entire knowledge-graph.json into one prompt'],
      related: ['AGENTS.md (root)', 'STUDY-GUIDE.md'],
    }),
  );
}

export function exportSensitive(ctx) {
  const dir = ensureDir(path.join(DEST, '98-sensitive-references'));
  const sessionFile = ctx.sessionFile;
  const size = fileSize(sessionFile);
  let hash = '';
  try {
    hash = sha256FileSync(sessionFile);
  } catch (e) {
    warnings.push(`Could not hash session.json: ${e.message}`);
  }
  writeText(
    path.join(dir, 'AUTH-SESSION.md'),
    `# Authenticated Playwright session (reference only)

| Field | Value |
|-------|-------|
| Original path | \`backend/sessions/${EXPECTED.slug}/session.json\` |
| Size | ${size} bytes |
| SHA-256 | \`${hash}\` |
| Purpose | Reuse authenticated browser state for crawls |
| Included in export? | **${INCLUDE_SENSITIVE ? 'YES (see raw/)' : 'NO (default)'}** |

## Security warning

This file contains cookies, bearer/refresh tokens, JSESSIONID values, and localStorage for a live tenant.

- Do **not** commit to public repos
- Do **not** paste contents into tickets/chat
- Rotate credentials if exposure is suspected

Re-run exporter with \`--include-sensitive-auth-state\` only in controlled environments.
`,
  );

  if (INCLUDE_SENSITIVE) {
    const raw = ensureDir(path.join(dir, 'raw'));
    fs.copyFileSync(sessionFile, path.join(raw, 'session.json'));
    writeText(
      path.join(raw, 'WARNING.md'),
      '# WARNING\n\nThis directory contains live authentication secrets.\n',
    );
    warnings.push('Sensitive auth session state was included via CLI flag');
  }
}

export function writeRootDocs(ctx) {
  const finishedAt = new Date().toISOString();
  const crawlN = ctx.classifiedSessions.filter((s) => s.sourceType === 'crawl').length;
  const uploadN = ctx.classifiedSessions.filter((s) => s.sourceType === 'upload').length;
  const uni = ctx.universityManifest?.statistics || {};

  writeText(
    path.join(DEST, 'SECURITY-NOTICE.md'),
    `# Security notice

This study pack may contain or reference:

- Session cookies / bearer tokens (see \`98-sensitive-references/\` — secrets not included by default)
- HAR files with Authorization/Cookie headers
- SQLite fields with request/response payloads
- Screenshots of tenant data
- PII in visibleText/HTML

**Rules**

1. Do not publish the pack publicly without redaction review
2. Generated Markdown/API catalogs are redacted where practical
3. Canonical SQLite + HAR remain unredacted forensic sources — control access
4. Never print secrets into agent transcripts
`,
  );

  writeText(
    path.join(DEST, 'VERSION-AND-EDITION-NOTES.md'),
    `# Version and edition notes

## Observed environment

- Product: **Essential Cloud**
- URL: ${ctx.project.baseUrl}
- Evidence: live crawl screenshots/HAR/PageCapture
- Version/edition: **not asserted** as v6.2.11

## Uploaded standalone package

- Label: Essential Open Source Standalone
- Path evidence: \`standalone_essential_v6211\`
- ${ctx.standaloneVersionEvidence || 'See 13-standalone-essential-v6.2.11/VERSION-EVIDENCE.md'}

## University

- Training knowledge pack (not a runtime version pin for cloud)
`,
  );

  writeText(
    path.join(DEST, 'DIRECTORY-MAP.md'),
    `# Directory map

\`\`\`
Essential-Cloud-Study-Pack/
├── 00-overview/
├── 01-source-inventory/
├── 02-database/
├── 03-sessions/
├── 04-live-application/
├── 05-network-and-api/
├── 06-models-and-domain/
├── 07-analysis-graph/
├── 08-agent-findings/
├── 09-expert-analysis/
├── 10-final-reports/
├── 11-generation-workspaces/
├── 12-essential-university/
├── 13-standalone-essential-v6.2.11/
├── 14-cross-reference/
├── 15-ai-ingestion/
├── 98-sensitive-references/
└── 99-raw-archive/
\`\`\`
`,
  );

  writeText(
    path.join(DEST, 'SOURCE-MAP.md'),
    `# Source map\n\n| Organized | Original | Classification | Reason |\n|-----------|----------|----------------|--------|\n${sourceMap
      .map(
        (s) =>
          `| \`${s.organized}\` | \`${s.original}\` | ${s.classification} | ${s.reason} |`,
      )
      .join('\n')}\n`,
  );

  writeText(
    path.join(DEST, 'DISCOVERY-INVENTORY.md'),
    `# Discovery inventory\n\nGenerated ${finishedAt}\n\n| Source path | Purpose | Files | Bytes | Classification | Destination |\n|-------------|---------|------:|------:|----------------|-------------|\n${discoveryRows
      .map((r) => {
        const sp = String(r.sourcePath).replace(REPO_ROOT + '/', '');
        return `| \`${sp}\` | ${(r.purpose || '').replace(/\|/g, '/')} | ${r.files ?? ''} | ${r.bytes ?? ''} | ${r.classification || ''} | ${r.organizedDestination || ''} |`;
      })
      .join('\n')}\n`,
  );

  // 00 overview + 01 inventory
  const o0 = ensureDir(path.join(DEST, '00-overview'));
  const o1 = ensureDir(path.join(DEST, '01-source-inventory'));
  writeJson(path.join(o1, 'discovery-inventory.json'), discoveryRows);
  writeText(path.join(o1, 'README.md'), `# Source inventory\n\nSee root \`DISCOVERY-INVENTORY.md\` and \`discovery-inventory.json\`.\n`);
  writeText(
    path.join(o1, 'AGENTS.md'),
    agentsDoc({
      title: '01-source-inventory',
      authority: 'Inventory of what existed before export.',
      prefer: ['DISCOVERY-INVENTORY.md', 'discovery-inventory.json'],
      never: ['Skipping unknown folders without recording them'],
      related: ['99-raw-archive/', 'SOURCE-MAP.md'],
    }),
  );

  writeText(
    path.join(o0, 'EXPORT-COMPLETENESS.md'),
    `# Export completeness

| Metric | Value |
|--------|------:|
| Export started | ${startedAt} |
| Export finished | ${finishedAt} |
| Source files | ${ctx.poStats.files} |
| Source dirs | ${ctx.poStats.dirs} |
| Source bytes | ${ctx.poStats.bytes} (${formatBytes(ctx.poStats.bytes)}) |
| Raw archive files | ${ctx.rawArchiveStats?.files ?? 'n/a'} |
| Raw archive bytes | ${ctx.rawArchiveStats?.bytes ?? 'n/a'} |
| DB snapshot bytes | ${ctx.snapshotSize} |
| DB integrity | ${ctx.integrity} |
| DB tables | ${ctx.snapshotTables.length} |
| Crawl sessions | ${crawlN} |
| Upload sessions | ${uploadN} |
| PageCapture | ${ctx.snapshotCounts.PageCapture} |
| NetworkCall | ${ctx.snapshotCounts.NetworkCall} |
| HAR files | ${ctx.harFileCount ?? 'n/a'} |
| Analysis nodes | ${ctx.snapshotCounts.AnalysisGraphNode} |
| Analysis edges | ${ctx.snapshotCounts.AnalysisGraphEdge} |
| Findings | ${ctx.snapshotCounts.AnalysisFinding} |
| Entities | ${ctx.snapshotCounts.EntityModel} |
| Workflows | ${ctx.snapshotCounts.WorkflowModel} |
| University chunks | ${uni.chunks ?? 'n/a'} |
| University entities | ${uni.entities ?? 'n/a'} |
| University concepts | ${uni.concepts ?? 'n/a'} |
| University videos | ${uni.videos ?? 'n/a'} |
| University images | ${uni.document_images ?? 'n/a'} |
| University frames | ${uni.video_frames ?? 'n/a'} |
| Standalone files | ${ctx.standaloneInventory?.files ?? 'n/a'} |
| Manifest entries | ${manifest.length} |
| Warnings | ${warnings.length} |

## Warnings

${warnings.length ? warnings.map((w) => `- ${w}`).join('\n') : '_None_'}
`,
  );
  writeText(path.join(o0, 'README.md'), `# Overview\n\nSee root README and \`EXPORT-COMPLETENESS.md\`.\n`);
  writeText(
    path.join(o0, 'AGENTS.md'),
    agentsDoc({
      title: '00-overview',
      authority: 'Export health and orientation.',
      prefer: ['EXPORT-COMPLETENESS.md', 'root README'],
      never: ['Ignoring warnings listed here'],
      related: ['EXPORT-MANIFEST.json'],
    }),
  );

  writeText(
    path.join(DEST, 'STUDY-GUIDE.md'),
    `# Study guide

## Learn Essential as a product

1. \`12-essential-university/\` (concepts, entities, chunks)
2. \`04-live-application/\` Viewer screenshots
3. \`14-cross-reference/\`

## Understand deployed cloud UI

1. \`04-live-application/PAGE-CATALOG.jsonl\`
2. screenshots → page JSON → JS intel
3. \`05-network-and-api/\`

## Understand network behavior

1. \`API-CATALOG.jsonl\`
2. HAR (careful — secrets)
3. NetworkCall in SQLite

## Understand captured data model

1. \`02-database/\`
2. \`07-analysis-graph/\`
3. \`06-models-and-domain/\` (verify!)

## Understand standalone Essential

1. \`13-standalone-essential-v6.2.11/\`
2. Tomcat webapps + repositories + Protege
3. Compare via \`14-cross-reference/OBSERVED-VS-STANDALONE.md\`

## Rebuild functionality

University semantics + observed behavior + network evidence + DB relationships + standalone implementation hints → cross-reference statuses.
`,
  );

  writeText(
    path.join(DEST, 'AGENTS.md'),
    `# AGENTS.md — Essential Cloud Study Pack

You are working in a **multi-domain evidence pack**. Domains have different authority.

## Four evidence domains

\`\`\`
OBSERVED ESSENTIAL CLOUD
       +
SQLITE / STRUCTURED DATABASE
       +
ESSENTIAL UNIVERSITY
       +
STANDALONE ESSENTIAL v6.2.11
       ↓
CROSS-REFERENCE + ANALYSIS
\`\`\`

## What did the deployed system actually do?

Prefer in order:

1. live screenshots / HTML / page extraction (\`04-live-application/\`)
2. network/HAR evidence (\`05-network-and-api/\`)
3. SQLite crawl records (\`02-database/\`)
4. analysis graph (\`07-analysis-graph/\`)
5. inferred models (\`06-models-and-domain/\`)
6. final reports (\`10-final-reports/\`)
7. University docs (\`12-essential-university/\`)
8. standalone implementation (\`13-standalone-essential-v6.2.11/\`)

## What does an Essential concept mean?

1. Essential University
2. official terminology inside standalone package/docs
3. observed system
4. inferred analyses

## How is standalone Essential implemented?

1. standalone v6.2.11 files
2. webapps / server files / configuration
3. repositories / ontology
4. packaged documentation
5. University docs
6. observed cloud deployment (comparison only)

## Hard rules

- NEVER assume University feature = observed deployment feature
- NEVER assume standalone v6.2.11 behavior = cloud deployment behavior
- NEVER assume inferred model = raw evidence
- NEVER dump cookies/tokens/Authorization from HAR/DB into answers
- Prefer \`15-ai-ingestion/sources.jsonl\` as the machine entrypoint

## Project identity

- App: ${ctx.project.name}
- ID: \`${ctx.project.id}\`
- Slug: \`${ctx.project.slug}\`
- URL: ${ctx.project.baseUrl}
`,
  );

  writeText(
    path.join(DEST, 'README.md'),
    `# Essential Cloud — Complete Forensic Export, Digital Twin Knowledge Pack & AI Study Repository

Generated: **${finishedAt}**

## Four evidence domains

\`\`\`
OBSERVED ESSENTIAL CLOUD
       +
SQLITE / STRUCTURED DATABASE
       +
ESSENTIAL UNIVERSITY
       +
STANDALONE ESSENTIAL v6.2.11
       ↓
CROSS-REFERENCE + ANALYSIS
\`\`\`

## Project identity

| Field | Value |
|-------|-------|
| Application | ${ctx.project.name} |
| Project ID | \`${ctx.project.id}\` |
| Slug | \`${ctx.project.slug}\` |
| Observed URL | ${ctx.project.baseUrl} |
| SQLite snapshot | \`02-database/raw/essential-cloud.db\` (${formatBytes(ctx.snapshotSize)}) |
| Integrity | ${ctx.integrity} |
| Sessions | ${ctx.classifiedSessions.length} (${crawlN} crawl / ${uploadN} upload) |
| PageCapture | ${ctx.snapshotCounts.PageCapture} |
| NetworkCall | ${ctx.snapshotCounts.NetworkCall} |
| Analysis graph | ${ctx.snapshotCounts.AnalysisGraphNode} nodes / ${ctx.snapshotCounts.AnalysisGraphEdge} edges |
| Findings | ${ctx.snapshotCounts.AnalysisFinding} |
| Final report | \`10-final-reports/final-report.md\` |
| University | \`12-essential-university/\` (session \`${ctx.universitySession?.id || 'n/a'}\`) |
| Standalone | \`13-standalone-essential-v6.2.11/\` (session \`${ctx.standaloneSession?.id || 'n/a'}\`) |

## Folder map

See \`DIRECTORY-MAP.md\`.

## Recommended study paths

See \`STUDY-GUIDE.md\`. Agents: start at \`AGENTS.md\` then \`15-ai-ingestion/sources.jsonl\`.

## Security

See \`SECURITY-NOTICE.md\`. Auth session secrets are **not** included by default.

## Provenance

- \`SOURCE-MAP.md\` — organized ↔ original paths
- \`DISCOVERY-INVENTORY.md\` — what existed in Reverse Forge output
- \`99-raw-archive/\` — untouched project-output mirror
- \`EXPORT-MANIFEST.json\` — file-level export manifest
`,
  );

  writeJson(path.join(DEST, 'EXPORT-MANIFEST.json'), {
    generatedAt: finishedAt,
    startedAt,
    project: ctx.project,
    counts: ctx.snapshotCounts,
    warnings,
    entries: manifest,
  });
  writeText(
    path.join(DEST, 'EXPORT-MANIFEST.md'),
    `# Export manifest\n\nEntries: **${manifest.length}**\n\nSee \`EXPORT-MANIFEST.json\` for full records (paths, modes, hashes where computed).\n`,
  );
}

export function validateExport(ctx) {
  const checks = [];
  function check(name, ok, detail = '') {
    checks.push({ name, ok: !!ok, detail });
  }
  check('root README', fs.existsSync(path.join(DEST, 'README.md')));
  check('root AGENTS', fs.existsSync(path.join(DEST, 'AGENTS.md')));
  check('STUDY-GUIDE', fs.existsSync(path.join(DEST, 'STUDY-GUIDE.md')));
  check('SOURCE-MAP', fs.existsSync(path.join(DEST, 'SOURCE-MAP.md')));
  check('PROVENANCE-MATRIX', fs.existsSync(path.join(DEST, 'PROVENANCE-MATRIX.md')));
  check('DB exists', fs.existsSync(path.join(DEST, '02-database/raw/essential-cloud.db')));
  check('DB integrity', ctx.integrity === 'ok', ctx.integrity);
  check(
    'DB row counts match source',
    Object.entries(ctx.tableCounts).every(([t, c]) => ctx.snapshotCounts[t] === c),
  );
  check('27 sessions', ctx.classifiedSessions.length === ctx.tableCounts.CrawlSession);
  check('University KB', fs.existsSync(path.join(DEST, '12-essential-university/canonical-kb')));
  check(
    'University chunks',
    fs.existsSync(path.join(DEST, '12-essential-university/ingestion/chunks.jsonl')) ||
      fs.existsSync(path.join(DEST, '12-essential-university/canonical-kb/ingestion/chunks.jsonl')),
  );
  check('Standalone package', fs.existsSync(path.join(DEST, '13-standalone-essential-v6.2.11/package')));
  check('Final report', fs.existsSync(path.join(DEST, '10-final-reports/final-report.md')));
  check('Raw archive', fs.existsSync(path.join(DEST, '99-raw-archive', EXPECTED.slug)));
  check('Manifest', fs.existsSync(path.join(DEST, 'EXPORT-MANIFEST.json')));
  check('Network catalog', fs.existsSync(path.join(DEST, '05-network-and-api/API-CATALOG.jsonl')));
  check('Graph catalog', fs.existsSync(path.join(DEST, '07-analysis-graph/NODE-KINDS.md')));
  check('Findings', fs.existsSync(path.join(DEST, '08-agent-findings/FINDING-CATALOG.jsonl')));

  const failed = checks.filter((c) => !c.ok);
  const status = failed.length === 0 ? 'PASS' : warnings.length ? 'PASS WITH WARNINGS' : 'FAIL';
  // if some failed -> FAIL; if only warnings -> PASS WITH WARNINGS
  const finalStatus = failed.length ? 'FAIL' : warnings.length ? 'PASS WITH WARNINGS' : 'PASS';

  writeJson(path.join(DEST, '00-overview', 'VALIDATION.json'), { status: finalStatus, checks, warnings });
  return { status: finalStatus, checks, failed };
}
