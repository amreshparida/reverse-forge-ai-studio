#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  DEST,
  REPO_ROOT,
  warnings,
  log,
  discoverRepository,
  inventorySource,
  createSqliteSnapshot,
  exportTableDocs,
  writeDatabaseGuides,
  exportRawArchive,
  exportSessions,
} from './lib-study-pack/core.mjs';
import { assertSafeDeleteTarget as safeDelete } from './lib-study-pack/fs-utils.mjs';
import {
  exportLiveApplication,
  exportNetwork,
  exportUniversity,
  exportStandalone,
  exportModelsFindingsReports,
} from './lib-study-pack/domains.mjs';
import {
  exportCrossReference,
  exportAiIngestion,
  exportSensitive,
  writeRootDocs,
  validateExport,
} from './lib-study-pack/finalize.mjs';

async function main() {
  log(`Repo: ${REPO_ROOT}`);
  log(`Destination: ${DEST}`);

  safeDelete(DEST, REPO_ROOT);
  if (fs.existsSync(DEST)) {
    log('Removing existing Essential-Cloud-Study-Pack/ …');
    fs.rmSync(DEST, { recursive: true, force: true });
  }
  fs.mkdirSync(DEST, { recursive: true });

  log('Discovering repository…');
  const ctx = discoverRepository();
  log(`Project: ${ctx.project.name} (${ctx.project.id})`);
  log(`Sessions: ${ctx.sessions.length}`);

  log('Classifying sessions / inventory…');
  inventorySource(ctx);
  log(
    `Roles: university=${ctx.universitySession?.id?.slice(0, 8)} standalone=${ctx.standaloneSession?.id?.slice(0, 8)} largest=${ctx.largestCrawl?.id?.slice(0, 8)} rich=${ctx.richViewer?.id?.slice(0, 8)}`,
  );

  log('SQLite snapshot…');
  createSqliteSnapshot(ctx);
  exportTableDocs(ctx);
  writeDatabaseGuides(ctx);

  log('Raw archive (clone/copy)…');
  exportRawArchive(ctx);

  log('Sessions…');
  exportSessions(ctx);

  log('Live application…');
  exportLiveApplication(ctx);

  log('Network/API…');
  exportNetwork(ctx);

  log('University…');
  exportUniversity(ctx);

  log('Standalone…');
  exportStandalone(ctx);

  log('Models / graph / findings / reports / workspaces…');
  exportModelsFindingsReports(ctx);

  log('Cross-reference…');
  exportCrossReference(ctx);

  log('AI ingestion indexes…');
  exportAiIngestion(ctx);

  log('Sensitive references…');
  exportSensitive(ctx);

  log('Root documentation…');
  writeRootDocs(ctx);

  log('Validating…');
  const validation = validateExport(ctx);

  // Sample manual checks
  const samples = [];
  const pageCat = path.join(DEST, '04-live-application/PAGE-CATALOG.jsonl');
  if (fs.existsSync(pageCat)) {
    const lines = fs.readFileSync(pageCat, 'utf8').trim().split('\n').filter(Boolean);
    samples.push({ pagesSampled: Math.min(5, lines.length), first: JSON.parse(lines[0] || '{}').url });
  }

  const report = {
    Source: path.relative(REPO_ROOT, ctx.projectOutput),
    Destination: 'Essential-Cloud-Study-Pack/',
    ProjectID: ctx.project.id,
    ObservedURL: ctx.project.baseUrl,
    DatabaseSource: path.relative(REPO_ROOT, ctx.dbPath),
    DatabaseSnapshot: '02-database/raw/essential-cloud.db',
    DatabaseSize: ctx.snapshotSize,
    Integrity: ctx.integrity,
    Sessions: {
      total: ctx.classifiedSessions.length,
      crawl: ctx.classifiedSessions.filter((s) => s.sourceType === 'crawl').length,
      upload: ctx.classifiedSessions.filter((s) => s.sourceType === 'upload').length,
    },
    PageCaptures: ctx.snapshotCounts.PageCapture,
    NetworkCalls: ctx.snapshotCounts.NetworkCall,
    HARFiles: ctx.harFileCount,
    AnalysisGraph: {
      nodes: ctx.snapshotCounts.AnalysisGraphNode,
      edges: ctx.snapshotCounts.AnalysisGraphEdge,
    },
    Findings: ctx.snapshotCounts.AnalysisFinding,
    Entities: ctx.snapshotCounts.EntityModel,
    Workflows: ctx.snapshotCounts.WorkflowModel,
    University: ctx.universityManifest?.statistics || null,
    Standalone: {
      files: ctx.standaloneInventory?.files,
      webapps: ctx.standaloneInventory?.webapps,
      repositories: ctx.standaloneInventory?.repositories,
      javaFiles: ctx.standaloneInventory?.javaCount,
      wars: ctx.standaloneInventory?.war,
      versionEvidence: ctx.standaloneVersionEvidence,
    },
    Warnings: warnings,
    Validation: validation.status,
    ValidationFailed: validation.failed,
    Samples: samples,
  };

  fs.writeFileSync(path.join(DEST, '00-overview', 'EXECUTION-REPORT.json'), JSON.stringify(report, null, 2));
  log(`Validation: ${validation.status}`);
  if (validation.failed.length) {
    for (const f of validation.failed) log(`  FAIL: ${f.name} ${f.detail}`);
  }
  for (const w of warnings) log(`  WARN: ${w}`);
  log('Done.');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
