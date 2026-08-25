#!/usr/bin/env node
/**
 * Essential Cloud Study Pack exporter
 * Builds Essential-Cloud-Study-Pack/ at the repository root from Reverse Forge artifacts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  ensureDir,
  writeText,
  writeJson,
  appendJsonl,
  fileSize,
  sha256FileSync,
  cloneOrCopy,
  safeRelativeSymlink,
  countTree,
  formatBytes,
  redactSensitive,
  assertSafeDeleteTarget,
  runSqlite,
} from './fs-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const BACKEND = path.join(REPO_ROOT, 'backend');
const DEST = path.join(REPO_ROOT, 'Essential-Cloud-Study-Pack');
const INCLUDE_SENSITIVE = process.argv.includes('--include-sensitive-auth-state');

const EXPECTED = {
  slug: 'essential-cloud-1787255177369',
  projectId: '88ad2317-e791-42a7-8f78-c88772e37b4e',
  universityHint: 'fc639c05-8944-422f-9306-90cc082ffc78',
  reportHint: 'e9c7f73a-fd58-4d7e-8759-56416e6d6f3f',
  largestCrawlHint: 'e1b3604f-527c-4b68-bf33-f85122b82e9e',
  richViewerHint: '4fb24832-9a32-4728-94c0-5e1d44a0b6ac',
};

const warnings = [];
const manifest = [];
const sourceMap = [];
const discoveryRows = [];
const startedAt = new Date().toISOString();

function log(msg) {
  process.stdout.write(`[export] ${msg}\n`);
}

function addManifest(entry) {
  manifest.push({
    exportPath: entry.exportPath,
    sourcePath: entry.sourcePath ?? null,
    category: entry.category ?? '',
    provenance: entry.provenance ?? '',
    sizeBytes: entry.sizeBytes ?? 0,
    sha256: entry.sha256 ?? '',
    mode: entry.mode ?? 'generated',
    description: entry.description ?? '',
  });
}

function trackGenerated(exportAbs, opts = {}) {
  const rel = path.relative(DEST, exportAbs);
  addManifest({
    exportPath: rel,
    sourcePath: opts.sourcePath ?? null,
    category: opts.category ?? 'documentation',
    provenance: opts.provenance ?? 'generated',
    sizeBytes: fileSize(exportAbs),
    sha256: opts.hash ? sha256FileSync(exportAbs) : '',
    mode: opts.mode ?? 'generated',
    description: opts.description ?? '',
  });
}

function agentsDoc({ title, authority, prefer, never, related }) {
  return `# AGENTS.md — ${title}

## Authority for this directory

${authority}

## Prefer (in order)

${prefer.map((p, i) => `${i + 1}. ${p}`).join('\n')}

## Never assume

${never.map((n) => `- ${n}`).join('\n')}

## Related directories

${related.map((r) => `- \`${r}\``).join('\n')}

## Security

Do not echo cookies, Authorization headers, bearer/refresh tokens, or JSESSIONID values into answers or generated code. Cite paths instead.
`;
}

function readmeDoc(parts) {
  return Object.entries(parts)
    .map(([h, body]) => `## ${h}\n\n${body.trim()}\n`)
    .join('\n');
}

// ─── Discovery ───────────────────────────────────────────────────────────────

function discoverRepository() {
  const projectOutput = path.join(BACKEND, 'project-output', EXPECTED.slug);
  const dbPath = path.join(BACKEND, 'prisma', 'dev.db');
  const schemaPath = path.join(BACKEND, 'prisma', 'schema.prisma');
  const sessionDir = path.join(BACKEND, 'sessions', EXPECTED.slug);
  const sessionFile = path.join(sessionDir, 'session.json');
  const checkpointPath = path.join(projectOutput, 'generation-checkpoint.json');

  for (const [label, p] of [
    ['project-output', projectOutput],
    ['dev.db', dbPath],
    ['schema.prisma', schemaPath],
    ['session.json', sessionFile],
  ]) {
    if (!fs.existsSync(p)) throw new Error(`Missing required source: ${label} at ${p}`);
  }

  const projects = runSqlite(dbPath, 'SELECT id, name, slug, baseUrl, loginRequired, crawlDepth FROM Project;', {
    json: true,
  });
  const project = projects.find((p) => p.slug === EXPECTED.slug) || projects[0];
  if (!project) throw new Error('No Project row found in SQLite');
  if (project.id !== EXPECTED.projectId) {
    warnings.push(`Project ID mismatch: expected ${EXPECTED.projectId}, got ${project.id}`);
  }

  const sessions = runSqlite(
    dbPath,
    `SELECT id, projectId, status, sourceType, uploadSummary, startedAt, finishedAt, errorMessage, pagesCount, createdAt
     FROM CrawlSession WHERE projectId='${project.id}' ORDER BY createdAt;`,
    { json: true },
  );

  let checkpoint = null;
  if (fs.existsSync(checkpointPath)) {
    checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  }

  const tableCounts = {};
  for (const t of [
    'Project',
    'CrawlSession',
    'PageCapture',
    'NetworkCall',
    'EntityModel',
    'WorkflowModel',
    'Report',
    'AnalysisGraphNode',
    'AnalysisGraphEdge',
    'AnalysisFinding',
  ]) {
    tableCounts[t] = runSqlite(dbPath, `SELECT COUNT(*) AS c FROM ${t};`, { json: true })[0].c;
  }

  const poStats = countTree(projectOutput);

  return {
    projectOutput,
    dbPath,
    schemaPath,
    sessionDir,
    sessionFile,
    checkpointPath,
    project,
    sessions,
    checkpoint,
    tableCounts,
    poStats,
  };
}

function classifySession(session, projectOutput) {
  const dir = path.join(projectOutput, session.id);
  const exists = fs.existsSync(dir);
  const counts = {
    screenshots: 0,
    html: 0,
    pages: 0,
    api: 0,
    har: 0,
    analysis: 0,
    uploadedEvidence: 0,
    knowledgeBase: 0,
    reports: 0,
  };
  const flags = {
    hasKnowledgeBase: false,
    hasStandalone: false,
    hasUniversity: false,
    hasFinalReport: false,
    hasGenerationWorkspace: false,
    hasUploadManifest: false,
  };
  let uploadSummary = null;
  try {
    uploadSummary = session.uploadSummary ? JSON.parse(session.uploadSummary) : null;
  } catch {
    uploadSummary = { raw: session.uploadSummary };
  }

  if (exists) {
    for (const [key, folder] of [
      ['screenshots', 'screenshots'],
      ['html', 'html'],
      ['pages', 'pages'],
      ['api', 'api'],
      ['har', 'har'],
      ['analysis', 'analysis'],
      ['uploadedEvidence', 'uploaded-evidence'],
      ['knowledgeBase', 'knowledge-base'],
      ['reports', 'reports'],
    ]) {
      const p = path.join(dir, folder);
      if (fs.existsSync(p)) counts[key] = countTree(p).files;
    }
    flags.hasKnowledgeBase = fs.existsSync(path.join(dir, 'knowledge-base', 'manifest.json'));
    flags.hasStandalone = fs.existsSync(
      path.join(dir, 'uploaded-evidence', 'standalone_essential_v6211'),
    );
    flags.hasUniversity = fs.existsSync(path.join(dir, 'uploaded-evidence', 'essential-university'));
    flags.hasFinalReport = fs.existsSync(path.join(dir, 'reports', 'final-report.md'));
    flags.hasGenerationWorkspace = fs.existsSync(path.join(dir, 'reports', '_generation', 'workspace'));
    flags.hasUploadManifest = fs.existsSync(path.join(dir, 'upload-manifest.json'));
  }

  let role = 'other';
  let importance = 'normal';
  let reason = 'Session captured during Essential Cloud reverse-engineering.';

  if (flags.hasUniversity || (uploadSummary && uploadSummary.importedKnowledgeBase)) {
    role = 'university-upload';
    importance = 'canonical';
    reason = 'Essential University knowledge-base upload; primary University domain.';
  } else if (flags.hasStandalone) {
    role = 'standalone-upload-and-report';
    importance = 'canonical';
    reason = 'Standalone Essential v6.2.11 package upload and primary final-report session.';
  } else if (flags.hasFinalReport) {
    role = 'report-primary';
    importance = 'canonical';
    reason = 'Contains final-report.md.';
  } else if (session.sourceType === 'crawl' && counts.screenshots >= 150) {
    role = 'largest-live-crawl';
    importance = 'high';
    reason = 'Largest live application crawl coverage by screenshots.';
  } else if (session.sourceType === 'crawl' && counts.screenshots >= 50 && flags.hasGenerationWorkspace) {
    role = 'rich-viewer-crawl';
    importance = 'high';
    reason = 'Rich Viewer/tenant-admin crawl with synthesis workspace.';
  } else if (session.sourceType === 'crawl' && counts.screenshots >= 50) {
    role = 'large-live-crawl';
    importance = 'high';
    reason = 'Substantial live crawl coverage.';
  } else if (session.sourceType === 'crawl' && counts.screenshots > 0) {
    role = 'live-crawl';
    importance = 'normal';
    reason = 'Live authenticated crawl/agent capture.';
  } else if (session.sourceType === 'crawl' && counts.screenshots === 0 && counts.analysis > 0) {
    role = 'scaffold-or-ocr';
    importance = 'low';
    reason = 'Session scaffold / OCR-only with little navigation evidence.';
  } else if (session.sourceType === 'upload') {
    role = 'upload';
    importance = 'high';
    reason = 'Upload evidence session.';
  }

  return {
    ...session,
    uploadSummaryParsed: uploadSummary,
    diskExists: exists,
    counts,
    flags,
    role,
    importance,
    reason,
  };
}

function inventorySource(ctx) {
  const { projectOutput, sessions } = ctx;
  const classified = sessions.map((s) => classifySession(s, projectOutput));
  ctx.classifiedSessions = classified;

  discoveryRows.push({
    sourcePath: projectOutput,
    purpose: 'All Reverse Forge project artifacts for Essential Cloud',
    ...countTree(projectOutput),
    classification: 'project-root',
    status: 'raw+canonical-source',
    organizedDestination: '99-raw-archive/essential-cloud-1787255177369/',
  });

  for (const s of classified) {
    const dir = path.join(projectOutput, s.id);
    const stats = fs.existsSync(dir) ? countTree(dir) : { files: 0, dirs: 0, bytes: 0, exts: {} };
    discoveryRows.push({
      sourcePath: dir,
      purpose: `CrawlSession ${s.role}`,
      files: stats.files,
      dirs: stats.dirs,
      bytes: stats.bytes,
      artifactTypes: Object.keys(stats.exts || {}).slice(0, 20),
      classification: s.role,
      status: s.importance === 'canonical' ? 'canonical' : 'session',
      organizedDestination: `03-sessions/by-id/${s.id}/ + role-specific domains`,
      notes: s.reason,
      sourceType: s.sourceType,
      pagesCount: s.pagesCount,
      diskCounts: s.counts,
    });
  }

  ctx.universitySession = classified.find((s) => s.role === 'university-upload') || null;
  ctx.standaloneSession =
    classified.find((s) => s.role === 'standalone-upload-and-report') ||
    classified.find((s) => s.flags.hasFinalReport) ||
    null;
  ctx.largestCrawl =
    classified.find((s) => s.role === 'largest-live-crawl') ||
    [...classified].sort((a, b) => b.counts.screenshots - a.counts.screenshots)[0];
  ctx.richViewer =
    classified.find((s) => s.role === 'rich-viewer-crawl') ||
    classified.find((s) => s.flags.hasGenerationWorkspace && s.sourceType === 'crawl') ||
    null;

  return classified;
}

// ─── SQLite snapshot & exports ───────────────────────────────────────────────

function createSqliteSnapshot(ctx) {
  const rawDir = ensureDir(path.join(DEST, '02-database', 'raw'));
  const destDb = path.join(rawDir, 'essential-cloud.db');
  log('Creating SQLite snapshot via VACUUM INTO…');
  if (fs.existsSync(destDb)) fs.rmSync(destDb);
  // VACUUM INTO needs writable connection on source — use attach trick from a temp
  execFileSync(
    'sqlite3',
    [ctx.dbPath, `VACUUM INTO '${destDb.replace(/'/g, "''")}';`],
    { stdio: 'inherit' },
  );
  const integrity = execFileSync('sqlite3', [destDb, 'PRAGMA integrity_check;'], {
    encoding: 'utf8',
  }).trim();
  const tables = execFileSync('sqlite3', [destDb, '.tables'], { encoding: 'utf8' })
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort();

  const counts = {};
  for (const t of tables) {
    counts[t] = runSqlite(destDb, `SELECT COUNT(*) AS c FROM "${t}";`, { json: true })[0].c;
  }

  ctx.snapshotDb = destDb;
  ctx.integrity = integrity;
  ctx.snapshotTables = tables;
  ctx.snapshotCounts = counts;
  ctx.snapshotSize = fileSize(destDb);

  writeJson(path.join(DEST, '02-database', 'database-metadata.json'), {
    sourcePath: path.relative(REPO_ROOT, ctx.dbPath),
    snapshotPath: '02-database/raw/essential-cloud.db',
    methodology: 'sqlite3 VACUUM INTO (consistent snapshot)',
    integrity,
    sizeBytes: ctx.snapshotSize,
    tables,
    rowCounts: counts,
    createdAt: new Date().toISOString(),
    projectId: ctx.project.id,
    projectSlug: ctx.project.slug,
  });
  trackGenerated(path.join(DEST, '02-database', 'database-metadata.json'), {
    category: 'database',
    description: 'Snapshot metadata',
  });
  addManifest({
    exportPath: '02-database/raw/essential-cloud.db',
    sourcePath: path.relative(REPO_ROOT, ctx.dbPath),
    category: 'database',
    provenance: 'VACUUM INTO snapshot of backend/prisma/dev.db',
    sizeBytes: ctx.snapshotSize,
    sha256: sha256FileSync(destDb),
    mode: 'copied',
    description: 'Canonical Essential Cloud SQLite snapshot',
  });

  fs.copyFileSync(ctx.schemaPath, path.join(DEST, '02-database', 'schema.prisma'));
  trackGenerated(path.join(DEST, '02-database', 'schema.prisma'), {
    mode: 'copied',
    sourcePath: path.relative(REPO_ROOT, ctx.schemaPath),
    category: 'database',
  });

  const schemaSql = execFileSync('sqlite3', [destDb, '.schema'], { encoding: 'utf8' });
  writeText(path.join(DEST, '02-database', 'schema.sql'), schemaSql);
  trackGenerated(path.join(DEST, '02-database', 'schema.sql'), { category: 'database' });
}

function exportTableDocs(ctx) {
  const tablesDir = ensureDir(path.join(DEST, '02-database', 'tables'));
  const exportsRoot = ensureDir(path.join(DEST, '02-database', 'exports'));
  const db = ctx.snapshotDb;
  const projectId = ctx.project.id;

  const tableMeta = {
    Project: 'Top-level reverse-engineering project configuration and identity.',
    CrawlSession: 'One crawl/upload/agent run; id matches project-output/<slug>/<id>/.',
    PageCapture: 'Captured page or uploaded artifact indexed as a page.',
    NetworkCall: 'Observed HTTP/XHR/fetch (optional GraphQL) linked to a session/page.',
    EntityModel: 'Inferred domain entities (may mix cloud + standalone signals — verify).',
    WorkflowModel: 'Inferred workflows/state machines (verify against live evidence).',
    Report: 'Pointers to generated report files on disk.',
    AnalysisGraphNode: 'Reverse Forge evidence graph nodes (not University GraphRAG).',
    AnalysisGraphEdge: 'Reverse Forge evidence graph edges.',
    AnalysisFinding: 'Specialist agent findings with optional evidence node IDs.',
  };

  for (const table of ctx.snapshotTables) {
    const info = runSqlite(db, `PRAGMA table_info("${table}");`, { json: true });
    const fk = runSqlite(db, `PRAGMA foreign_key_list("${table}");`, { json: true });
    const idx = runSqlite(db, `PRAGMA index_list("${table}");`, { json: true });
    const count = ctx.snapshotCounts[table] ?? 0;

    const jsonTextCols = info
      .filter((c) => /TEXT/i.test(c.type))
      .map((c) => c.name)
      .filter((n) =>
        /json|payload|body|html|text|properties|fields|states|transitions|summary|headers|analysis|extracted|breadcrumbs|actors|relationships|evidence/i.test(
          n,
        ),
      );

    // Lightweight export rows
    const exportDir = ensureDir(path.join(exportsRoot, table));
    let selectCols = info.map((c) => c.name);
    const heavy = new Set(
      [
        'html',
        'visibleText',
        'accessibilityTree',
        'extractedData',
        'aiAnalysis',
        'responseBody',
        'requestPayload',
        'requestHeaders',
        'responseHeaders',
        'properties',
        'detail',
        'fields',
        'relationships',
        'states',
        'transitions',
        'uploadSummary',
      ].filter((c) => selectCols.includes(c)),
    );

    const lightCols = selectCols.filter((c) => !heavy.has(c));
    const sizeExprs = [...heavy].map((c) => `length(${c}) AS ${c}_bytes`);
    const sqlCols = [...lightCols, ...sizeExprs].join(', ');

    let where = '';
    if (info.some((c) => c.name === 'projectId') && table !== 'Project') {
      where = ` WHERE projectId='${projectId}'`;
    } else if (table === 'CrawlSession') {
      where = ` WHERE projectId='${projectId}'`;
    } else if (table === 'PageCapture' || table === 'NetworkCall') {
      where = ` WHERE crawlSessionId IN (SELECT id FROM CrawlSession WHERE projectId='${projectId}')`;
    }

    const limit =
      table === 'AnalysisGraphNode' || table === 'AnalysisGraphEdge'
        ? ' LIMIT 5000'
        : table === 'PageCapture' || table === 'NetworkCall'
          ? ' LIMIT 20000'
          : '';

    let rows = [];
    try {
      rows = runSqlite(db, `SELECT ${sqlCols} FROM "${table}"${where}${limit};`, { json: true });
    } catch (e) {
      warnings.push(`Export ${table} failed: ${e.message}`);
      rows = [];
    }

    const jsonlPath = path.join(exportDir, 'rows.jsonl');
    if (fs.existsSync(jsonlPath)) fs.rmSync(jsonlPath);
    const chunk = 500;
    for (let i = 0; i < rows.length; i += chunk) {
      appendJsonl(
        jsonlPath,
        rows.slice(i, i + chunk).map((r) => {
          const o = { ...r };
          for (const k of Object.keys(o)) {
            if (typeof o[k] === 'string') o[k] = redactSensitive(o[k]);
          }
          return o;
        }),
      );
    }

    // CSV of light columns only (first 2000)
    const csvSample = rows.slice(0, 2000);
    const csvHeader = lightCols.join(',');
    const csvLines = [csvHeader];
    for (const r of csvSample) {
      csvLines.push(
        lightCols
          .map((c) => {
            const v = r[c];
            if (v == null) return '';
            const s = redactSensitive(String(v)).replace(/"/g, '""');
            return `"${s}"`;
          })
          .join(','),
      );
    }
    writeText(path.join(exportDir, 'rows.csv'), csvLines.join('\n'));
    writeJson(path.join(exportDir, 'summary.json'), {
      table,
      totalRowsInDb: count,
      exportedRows: rows.length,
      truncated: Boolean(limit),
      lightColumns: lightCols,
      heavyColumnsOmittedContent: [...heavy],
      note: 'Heavy TEXT columns exported as *_bytes length only. Canonical content in essential-cloud.db.',
    });
    writeText(
      path.join(exportDir, 'README.md'),
      `# Export: ${table}\n\nRows in DB: **${count}**\n\nExported lightweight rows: **${rows.length}**\n\nCanonical data: \`02-database/raw/essential-cloud.db\`\n`,
    );

    // Example redacted records
    const examples = runSqlite(db, `SELECT * FROM "${table}"${where} LIMIT 2;`, { json: true }).map(
      (row) => {
        const o = {};
        for (const [k, v] of Object.entries(row)) {
          if (heavy.has(k) && typeof v === 'string') {
            o[k] = `[omitted ${v.length} chars]`;
          } else if (typeof v === 'string') {
            o[k] = redactSensitive(v.length > 400 ? v.slice(0, 400) + '…' : v);
          } else {
            o[k] = v;
          }
        }
        return o;
      },
    );

    writeText(
      path.join(tablesDir, `${table}.md`),
      `# Table: ${table}

## Purpose

${tableMeta[table] || 'See Prisma schema.'}

## Row count (snapshot)

**${count}**

## Columns

| cid | name | type | notnull | pk | dflt |
|----:|------|------|--------:|---:|------|
${info.map((c) => `| ${c.cid} | \`${c.name}\` | ${c.type} | ${c.notnull} | ${c.pk} | ${c.dflt_value ?? ''} |`).join('\n')}

## Foreign keys

${fk.length ? fk.map((f) => `- \`${f.from}\` → \`${f.table}.${f.to}\` (on_delete=${f.on_delete})`).join('\n') : '_None declared._'}

## Indexes

${idx.length ? idx.map((i) => `- \`${i.name}\` unique=${i.unique}`).join('\n') : '_None / only PK._'}

## JSON-as-TEXT columns (interpret carefully)

${jsonTextCols.length ? jsonTextCols.map((c) => `- \`${c}\``).join('\n') : '_None specially flagged._'}

## Essential Cloud notes

- Project filter id: \`${projectId}\`
- \`CrawlSession.id\` aligns with folders under \`99-raw-archive/${EXPECTED.slug}/<id>/\`
- Entity/Workflow models may include standalone-Tomcat-influenced names — cross-check \`14-cross-reference/\`

## Example records (redacted / truncated)

\`\`\`json
${JSON.stringify(examples, null, 2)}
\`\`\`
`,
    );
  }
}

function writeDatabaseGuides(ctx) {
  const dbDir = path.join(DEST, '02-database');
  const pid = ctx.project.id;
  writeText(
    path.join(dbDir, 'README.md'),
    readmeDoc({
      'What this directory contains':
        'First-class SQLite export for Essential Cloud: snapshot DB, Prisma schema, SQL schema dump, per-table docs, lightweight JSONL/CSV exports, and query guides.',
      'Where it came from':
        `Source DB: \`backend/prisma/dev.db\` (${formatBytes(fileSize(ctx.dbPath))}). Snapshot via \`VACUUM INTO\` → \`raw/essential-cloud.db\` (${formatBytes(ctx.snapshotSize)}). Integrity: **${ctx.integrity}**.`,
      'Canonical files':
        '- `raw/essential-cloud.db` — forensic snapshot\n- `schema.prisma` / `schema.sql`\n- `database-metadata.json`',
      'How humans should study it':
        'Start with `HOW-TO-READ-SQLITE.md` and `ESSENTIAL-CLOUD-DATABASE-GUIDE.md`. Use table markdown for column semantics. Prefer SQL over giant JSON dumps for HTML/body fields.',
      'How AI agents should consume it':
        'Query the snapshot DB directly. Use `exports/*/rows.jsonl` for lightweight indexes. Never treat EntityModel/WorkflowModel as proven business truth without live/University cross-check.',
      'Security':
        'DB may contain tokens, cookies, payloads, PII. Do not paste secrets into docs or chat. See root `SECURITY-NOTICE.md`.',
      'Related': '`03-sessions/`, `04-live-application/`, `05-network-and-api/`, `07-analysis-graph/`, `08-agent-findings/`',
    }),
  );
  writeText(
    path.join(dbDir, 'AGENTS.md'),
    agentsDoc({
      title: '02-database',
      authority:
        'SQLite is the structured index of crawls, pages, APIs, graph, and findings. On-disk artifacts under `99-raw-archive/` remain canonical for binaries/HTML/HAR bodies when paths are referenced.',
      prefer: [
        'SQL against `raw/essential-cloud.db`',
        'PageCapture/NetworkCall rows for observed facts',
        'AnalysisFinding for agent conclusions (secondary)',
        'EntityModel/WorkflowModel only after cross-reference',
      ],
      never: [
        'Inferred EntityModel == Essential Cloud business model',
        'Graph node counts imply University GraphRAG',
        'Printing Authorization/Cookie/response bodies into answers',
      ],
      related: ['04-live-application/', '05-network-and-api/', '07-analysis-graph/', '14-cross-reference/'],
    }),
  );

  writeText(
    path.join(dbDir, 'HOW-TO-READ-SQLITE.md'),
    `# How to read Essential Cloud SQLite

\`\`\`bash
cd Essential-Cloud-Study-Pack/02-database/raw
sqlite3 essential-cloud.db
\`\`\`

Inside sqlite3:

\`\`\`sql
.tables
.schema
.headers on
.mode column
\`\`\`

## Project

\`\`\`sql
SELECT id, name, slug, baseUrl FROM Project;
\`\`\`

## Sessions

\`\`\`sql
SELECT id, status, sourceType, pagesCount
FROM CrawlSession
WHERE projectId = '${pid}'
ORDER BY createdAt;
\`\`\`

## Pages (sample)

\`\`\`sql
SELECT id, crawlSessionId, url, title, depth, screenshotPath
FROM PageCapture
WHERE crawlSessionId IN (SELECT id FROM CrawlSession WHERE projectId='${pid}')
LIMIT 20;
\`\`\`

## Network / GraphQL

\`\`\`sql
SELECT method, responseStatus, isGraphQL, graphQLOperationName, count(*) c
FROM NetworkCall
WHERE crawlSessionId IN (SELECT id FROM CrawlSession WHERE projectId='${pid}')
GROUP BY 1,2,3,4
ORDER BY c DESC
LIMIT 50;
\`\`\`

## Findings by agent

\`\`\`sql
SELECT agent, category, COUNT(*)
FROM AnalysisFinding
WHERE projectId = '${pid}'
GROUP BY agent, category;
\`\`\`

## Graph kinds

\`\`\`sql
SELECT kind, COUNT(*) c FROM AnalysisGraphNode WHERE projectId='${pid}' GROUP BY kind ORDER BY c DESC;
SELECT kind, COUNT(*) c FROM AnalysisGraphEdge WHERE projectId='${pid}' GROUP BY kind ORDER BY c DESC;
\`\`\`

## Entities / workflows / reports

\`\`\`sql
SELECT id, name, source FROM EntityModel WHERE projectId='${pid}';
SELECT id, name, entityName, source FROM WorkflowModel WHERE projectId='${pid}';
SELECT id, type, filePath, crawlSessionId FROM Report WHERE projectId='${pid}';
\`\`\`

## Upload sessions

\`\`\`sql
SELECT id, pagesCount, substr(uploadSummary,1,200) FROM CrawlSession
WHERE projectId='${pid}' AND sourceType='upload';
\`\`\`
`,
  );

  writeText(
    path.join(dbDir, 'DATABASE-OVERVIEW.md'),
    `# Database overview

| Metric | Value |
|--------|------:|
| Snapshot size | ${formatBytes(ctx.snapshotSize)} |
| Integrity | ${ctx.integrity} |
| Tables | ${ctx.snapshotTables.length} |
| Project rows | ${ctx.snapshotCounts.Project} |
| CrawlSession | ${ctx.snapshotCounts.CrawlSession} |
| PageCapture | ${ctx.snapshotCounts.PageCapture} |
| NetworkCall | ${ctx.snapshotCounts.NetworkCall} |
| EntityModel | ${ctx.snapshotCounts.EntityModel} |
| WorkflowModel | ${ctx.snapshotCounts.WorkflowModel} |
| Report | ${ctx.snapshotCounts.Report} |
| AnalysisGraphNode | ${ctx.snapshotCounts.AnalysisGraphNode} |
| AnalysisGraphEdge | ${ctx.snapshotCounts.AnalysisGraphEdge} |
| AnalysisFinding | ${ctx.snapshotCounts.AnalysisFinding} |

Crawl vs upload: **${ctx.classifiedSessions.filter((s) => s.sourceType === 'crawl').length}** crawl / **${ctx.classifiedSessions.filter((s) => s.sourceType === 'upload').length}** upload.
`,
  );

  writeText(
    path.join(dbDir, 'DATABASE-SCHEMA.md'),
    `# Database schema

See \`schema.prisma\` (ORM source of truth) and \`schema.sql\` (SQLite dump).

Tables: ${ctx.snapshotTables.map((t) => `\`${t}\``).join(', ')}.
`,
  );

  writeText(
    path.join(dbDir, 'DATABASE-CATALOG.md'),
    `# Database catalog\n\n${ctx.snapshotTables.map((t) => `- [\`${t}\`](tables/${t}.md) — ${ctx.snapshotCounts[t]} rows`).join('\n')}\n`,
  );

  writeText(
    path.join(dbDir, 'TABLE-RELATIONSHIPS.md'),
    `# Table relationships

\`\`\`
Project 1──* CrawlSession 1──* PageCapture 1──* NetworkCall
                │
                ├──* NetworkCall
                ├──* AnalysisGraphNode
                ├──* AnalysisGraphEdge
                ├──* AnalysisFinding
                └──* Report
Project ── Report
ProjectId on EntityModel / WorkflowModel (logical FK, not enforced in Prisma relation)
\`\`\`

Cascade: deleting Project removes sessions & reports; deleting CrawlSession removes pages, calls, graph, findings.
`,
  );

  writeText(
    path.join(dbDir, 'ESSENTIAL-CLOUD-DATABASE-GUIDE.md'),
    `# Essential Cloud database guide

## Identity

- **Name:** ${ctx.project.name}
- **ID:** \`${ctx.project.id}\`
- **Slug:** \`${ctx.project.slug}\`
- **Base URL:** ${ctx.project.baseUrl}

## Session ↔ disk

Every \`CrawlSession.id\` maps to:

\`99-raw-archive/${EXPECTED.slug}/<session-id>/\`

## High-value sessions

| Role | Session ID |
|------|------------|
| University | \`${ctx.universitySession?.id || 'n/a'}\` |
| Standalone + final report | \`${ctx.standaloneSession?.id || 'n/a'}\` |
| Largest crawl | \`${ctx.largestCrawl?.id || 'n/a'}\` |
| Rich Viewer | \`${ctx.richViewer?.id || 'n/a'}\` |

## Warning on inferred models

Entity/workflow rows currently include Tomcat-oriented names (e.g. Tomcat Server, HttpSession). Treat as **hypothesis**, not cloud domain truth, until confirmed in \`14-cross-reference/\`.
`,
  );

  // queries folder
  const qdir = ensureDir(path.join(dbDir, 'queries'));
  writeText(
    path.join(qdir, 'useful-queries.sql'),
    `-- Essential Cloud useful queries\n-- projectId = ${pid}\n\nSELECT id, status, sourceType, pagesCount FROM CrawlSession WHERE projectId='${pid}';\n`,
  );
}

// ─── Raw archive ─────────────────────────────────────────────────────────────

function exportRawArchive(ctx) {
  const dest = path.join(DEST, '99-raw-archive', EXPECTED.slug);
  log(`Cloning project-output → raw archive (${formatBytes(ctx.poStats.bytes)})…`);
  ensureDir(path.join(DEST, '99-raw-archive'));
  cloneOrCopy(ctx.projectOutput, dest);
  const stats = countTree(dest);
  ctx.rawArchiveStats = stats;
  sourceMap.push({
    organized: `99-raw-archive/${EXPECTED.slug}/`,
    original: path.relative(REPO_ROOT, ctx.projectOutput),
    classification: 'raw-archive',
    reason: 'Byte-preserving forensic mirror of entire project-output tree',
  });
  addManifest({
    exportPath: `99-raw-archive/${EXPECTED.slug}/`,
    sourcePath: path.relative(REPO_ROOT, ctx.projectOutput),
    category: 'raw-archive',
    provenance: 'clone/copy of project-output',
    sizeBytes: stats.bytes,
    sha256: '',
    mode: 'copied',
    description: `Raw archive (${stats.files} files)`,
  });
  writeText(
    path.join(DEST, '99-raw-archive', 'README.md'),
    readmeDoc({
      'What this directory contains':
        'Untouched structural mirror of `backend/project-output/essential-cloud-1787255177369/`.',
      'Canonical status': 'Forensic raw archive. Prefer organized domains for study; use this for path fidelity and completeness.',
      'Security': 'May contain secrets in HAR/HTML/JSON. Do not publish.',
      'Related': 'All `0x-*` organized domains',
    }),
  );
  writeText(
    path.join(DEST, '99-raw-archive', 'AGENTS.md'),
    agentsDoc({
      title: '99-raw-archive',
      authority: 'Original Reverse Forge output layout. Authoritative for original relative paths.',
      prefer: ['Organized domain copies/indexes when available', 'Raw archive when verifying provenance paths'],
      never: ['Mutating files here', 'Assuming Tomcat howto HTML at session root is live crawl HTML'],
      related: ['SOURCE-MAP.md', 'DISCOVERY-INVENTORY.md'],
    }),
  );
}

function rawSessionPath(sessionId, ...parts) {
  return path.join(DEST, '99-raw-archive', EXPECTED.slug, sessionId, ...parts);
}

// ─── Sessions catalog ────────────────────────────────────────────────────────

function exportSessions(ctx) {
  const dir = ensureDir(path.join(DEST, '03-sessions'));
  const byId = ensureDir(path.join(dir, 'by-id'));
  const catalog = [];

  for (const s of ctx.classifiedSessions) {
    const entry = {
      sessionId: s.id,
      sourceType: s.sourceType,
      status: s.status,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      pagesCount: s.pagesCount,
      diskArtifactCounts: s.counts,
      flags: s.flags,
      role: s.role,
      importance: s.importance,
      reason: s.reason,
      rawPath: `99-raw-archive/${EXPECTED.slug}/${s.id}/`,
      uploadSummary: s.uploadSummaryParsed,
    };
    catalog.push(entry);
    const sd = ensureDir(path.join(byId, s.id));
    writeJson(path.join(sd, 'session.json'), entry);
    writeText(
      path.join(sd, 'README.md'),
      `# Session \`${s.id}\`\n\n- **Role:** ${s.role}\n- **Importance:** ${s.importance}\n- **sourceType:** ${s.sourceType}\n- **status:** ${s.status}\n- **pagesCount (DB):** ${s.pagesCount}\n\n## Disk counts\n\n${Object.entries(s.counts)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n')}\n\n## Reason\n\n${s.reason}\n\n## Raw path\n\n\`${entry.rawPath}\`\n`,
    );
    // symlink to raw
    safeRelativeSymlink(rawSessionPath(s.id), path.join(sd, 'raw'));
  }

  writeJson(path.join(dir, 'SESSION-CATALOG.json'), {
    projectId: ctx.project.id,
    count: catalog.length,
    crawl: catalog.filter((c) => c.sourceType === 'crawl').length,
    upload: catalog.filter((c) => c.sourceType === 'upload').length,
    sessions: catalog,
  });

  writeText(
    path.join(dir, 'SESSION-CATALOG.md'),
    `# Session catalog\n\nTotal: **${catalog.length}** (**${catalog.filter((c) => c.sourceType === 'crawl').length}** crawl / **${catalog.filter((c) => c.sourceType === 'upload').length}** upload)\n\n| Session | Type | Role | Importance | pagesCount | screenshots | reports | notes |\n|---------|------|------|------------|----------:|------------:|--------:|-------|\n${catalog
      .map(
        (c) =>
          `| \`${c.sessionId}\` | ${c.sourceType} | ${c.role} | ${c.importance} | ${c.pagesCount} | ${c.diskArtifactCounts.screenshots} | ${c.diskArtifactCounts.reports} | ${c.reason.replace(/\|/g, '/')} |`,
      )
      .join('\n')}\n`,
  );

  writeText(
    path.join(dir, 'README.md'),
    readmeDoc({
      'What this directory contains': 'Classification and catalog of all CrawlSession rows + per-session cards with symlinks into the raw archive.',
      'Canonical files': '`SESSION-CATALOG.md`, `SESSION-CATALOG.json`, `by-id/<uuid>/`',
      'Related': '04-live-application, 12-essential-university, 13-standalone-essential-v6.2.11, 10-final-reports',
    }),
  );
  writeText(
    path.join(dir, 'AGENTS.md'),
    agentsDoc({
      title: '03-sessions',
      authority: 'Session roles are inferred from DB sourceType + on-disk signals (KB, standalone, final-report, counts).',
      prefer: ['SESSION-CATALOG.json for machine use', 'by-id/*/raw for original files'],
      never: ['Every session is a website crawl', 'Empty screenshot sessions imply failed project'],
      related: ['02-database/', '99-raw-archive/'],
    }),
  );
}

// Continue in part 2 - live app, network, university, standalone, etc.
export {
  REPO_ROOT,
  DEST,
  BACKEND,
  EXPECTED,
  INCLUDE_SENSITIVE,
  warnings,
  manifest,
  sourceMap,
  discoveryRows,
  startedAt,
  log,
  addManifest,
  trackGenerated,
  agentsDoc,
  readmeDoc,
  discoverRepository,
  inventorySource,
  createSqliteSnapshot,
  exportTableDocs,
  writeDatabaseGuides,
  exportRawArchive,
  exportSessions,
  rawSessionPath,
  classifySession,
};
