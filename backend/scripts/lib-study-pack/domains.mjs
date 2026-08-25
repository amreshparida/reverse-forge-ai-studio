import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ensureDir,
  writeText,
  writeJson,
  appendJsonl,
  fileSize,
  safeRelativeSymlink,
  countTree,
  formatBytes,
  redactSensitive,
  runSqlite,
} from './fs-utils.mjs';
import {
  DEST,
  EXPECTED,
  warnings,
  sourceMap,
  trackGenerated,
  agentsDoc,
  readmeDoc,
  addManifest,
  rawSessionPath,
} from './core.mjs';

function linkOrNote(targetAbs, linkAbs, label) {
  if (!fs.existsSync(targetAbs)) {
    writeText(linkAbs + '.MISSING.md', `# Missing\n\nExpected ${label} at \`${targetAbs}\`\n`);
    return false;
  }
  safeRelativeSymlink(targetAbs, linkAbs);
  return true;
}

export function exportLiveApplication(ctx) {
  const dir = ensureDir(path.join(DEST, '04-live-application'));
  const db = ctx.snapshotDb;
  const pid = ctx.project.id;

  for (const sub of ['screenshots', 'html', 'pages', 'js-intelligence', 'analysis']) {
    ensureDir(path.join(dir, sub));
  }

  const crawlSessions = ctx.classifiedSessions.filter((s) => s.sourceType === 'crawl');
  for (const s of crawlSessions) {
    for (const folder of ['screenshots', 'html', 'pages', 'analysis']) {
      const src = rawSessionPath(s.id, folder);
      if (fs.existsSync(src)) {
        linkOrNote(src, path.join(dir, folder, s.id), folder);
      }
    }
  }

  // Page catalog from DB + disk
  const pages = runSqlite(
    db,
    `SELECT id, crawlSessionId, url, title, breadcrumbs, screenshotPath, fullScreenshotPath, depth, loadTimeMs, createdAt,
            length(html) AS htmlBytes, length(visibleText) AS visibleTextBytes,
            length(extractedData) AS extractedDataBytes, length(aiAnalysis) AS aiAnalysisBytes
     FROM PageCapture
     WHERE crawlSessionId IN (SELECT id FROM CrawlSession WHERE projectId='${pid}')
     ORDER BY createdAt;`,
    { json: true },
  );

  const pageCatalogPath = path.join(dir, 'PAGE-CATALOG.jsonl');
  if (fs.existsSync(pageCatalogPath)) fs.rmSync(pageCatalogPath);

  const jsIntelIndex = [];
  const urlCounts = Object.create(null);

  for (const p of pages) {
    const session = ctx.classifiedSessions.find((s) => s.id === p.crawlSessionId);
    const pagesDir = rawSessionPath(p.crawlSessionId, 'pages');
    let pageJsonPath = null;
    let jsIntelPath = null;
    let htmlPath = null;
    let harPath = null;
    let apiPath = null;

    // Best-effort match by screenshot basename
    if (p.screenshotPath) {
      const base = path.basename(p.screenshotPath, path.extname(p.screenshotPath));
      const candidates = [
        path.join(pagesDir, `${base}.json`),
        path.join(pagesDir, `${base}-js-intel.json`),
      ];
      if (fs.existsSync(candidates[0])) pageJsonPath = `99-raw-archive/${EXPECTED.slug}/${p.crawlSessionId}/pages/${base}.json`;
      if (fs.existsSync(candidates[1])) {
        jsIntelPath = `99-raw-archive/${EXPECTED.slug}/${p.crawlSessionId}/pages/${base}-js-intel.json`;
        try {
          const intel = JSON.parse(fs.readFileSync(path.join(pagesDir, `${base}-js-intel.json`), 'utf8'));
          jsIntelIndex.push({
            sessionId: p.crawlSessionId,
            pageCaptureId: p.id,
            url: p.url,
            path: jsIntelPath,
            keys: Object.keys(intel),
            externalScripts: (intel.externalScripts || []).length,
            inlineScripts: (intel.inlineScripts || []).length,
            clientRoutes: (intel.clientRoutes || []).length,
            reactComponents: (intel.reactComponents || []).length,
            vueComponents: (intel.vueComponents || []).length,
            webSockets: (intel.webSockets || []).length,
            webWorkers: (intel.webWorkers || []).length,
          });
        } catch {
          /* ignore */
        }
      }
      const htmlFile = rawSessionPath(p.crawlSessionId, 'html', `${base}.html`);
      if (fs.existsSync(htmlFile)) htmlPath = `99-raw-archive/${EXPECTED.slug}/${p.crawlSessionId}/html/${base}.html`;
      const harFile = rawSessionPath(p.crawlSessionId, 'har', `${base}.har`);
      if (fs.existsSync(harFile)) harPath = `99-raw-archive/${EXPECTED.slug}/${p.crawlSessionId}/har/${base}.har`;
      const apiFile = rawSessionPath(p.crawlSessionId, 'api', `${base}-api.json`);
      if (fs.existsSync(apiFile)) apiPath = `99-raw-archive/${EXPECTED.slug}/${p.crawlSessionId}/api/${base}-api.json`;
    }

    const hostPath = (() => {
      try {
        return new URL(p.url).pathname;
      } catch {
        return p.url;
      }
    })();
    urlCounts[hostPath] = (urlCounts[hostPath] || 0) + 1;

    appendJsonl(pageCatalogPath, [
      {
        pageCaptureId: p.id,
        sessionId: p.crawlSessionId,
        sourceType: session?.sourceType || null,
        url: p.url,
        title: p.title,
        depth: p.depth,
        breadcrumbs: p.breadcrumbs,
        screenshotPath: p.screenshotPath,
        fullScreenshotPath: p.fullScreenshotPath,
        htmlPath,
        pageJsonPath,
        jsIntelPath,
        harPath,
        apiSummaryPath: apiPath,
        aiAnalysisBytes: p.aiAnalysisBytes,
        extractedDataBytes: p.extractedDataBytes,
        htmlBytes: p.htmlBytes,
        loadTimeMs: p.loadTimeMs,
        createdAt: p.createdAt,
      },
    ]);
  }

  writeJson(path.join(dir, 'js-intelligence', 'JS-INTEL-INDEX.json'), {
    count: jsIntelIndex.length,
    entries: jsIntelIndex,
  });

  const topUrls = Object.entries(urlCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100);

  writeText(
    path.join(dir, 'PAGE-CATALOG.md'),
    `# Page catalog\n\nTotal PageCapture rows: **${pages.length}**\n\nJS-intel files indexed: **${jsIntelIndex.length}**\n\nSee \`PAGE-CATALOG.jsonl\` for full machine catalog.\n\nLive crawl sessions mirrored under \`screenshots/<sessionId>/\`, \`html/\`, \`pages/\`, \`analysis/\` (symlinks into raw archive).\n`,
  );
  writeText(
    path.join(dir, 'URL-CATALOG.md'),
    `# URL catalog (pathname frequencies)\n\n| Count | Pathname |\n|------:|----------|\n${topUrls.map(([u, c]) => `| ${c} | \`${u.replace(/\|/g, '/')}\` |`).join('\n')}\n`,
  );

  writeText(
    path.join(dir, 'README.md'),
    readmeDoc({
      'What this directory contains':
        'Organized live Essential Cloud application evidence: page catalog, URL catalog, JS intelligence index, and per-session symlinks to screenshots/HTML/pages/analysis.',
      'Where it came from': 'SQLite PageCapture + on-disk session folders under crawl sessions.',
      'Canonical files': '`PAGE-CATALOG.jsonl`, session symlinks into `99-raw-archive/`.',
      'Upload pages': 'Includes `upload://…` PageCapture rows — not live browser URLs.',
      'Related': '05-network-and-api, 03-sessions, 02-database',
    }),
  );
  writeText(
    path.join(dir, 'AGENTS.md'),
    agentsDoc({
      title: '04-live-application',
      authority: 'For “what did the deployed system do?”, prefer screenshots → HTML → page JSON → JS intel → SQLite PageCapture.',
      prefer: ['PAGE-CATALOG.jsonl', 'screenshots/<session>/', 'pages/<session>/'],
      never: ['University docs describe the live UI without checking screenshots', 'upload:// pages are browser navigations'],
      related: ['05-network-and-api/', '12-essential-university/', '14-cross-reference/'],
    }),
  );

  sourceMap.push({
    organized: '04-live-application/',
    original: `backend/project-output/${EXPECTED.slug}/<crawl-sessions>/{screenshots,html,pages,analysis}`,
    classification: 'organized-index+symlinks',
    reason: 'Live UI evidence with provenance via session id folders',
  });

  ctx.pageCount = pages.length;
  ctx.jsIntelCount = jsIntelIndex.length;
}

export function exportNetwork(ctx) {
  const dir = ensureDir(path.join(DEST, '05-network-and-api'));
  ensureDir(path.join(dir, 'api-summaries'));
  ensureDir(path.join(dir, 'har'));
  const db = ctx.snapshotDb;
  const pid = ctx.project.id;

  for (const s of ctx.classifiedSessions) {
    for (const [folder, destSub] of [
      ['api', 'api-summaries'],
      ['har', 'har'],
    ]) {
      const src = rawSessionPath(s.id, folder);
      if (fs.existsSync(src)) linkOrNote(src, path.join(dir, destSub, s.id), folder);
    }
  }

  const calls = runSqlite(
    db,
    `SELECT id, crawlSessionId, pageCaptureId, method, url, responseStatus, resourceType, isGraphQL, graphQLOperationName,
            timingMs, requestContentType, responseContentType,
            length(requestPayload) AS requestPayloadBytes,
            length(responseBody) AS responseBodyBytes,
            length(requestHeaders) AS requestHeadersBytes,
            length(responseHeaders) AS responseHeadersBytes
     FROM NetworkCall
     WHERE crawlSessionId IN (SELECT id FROM CrawlSession WHERE projectId='${pid}');`,
    { json: true },
  );

  const apiCatalog = path.join(dir, 'API-CATALOG.jsonl');
  if (fs.existsSync(apiCatalog)) fs.rmSync(apiCatalog);

  const endpointGroups = Object.create(null);
  const statusSummary = Object.create(null);
  const graphql = [];
  const normalized = Object.create(null);

  function normalizeUrl(u) {
    try {
      const x = new URL(u);
      const norm = x.pathname
        .replace(/[0-9a-f]{8,}/gi, ':id')
        .replace(/\/\d+/g, '/:id');
      return `${x.origin}${norm}`;
    } catch {
      return u;
    }
  }

  for (const c of calls) {
    const rec = {
      networkCallId: c.id,
      sessionId: c.crawlSessionId,
      pageCaptureId: c.pageCaptureId,
      method: c.method,
      url: c.url,
      normalizedEndpoint: normalizeUrl(c.url),
      responseStatus: c.responseStatus,
      resourceType: c.resourceType,
      isGraphQL: !!c.isGraphQL,
      graphQLOperationName: c.graphQLOperationName,
      timingMs: c.timingMs,
      requestPayloadBytes: c.requestPayloadBytes,
      responseBodyBytes: c.responseBodyBytes,
      note: 'Headers/bodies redacted from catalog; see raw HAR/DB under controlled access',
    };
    appendJsonl(apiCatalog, [rec]);

    const key = `${c.method || 'GET'} ${rec.normalizedEndpoint}`;
    endpointGroups[key] = (endpointGroups[key] || 0) + 1;
    normalized[rec.normalizedEndpoint] = (normalized[rec.normalizedEndpoint] || 0) + 1;
    const st = String(c.responseStatus ?? 'null');
    statusSummary[st] = (statusSummary[st] || 0) + 1;
    if (c.isGraphQL) graphql.push(rec);
  }

  // har-intelligence if present
  const harIntelPaths = [];
  for (const s of ctx.classifiedSessions) {
    const p = rawSessionPath(s.id, 'reports', 'har-intelligence.json');
    if (fs.existsSync(p)) harIntelPaths.push(`99-raw-archive/${EXPECTED.slug}/${s.id}/reports/har-intelligence.json`);
  }

  writeText(
    path.join(dir, 'API-CATALOG.md'),
    `# API catalog\n\nNetworkCall rows: **${calls.length}**\n\nGraphQL-flagged: **${graphql.length}**\n\nFull machine catalog: \`API-CATALOG.jsonl\` (URLs preserved; secrets not included).\n\nHAR intelligence files: ${harIntelPaths.map((p) => `\`${p}\``).join(', ') || '_none_'}\n\n**Security:** Raw HAR under \`har/<sessionId>/\` may contain cookies/tokens. Do not paste into docs.\n`,
  );
  writeJson(path.join(dir, 'GRAPHQL-CATALOG.json'), { count: graphql.length, sample: graphql.slice(0, 50) });
  writeText(
    path.join(dir, 'GRAPHQL-CATALOG.md'),
    `# GraphQL catalog\n\nFlagged calls: **${graphql.length}**\n\nSee \`GRAPHQL-CATALOG.json\` for samples.\n`,
  );
  writeText(
    path.join(dir, 'ENDPOINT-GROUPS.md'),
    `# Endpoint groups (normalized)\n\nNormalization is **derived** — original URLs remain in \`API-CATALOG.jsonl\`.\n\n| Count | Method + normalized |\n|------:|---------------------|\n${Object.entries(endpointGroups)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 150)
      .map(([k, c]) => `| ${c} | \`${k.replace(/\|/g, '/')}\` |`)
      .join('\n')}\n`,
  );
  writeText(
    path.join(dir, 'STATUS-SUMMARY.md'),
    `# HTTP status summary\n\n| Status | Count |\n|-------:|------:|\n${Object.entries(statusSummary)
      .sort((a, b) => b[1] - a[1])
      .map(([s, c]) => `| ${s} | ${c} |`)
      .join('\n')}\n`,
  );

  writeText(
    path.join(dir, 'README.md'),
    readmeDoc({
      'What this directory contains': 'Network/API catalogs from NetworkCall + per-session API JSON and HAR symlinks.',
      'Canonical': '`API-CATALOG.jsonl`, raw HAR in `har/<session>/` (sensitive).',
      'Security': 'Never dump Authorization/Cookie/Set-Cookie into Markdown. Redact examples.',
      'Related': '04-live-application, 02-database, 99-raw-archive',
    }),
  );
  writeText(
    path.join(dir, 'AGENTS.md'),
    agentsDoc({
      title: '05-network-and-api',
      authority: 'Observed network behavior: NetworkCall + HAR > inferred API docs in reports.',
      prefer: ['API-CATALOG.jsonl', 'HAR files for proof', 'har-intelligence.json when present'],
      never: ['Printing secrets from HAR', 'Assuming standalone v6.2.11 endpoints == cloud endpoints'],
      related: ['13-standalone-essential-v6.2.11/', '14-cross-reference/'],
    }),
  );

  ctx.networkCallCount = calls.length;
  ctx.harFileCount = 0;
  for (const s of ctx.classifiedSessions) {
    const harDir = rawSessionPath(s.id, 'har');
    if (fs.existsSync(harDir)) ctx.harFileCount += countTree(harDir).files;
  }
}

export function exportUniversity(ctx) {
  const dir = ensureDir(path.join(DEST, '12-essential-university'));
  const s = ctx.universitySession;
  if (!s) {
    warnings.push('No University session detected');
    writeText(path.join(dir, 'README.md'), '# Essential University\n\n_No university upload session found._\n');
    return;
  }

  const kbSrc = rawSessionPath(s.id, 'knowledge-base');
  const originalSrc = rawSessionPath(s.id, 'uploaded-evidence', 'essential-university');

  linkOrNote(kbSrc, path.join(dir, 'canonical-kb'), 'knowledge-base');
  linkOrNote(originalSrc, path.join(dir, 'original'), 'essential-university upload');

  // Also expose standard subfolder symlinks for convenience
  for (const sub of ['ingestion', 'structured', 'graph', 'markdown', 'assets', 'indexes', 'reports', 'canonical']) {
    const t = path.join(kbSrc, sub);
    if (fs.existsSync(t)) linkOrNote(t, path.join(dir, sub === 'canonical' ? 'canonical-markdown' : sub), sub);
  }
  const tools = path.join(originalSrc, 'tools');
  if (fs.existsSync(tools)) linkOrNote(tools, path.join(dir, 'tooling'), 'tools');

  let manifest = {};
  const manifestPath = path.join(kbSrc, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  ctx.universityManifest = manifest;

  // Copy indexes as real JSON for AI (small)
  const indexDir = path.join(kbSrc, 'indexes');
  const catalogs = {};
  if (fs.existsSync(indexDir)) {
    for (const f of fs.readdirSync(indexDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        catalogs[f] = JSON.parse(fs.readFileSync(path.join(indexDir, f), 'utf8'));
      } catch {
        catalogs[f] = { error: 'parse failed' };
      }
    }
  }

  writeJson(path.join(dir, 'UNIVERSITY-CATALOG.json'), {
    sessionId: s.id,
    manifest,
    indexFiles: Object.keys(catalogs),
    primaryRag: 'canonical-kb/ingestion/chunks.jsonl',
    structured: 'canonical-kb/structured/knowledge.jsonl',
    graphNodes: 'canonical-kb/graph/nodes.jsonl',
    graphEdges: 'canonical-kb/graph/edges.jsonl',
  });

  function writeIndexMd(name, data) {
    const keys = data && typeof data === 'object' ? Object.keys(data).slice(0, 50) : [];
    writeText(
      path.join(dir, name),
      `# ${name.replace('.md', '')}\n\nSource index under \`canonical-kb/indexes/\`.\n\nTop-level keys/entries (sample): ${keys.length}\n\nUse the JSON indexes in \`canonical-kb/indexes/\` for full data.\n`,
    );
  }
  writeIndexMd('TOPIC-INDEX.md', catalogs['topic-index.json']);
  writeIndexMd('CONCEPT-INDEX.md', catalogs['concept-index.json']);
  writeIndexMd('ENTITY-INDEX.md', catalogs['entity-index.json']);
  writeIndexMd('VIDEO-INDEX.md', catalogs['video-index.json']);
  writeIndexMd('DOCUMENT-INDEX.md', catalogs['source-index.json']);

  const stats = manifest.statistics || {};
  writeText(
    path.join(dir, 'UNIVERSITY-CATALOG.md'),
    `# Essential University catalog

## Session

\`${s.id}\`

## Pipeline

\`\`\`
raw University input (original/)
        ↓
KB builder (tooling/build_kb)
        ↓
canonical knowledge-base (canonical-kb/)
\`\`\`

## Manifest statistics (from knowledge-base/manifest.json)

| Metric | Value |
|--------|------:|
| chunks | ${stats.chunks ?? 'n/a'} |
| entities | ${stats.entities ?? 'n/a'} |
| concepts | ${stats.concepts ?? 'n/a'} |
| topics | ${stats.topics ?? 'n/a'} |
| videos | ${stats.videos ?? 'n/a'} |
| document_images | ${stats.document_images ?? 'n/a'} |
| video_frames | ${stats.video_frames ?? 'n/a'} |
| document_sections | ${stats.document_sections ?? 'n/a'} |

## Primary RAG file

\`canonical-kb/ingestion/chunks.jsonl\`

## GraphRAG (University — NOT Reverse Forge AnalysisGraph)

- \`canonical-kb/graph/nodes.jsonl\`
- \`canonical-kb/graph/edges.jsonl\`

These are distinct from SQLite \`AnalysisGraphNode\` / \`AnalysisGraphEdge\`.
`,
  );

  writeText(
    path.join(dir, 'README.md'),
    readmeDoc({
      'What this directory contains': 'Essential University as a first-class knowledge domain: raw upload + canonical KB + indexes.',
      'Authority': 'For “what does an Essential concept mean?”, prefer University KB over inferred models.',
      'Do not rebuild': 'Canonical KB already exists; this export preserves it.',
      'Related': '14-cross-reference (University vs observed vs standalone)',
    }),
  );
  writeText(
    path.join(dir, 'AGENTS.md'),
    agentsDoc({
      title: '12-essential-university',
      authority: 'Semantic/conceptual authority for Essential product language.',
      prefer: [
        'canonical-kb/ingestion/chunks.jsonl',
        'canonical-kb/structured/knowledge.jsonl',
        'canonical-kb/graph/*',
        'original/ only for provenance rebuild',
      ],
      never: [
        'University feature = observed cloud deployment feature',
        'Confusing University GraphRAG with AnalysisGraphNode/Edge',
      ],
      related: ['04-live-application/', '13-standalone-essential-v6.2.11/', '14-cross-reference/'],
    }),
  );

  sourceMap.push({
    organized: '12-essential-university/canonical-kb/',
    original: `backend/project-output/${EXPECTED.slug}/${s.id}/knowledge-base/`,
    classification: 'canonical-kb',
    reason: 'Authoritative generated University knowledge base',
  });
  sourceMap.push({
    organized: '12-essential-university/original/',
    original: `backend/project-output/${EXPECTED.slug}/${s.id}/uploaded-evidence/essential-university/`,
    classification: 'raw-university-input',
    reason: 'Raw University package prior to KB build',
  });
}

export function exportStandalone(ctx) {
  const dir = ensureDir(path.join(DEST, '13-standalone-essential-v6.2.11'));
  const s = ctx.standaloneSession;
  if (!s) {
    warnings.push('No standalone session detected');
    writeText(path.join(dir, 'README.md'), '# Standalone Essential\n\n_Not found._\n');
    return;
  }

  const pkg = rawSessionPath(s.id, 'uploaded-evidence', 'standalone_essential_v6211');
  linkOrNote(pkg, path.join(dir, 'package'), 'standalone package');
  ensureDir(path.join(dir, 'analysis'));

  const inventory = { files: 0, dirs: 0, bytes: 0, war: [], jarsSample: [], javaCount: 0, jsCount: 0, xmlCount: 0, modules: [] };
  if (fs.existsSync(pkg)) {
    const stats = countTree(pkg);
    inventory.files = stats.files;
    inventory.dirs = stats.dirs;
    inventory.bytes = stats.bytes;
    inventory.modules = fs.readdirSync(pkg).filter((n) => fs.statSync(path.join(pkg, n)).isDirectory() || n.endsWith('.md') || n.endsWith('.html'));

    function walkFind(root, pred, limit = 50) {
      const out = [];
      function w(d) {
        if (out.length >= limit) return;
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, ent.name);
          if (ent.isDirectory()) w(f);
          else if (pred(ent.name, f)) out.push(path.relative(pkg, f));
          if (out.length >= limit) return;
        }
      }
      w(root);
      return out;
    }
    inventory.war = walkFind(pkg, (n) => n.endsWith('.war'), 20);
    inventory.jarsSample = walkFind(pkg, (n) => n.endsWith('.jar'), 30);
    inventory.javaCount = walkFind(pkg, (n) => n.endsWith('.java'), 10000).length;
    inventory.jsCount = walkFind(pkg, (n) => n.endsWith('.js'), 10000).length;
    inventory.xmlCount = walkFind(pkg, (n) => n.endsWith('.xml'), 10000).length;

    // webapps
    const webapps = path.join(pkg, 'tomcat', 'webapps');
    inventory.webapps = fs.existsSync(webapps) ? fs.readdirSync(webapps) : [];
    const repos = path.join(pkg, 'repositories');
    inventory.repositories = fs.existsSync(repos) ? fs.readdirSync(repos) : [];
  }

  let versionEvidence = 'Essential Open Source Standalone (readme); folder name standalone_essential_v6211 suggests 6.2.11';
  const readme = path.join(pkg, 'readme.md');
  if (fs.existsSync(readme)) {
    const txt = fs.readFileSync(readme, 'utf8');
    writeText(path.join(dir, 'analysis', 'readme-excerpt.md'), txt.slice(0, 4000));
    if (/standalone/i.test(txt)) versionEvidence += ' | readme title confirms Essential Open Source Standalone';
  }

  // Classify session-root Tomcat docs
  const sessionRoot = rawSessionPath(s.id);
  const tomcatDocs = [];
  if (fs.existsSync(sessionRoot)) {
    for (const ent of fs.readdirSync(sessionRoot, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (/\.html$/i.test(ent.name) || /RELEASE-NOTES|BUILDING|RUNNING/i.test(ent.name)) {
        tomcatDocs.push(ent.name);
      }
    }
  }
  writeJson(path.join(dir, 'analysis', 'session-root-tomcat-docs.json'), {
    note: 'Files at session root likely merged from Tomcat docs during evidence import — NOT live crawl HTML',
    files: tomcatDocs,
  });

  writeText(
    path.join(dir, 'PACKAGE-INVENTORY.md'),
    `# Package inventory\n\n- Files: **${inventory.files}**\n- Dirs: **${inventory.dirs}**\n- Size: **${formatBytes(inventory.bytes)}**\n- Java sources found: **${inventory.javaCount}** (mostly examples if Tomcat)\n- WAR files: ${inventory.war.map((w) => `\`${w}\``).join(', ') || '_none_'}\n- Webapps entries: ${inventory.webapps?.map((w) => `\`${w}\``).join(', ')}\n- Repositories: ${inventory.repositories?.map((w) => `\`${w}\``).join(', ')}\n\n## Top-level modules\n\n${inventory.modules.map((m) => `- \`${m}\``).join('\n')}\n`,
  );

  writeText(
    path.join(dir, 'ARCHITECTURE.md'),
    `# Standalone architecture (from package evidence)

\`\`\`
JRE (bundled)
  └── Tomcat
        ├── webapps: essential_viewer.war, essential_import_utility.war, …
        └── conf/lib/bin
Protege (Essential Modeller)
repositories/essential_metamodel (ontology / baseline pins)
\`\`\`

This is a **runnable distribution** (WARs/JARs + ontology), not an Essential Cloud git monorepo.

Observed cloud at \`eag.essentialintelligence.com\` may differ substantially (edition/version/customization).
`,
  );

  writeText(
    path.join(dir, 'VERSION-EVIDENCE.md'),
    `# Version evidence\n\n${versionEvidence}\n\n**Do not claim** the cloud deployment is v6.2.11 without direct evidence.\n`,
  );

  writeText(path.join(dir, 'MODULE-CATALOG.md'), `# Module catalog\n\n${inventory.modules.map((m) => `- \`${m}/\``).join('\n')}\n`);
  writeText(
    path.join(dir, 'WEBAPP-CATALOG.md'),
    `# Webapp catalog\n\n${(inventory.webapps || []).map((w) => `- \`${w}\``).join('\n')}\n\nWARs:\n${inventory.war.map((w) => `- \`${w}\``).join('\n')}\n`,
  );
  writeText(
    path.join(dir, 'REPOSITORY-CATALOG.md'),
    `# Repository catalog\n\n${(inventory.repositories || []).map((r) => `- \`repositories/${r}/\``).join('\n')}\n`,
  );
  writeText(
    path.join(dir, 'ONTOLOGY-CATALOG.md'),
    `# Ontology catalog\n\nPrimary metamodel repository under \`package/repositories/essential_metamodel/\` (Protege \`.pprj\` / \`.pont\` / \`.pins\`).\n`,
  );
  writeText(
    path.join(dir, 'CONFIGURATION-CATALOG.md'),
    `# Configuration catalog\n\nInspect \`package/tomcat/conf/\`, \`package/protege/*.properties\`, and webapp descriptors inside WARs (compiled archives).\n`,
  );
  writeText(
    path.join(dir, 'DEPENDENCY-CATALOG.md'),
    `# Dependency catalog\n\nSample JARs (not exhaustive):\n\n${inventory.jarsSample.map((j) => `- \`${j}\``).join('\n')}\n`,
  );
  writeText(
    path.join(dir, 'BUILD-RUNTIME-NOTES.md'),
    `# Build / runtime notes\n\nStart scripts documented in \`package/readme.md\` (Protege + Tomcat). Bundled JRE under \`package/jre/\`.\n`,
  );
  writeText(
    path.join(dir, 'LICENSE-INVENTORY.md'),
    `# License inventory\n\nSee \`package/protege/licensing.txt\`, \`package/repositories/essential_metamodel/COPYING.txt\`, and third-party notices inside Tomcat/JRE trees.\n`,
  );

  writeText(
    path.join(dir, 'README.md'),
    readmeDoc({
      'What this directory contains':
        'Organized view of Essential Open Source Standalone v6.2.11 distribution. Final reports from the same session live under `10-final-reports/` (separated).',
      'Accurate labeling':
        'Primarily compiled WARs/JARs + ontology + Protege + Tomcat — not full application source code.',
      'Session-root HTML':
        'Tomcat howto HTML at session root is import merge noise — see `analysis/session-root-tomcat-docs.json`.',
      'Related': '10-final-reports, 12-essential-university, 14-cross-reference',
    }),
  );
  writeText(
    path.join(dir, 'AGENTS.md'),
    agentsDoc({
      title: '13-standalone-essential-v6.2.11',
      authority: 'Implementation/runtime evidence for standalone Essential — not automatically cloud behavior.',
      prefer: ['package/readme.md', 'tomcat/webapps', 'repositories/essential_metamodel', 'protege/'],
      never: [
        'standalone v6.2.11 behavior = cloud deployment behavior',
        'Labeling WARs as source code',
        'Treating session-root Tomcat HTML as live crawl pages',
      ],
      related: ['10-final-reports/', '14-cross-reference/', 'VERSION-AND-EDITION-NOTES.md'],
    }),
  );

  ctx.standaloneInventory = inventory;
  ctx.standaloneVersionEvidence = versionEvidence;

  sourceMap.push({
    organized: '13-standalone-essential-v6.2.11/package/',
    original: `backend/project-output/${EXPECTED.slug}/${s.id}/uploaded-evidence/standalone_essential_v6211/`,
    classification: 'standalone-distribution',
    reason: 'Essential Open Source standalone package',
  });
}

export function exportModelsFindingsReports(ctx) {
  // 06 models
  const modelsDir = ensureDir(path.join(DEST, '06-models-and-domain'));
  const db = ctx.snapshotDb;
  const pid = ctx.project.id;

  const entities = runSqlite(db, `SELECT id, name, source, length(fields) fieldsBytes, length(relationships) relBytes FROM EntityModel WHERE projectId='${pid}';`, { json: true });
  const workflows = runSqlite(db, `SELECT id, name, entityName, source, length(states) statesBytes FROM WorkflowModel WHERE projectId='${pid}';`, { json: true });
  writeJson(path.join(modelsDir, 'entity-model-index.json'), entities);
  writeJson(path.join(modelsDir, 'workflow-model-index.json'), workflows);

  // Pull final model JSONs from report session
  const reportSession = ctx.standaloneSession;
  if (reportSession) {
    const reports = rawSessionPath(reportSession.id, 'reports');
    for (const name of [
      'entity-model.json',
      'workflow-model.json',
      'permission-matrix.json',
      'architecture.json',
      'knowledge-graph.json',
      'deep-research.json',
    ]) {
      const src = path.join(reports, name);
      if (fs.existsSync(src)) {
        safeRelativeSymlink(src, path.join(modelsDir, `final-${name}`));
      }
      const gen = path.join(reports, '_generation', name);
      if (fs.existsSync(gen)) safeRelativeSymlink(gen, path.join(modelsDir, `generation-${name}`));
      const ws = path.join(reports, '_generation', 'workspace', name);
      if (fs.existsSync(ws)) safeRelativeSymlink(ws, path.join(modelsDir, `workspace-${name}`));
    }
  }

  writeText(
    path.join(modelsDir, 'README.md'),
    readmeDoc({
      'What': 'Inferred domain models from DB + final/generation/workspace JSON variants from report pipeline.',
      'Warning': 'Entity/workflow names may reflect standalone Tomcat evidence. Cross-check before trusting as Essential Cloud business model.',
      'Variants': '`final-*`, `generation-*`, `workspace-*` are preserved separately — do not overwrite.',
    }),
  );
  writeText(
    path.join(modelsDir, 'AGENTS.md'),
    agentsDoc({
      title: '06-models-and-domain',
      authority: 'Inferred — below live evidence and University semantics.',
      prefer: ['Live pages/APIs', 'University concepts', 'Then these models'],
      never: ['EntityModel == real Essential Cloud business model without verification'],
      related: ['14-cross-reference/', '08-agent-findings/'],
    }),
  );

  // 07 analysis graph
  const gdir = ensureDir(path.join(DEST, '07-analysis-graph'));
  ensureDir(path.join(gdir, 'nodes'));
  ensureDir(path.join(gdir, 'edges'));
  const nodeKinds = runSqlite(db, `SELECT kind, COUNT(*) c FROM AnalysisGraphNode WHERE projectId='${pid}' GROUP BY kind ORDER BY c DESC;`, { json: true });
  const edgeKinds = runSqlite(db, `SELECT kind, COUNT(*) c FROM AnalysisGraphEdge WHERE projectId='${pid}' GROUP BY kind ORDER BY c DESC;`, { json: true });
  writeJson(path.join(gdir, 'nodes', 'kind-summary.json'), nodeKinds);
  writeJson(path.join(gdir, 'edges', 'kind-summary.json'), edgeKinds);

  // sample jsonl
  const nodeSample = runSqlite(db, `SELECT id, crawlSessionId, kind, key, label, confidence, length(properties) propertiesBytes FROM AnalysisGraphNode WHERE projectId='${pid}' LIMIT 5000;`, { json: true });
  const edgeSample = runSqlite(db, `SELECT id, crawlSessionId, fromNodeId, toNodeId, kind, label, confidence FROM AnalysisGraphEdge WHERE projectId='${pid}' LIMIT 5000;`, { json: true });
  const npath = path.join(gdir, 'nodes', 'nodes-sample.jsonl');
  const epath = path.join(gdir, 'edges', 'edges-sample.jsonl');
  if (fs.existsSync(npath)) fs.rmSync(npath);
  if (fs.existsSync(epath)) fs.rmSync(epath);
  appendJsonl(npath, nodeSample);
  appendJsonl(epath, edgeSample);

  const sessionGraph = runSqlite(
    db,
    `SELECT s.id AS crawlSessionId,
      (SELECT COUNT(*) FROM AnalysisGraphNode n WHERE n.crawlSessionId=s.id) AS nodes,
      (SELECT COUNT(*) FROM AnalysisGraphEdge e WHERE e.crawlSessionId=s.id) AS edges
     FROM CrawlSession s WHERE projectId='${pid}';`,
    { json: true },
  );
  writeJson(path.join(gdir, 'SESSION-GRAPH-STATS.json'), sessionGraph);

  writeText(path.join(gdir, 'NODE-KINDS.md'), `# Node kinds\n\n| Kind | Count |\n|------|------:|\n${nodeKinds.map((r) => `| ${r.kind} | ${r.c} |`).join('\n')}\n`);
  writeText(path.join(gdir, 'EDGE-KINDS.md'), `# Edge kinds\n\n| Kind | Count |\n|------|------:|\n${edgeKinds.map((r) => `| ${r.kind} | ${r.c} |`).join('\n')}\n`);
  writeText(path.join(gdir, 'GRAPH-OVERVIEW.md'), `# Analysis graph overview\n\nThis is the **Reverse Forge evidence graph** in SQLite (\`AnalysisGraphNode/Edge\`), **not** University GraphRAG.\n\nNodes: **${ctx.snapshotCounts.AnalysisGraphNode}** · Edges: **${ctx.snapshotCounts.AnalysisGraphEdge}**\n`);
  writeText(path.join(gdir, 'SESSION-GRAPH-STATS.md'), `# Session graph stats\n\nSee \`SESSION-GRAPH-STATS.json\`.\n`);
  writeText(
    path.join(gdir, 'README.md'),
    readmeDoc({
      What: 'Indexes and samples of the Reverse Forge analysis graph.',
      Canonical: 'Full graph in `02-database/raw/essential-cloud.db`',
      Distinction: 'Separate from `12-essential-university/canonical-kb/graph/`',
    }),
  );
  writeText(
    path.join(gdir, 'AGENTS.md'),
    agentsDoc({
      title: '07-analysis-graph',
      authority: 'Derived evidence graph linking pages/APIs/artifacts — secondary to raw captures.',
      prefer: ['kind summaries', 'DB for full graph', 'University graph only for University semantics'],
      never: ['Mixing University GraphRAG edges with AnalysisGraphEdge'],
      related: ['02-database/', '12-essential-university/'],
    }),
  );

  // report-graphs symlink if knowledge-graph exists
  if (reportSession) {
    const kg = rawSessionPath(reportSession.id, 'reports', 'knowledge-graph.json');
    if (fs.existsSync(kg)) {
      ensureDir(path.join(gdir, 'report-graphs'));
      safeRelativeSymlink(kg, path.join(gdir, 'report-graphs', 'knowledge-graph.json'));
    }
  }

  // 08 findings
  const fdir = ensureDir(path.join(DEST, '08-agent-findings'));
  const findings = runSqlite(
    db,
    `SELECT id, crawlSessionId, agent, category, severity, title, substr(detail,1,500) detailPreview, evidenceNodeIds, substr(COALESCE(recommendation,''),1,300) recommendationPreview, confidence
     FROM AnalysisFinding WHERE projectId='${pid}';`,
    { json: true },
  );
  const fjsonl = path.join(fdir, 'FINDING-CATALOG.jsonl');
  if (fs.existsSync(fjsonl)) fs.rmSync(fjsonl);
  appendJsonl(
    fjsonl,
    findings.map((f) => ({
      ...f,
      detailPreview: redactSensitive(f.detailPreview),
      recommendationPreview: redactSensitive(f.recommendationPreview),
    })),
  );

  const byAgent = runSqlite(db, `SELECT agent, category, COUNT(*) c FROM AnalysisFinding WHERE projectId='${pid}' GROUP BY agent, category ORDER BY c DESC;`, { json: true });
  writeText(path.join(fdir, 'AGENT-CATALOG.md'), `# Agent catalog\n\n| Agent | Category | Count |\n|-------|----------|------:|\n${byAgent.map((r) => `| ${r.agent} | ${r.category} | ${r.c} |`).join('\n')}\n`);
  writeText(path.join(fdir, 'FINDING-CATALOG.md'), `# Finding catalog\n\nTotal: **${findings.length}**\n\nSee \`FINDING-CATALOG.jsonl\`.\n`);
  writeText(
    path.join(fdir, 'SEVERITY-SUMMARY.md'),
    `# Severity summary\n\n| Severity | Count |\n|----------|------:|\n${Object.entries(
      findings.reduce((a, f) => {
        const k = f.severity || '(none)';
        a[k] = (a[k] || 0) + 1;
        return a;
      }, {}),
    )
      .map(([k, v]) => `| ${k} | ${v} |`)
      .join('\n')}\n`,
  );

  // agent findings json from reports
  if (reportSession) {
    const reports = rawSessionPath(reportSession.id, 'reports');
    const out = ensureDir(path.join(fdir, 'report-files'));
    if (fs.existsSync(reports)) {
      for (const f of fs.readdirSync(reports)) {
        if (f.endsWith('-agent-findings.json')) {
          safeRelativeSymlink(path.join(reports, f), path.join(out, f));
        }
      }
    }
  }

  writeText(path.join(fdir, 'README.md'), readmeDoc({ What: 'Specialist agent findings from SQLite + report JSON files.', Canonical: 'FINDING-CATALOG.jsonl + DB AnalysisFinding' }));
  writeText(
    path.join(fdir, 'AGENTS.md'),
    agentsDoc({
      title: '08-agent-findings',
      authority: 'Agent conclusions — always below raw screenshots/HAR for factual claims.',
      prefer: ['FINDING-CATALOG.jsonl', 'evidenceNodeIds → analysis graph', 'raw pages/HAR for proof'],
      never: ['Treating findings as observed fact without evidence'],
      related: ['07-analysis-graph/', '09-expert-analysis/', '10-final-reports/'],
    }),
  );

  // 09 expert analysis
  const edir = ensureDir(path.join(DEST, '09-expert-analysis'));
  if (reportSession) {
    const reports = rawSessionPath(reportSession.id, 'reports');
    const chunks = [];
    if (fs.existsSync(reports)) {
      for (const f of fs.readdirSync(reports)) {
        if (/^expert-analysis/i.test(f) || f === 'deep-research.json' || f === 'validation-plan.json' || f === 'traceability-matrix.csv') {
          chunks.push(f);
          safeRelativeSymlink(path.join(reports, f), path.join(edir, f));
        }
      }
    }
    writeJson(path.join(edir, 'EXPERT-MANIFEST.json'), { sessionId: reportSession.id, files: chunks });
    writeText(
      path.join(edir, 'README.md'),
      `# Expert analysis\n\nFiles: **${chunks.length}** (symlinked from raw reports). Includes chunked expert-analysis JSON — do not concatenate into one Markdown.\n\nManifest: \`EXPERT-MANIFEST.json\`\n`,
    );
  } else {
    writeText(path.join(edir, 'README.md'), '# Expert analysis\n\n_No report session._\n');
  }
  writeText(
    path.join(edir, 'AGENTS.md'),
    agentsDoc({
      title: '09-expert-analysis',
      authority: 'Synthesis artifacts — secondary to raw evidence.',
      prefer: ['EXPERT-MANIFEST.json', 'deep-research.json', 'chunk files as needed'],
      never: ['Loading all expert-analysis-chunk files into context at once'],
      related: ['10-final-reports/'],
    }),
  );

  // 10 final reports
  const rdir = ensureDir(path.join(DEST, '10-final-reports'));
  if (reportSession) {
    const reports = rawSessionPath(reportSession.id, 'reports');
    writeText(
      path.join(rdir, 'CANONICAL.md'),
      `# Canonical final report\n\n**Canonical:** \`final-report.md\` (from session \`${reportSession.id}\`)\n\nRaw path: \`99-raw-archive/${EXPECTED.slug}/${reportSession.id}/reports/final-report.md\`\n`,
    );
    for (const f of ['final-report.md', 'REDEVELOPMENT-README.md', 'traceability-matrix.csv', 'validation-plan.json', 'report-run-manifest.json']) {
      const src = path.join(reports, f);
      if (fs.existsSync(src)) safeRelativeSymlink(src, path.join(rdir, f));
    }
    // symlink whole reports dir for completeness but warn about size
    safeRelativeSymlink(reports, path.join(rdir, 'all-reports-raw'));
  }
  writeText(
    path.join(rdir, 'README.md'),
    readmeDoc({
      What: 'Final report pack. Canonical document is final-report.md.',
      Note: 'Same session also hosted standalone upload; package lives under 13-*, reports here.',
    }),
  );
  writeText(
    path.join(rdir, 'AGENTS.md'),
    agentsDoc({
      title: '10-final-reports',
      authority: 'Narrative synthesis — verify claims against live/University/standalone evidence.',
      prefer: ['final-report.md', 'traceability-matrix.csv', 'raw evidence paths cited'],
      never: ['Using final report as sole source of truth'],
      related: ['14-cross-reference/', '08-agent-findings/'],
    }),
  );

  // 11 workspaces
  const wdir = ensureDir(path.join(DEST, '11-generation-workspaces'));
  for (const s of ctx.classifiedSessions.filter((x) => x.flags.hasGenerationWorkspace)) {
    const ws = rawSessionPath(s.id, 'reports', '_generation');
    const out = ensureDir(path.join(wdir, s.id));
    safeRelativeSymlink(ws, path.join(out, '_generation'));
    // copy small key files if present
    for (const rel of ['workspace/MANIFEST.json', 'workspace/EVIDENCE-INDEX.json', 'workspace/coverage-state.json', 'workspace/coverage-final.json']) {
      const src = path.join(ws, rel);
      if (fs.existsSync(src) && fileSize(src) < 5_000_000) {
        fs.copyFileSync(src, path.join(out, path.basename(rel)));
      }
    }
    writeText(
      path.join(out, 'README.md'),
      `# Generation workspace — ${s.id}\n\nSymlink \`_generation/\` → raw archive.\n\nLarge evidence shards (page-analyses, uploaded-evidence mirrors, graph-chunks) are **not re-copied**; use the symlink. Deduplication: authoritative organized evidence remains under 04/05/12/13 + raw archive.\n`,
    );
  }
  writeText(
    path.join(wdir, 'README.md'),
    readmeDoc({
      What: 'Synthesis workspaces (`reports/_generation`).',
      Dedup: 'Pointers/symlinks instead of re-copying mirrored evidence trees.',
    }),
  );
  writeText(
    path.join(wdir, 'AGENTS.md'),
    agentsDoc({
      title: '11-generation-workspaces',
      authority: 'Intermediate synthesis state — not final deliverables.',
      prefer: ['MANIFEST.json', 'EVIDENCE-INDEX.json', '10-final-reports for finals'],
      never: ['Treating workspace mirrors as a second source of truth'],
      related: ['10-final-reports/', '99-raw-archive/'],
    }),
  );

  ctx.findingsCount = findings.length;
  ctx.nodeKinds = nodeKinds;
  ctx.edgeKinds = edgeKinds;
}
