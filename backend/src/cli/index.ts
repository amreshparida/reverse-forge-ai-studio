#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { prisma, connectDatabase, disconnectDatabase } from '../database/client';
import { runCrawl } from '../crawler';
import { waitForLoginAndSaveSession, sessionExists } from '../crawler/session';
import { analyzeSession } from '../ai/analyzer';
import { inferEntities } from '../inference/entity';
import { inferWorkflows } from '../inference/workflow';
import { inferPermissions } from '../inference/permissions';
import { generateFullReport } from '../generators/report';
import { readCheckpoint } from '../generators/checkpoint';
import { runReportGeneration } from '../generators/generation-runner';
import {
  auditProjectAnalysisGaps,
  formatGapsReport,
  repairMissingPageAnalysis,
  checkpointSummary,
} from './repair-analysis';
import { logger } from '../utils/logger';
import slugify from 'slugify';
import type { LLMConfig } from '../ai/llm';
import { config } from '../config';

const program = new Command();

program
  .name('re-ai')
  .description('ReverseForge AI Studio CLI')
  .version('1.0.0');

// ── create-project ─────────────────────────────────────────────────────────
program
  .command('create-project')
  .description('Create a new reverse engineering project')
  .requiredOption('--name <name>', 'Project name')
  .requiredOption('--url <url>', 'Base URL of the application')
  .option('--login-url <url>', 'Login URL (defaults to base URL)')
  .option('--login-required', 'Open browser during crawl for manual login')
  .option('--depth <depth>', 'Crawl depth', '3')
  .option('--no-screenshots', 'Disable screenshots')
  .option('--no-network', 'Disable network capture')
  .option('--ai', 'Enable AI analysis')
  .option('--llm-key <key>', 'LLM API key')
  .option('--llm-model <model>', 'LLM model name', 'gpt-4o-mini')
  .option('--llm-url <url>', 'LLM base URL', 'https://api.openai.com/v1')
  .action(async (options) => {
    await connectDatabase();
    try {
      const slug = slugify(options.name, { lower: true, strict: true }) + '-' + Date.now();
      const project = await prisma.project.create({
        data: {
          name: options.name,
          slug,
          baseUrl: options.url,
          loginUrl: options.loginUrl,
          loginRequired: options.loginRequired ?? false,
          crawlDepth: parseInt(options.depth, 10),
          screenshotEnabled: options.screenshots !== false,
          networkCaptureEnabled: options.network !== false,
          aiEnabled: options.ai ?? false,
          llmApiKey: options.llmKey,
          llmModel: options.llmModel,
          llmBaseUrl: options.llmUrl,
        },
      });
      console.log(`✓ Project created: ${project.name} (ID: ${project.id})`);
      console.log(`  Slug: ${project.slug}`);
    } finally {
      await disconnectDatabase();
    }
  });

// ── login ──────────────────────────────────────────────────────────────────
program
  .command('login')
  .description('Open browser at login page and save session when login completes')
  .requiredOption('--project <id>', 'Project ID or slug')
  .action(async (options) => {
    await connectDatabase();
    try {
      const project = await prisma.project.findFirst({
        where: { OR: [{ id: options.project }, { slug: options.project }] },
      });
      if (!project) { console.error('Project not found'); process.exit(1); }

      const loginUrl = project.loginUrl || project.baseUrl;
      console.log(`Opening browser at: ${loginUrl}`);
      console.log('Fill in your credentials and log in. Session will be saved automatically.');
      await waitForLoginAndSaveSession(loginUrl, project.slug, (msg) => console.log(' ', msg));
      console.log('✓ Session saved.');
    } finally {
      await disconnectDatabase();
    }
  });

// ── crawl ──────────────────────────────────────────────────────────────────
program
  .command('crawl')
  .description('Start crawling the application')
  .requiredOption('--project <id>', 'Project ID or slug')
  .action(async (options) => {
    await connectDatabase();
    try {
      const project = await prisma.project.findFirst({
        where: { OR: [{ id: options.project }, { slug: options.project }] },
      });
      if (!project) {
        console.error('Project not found');
        process.exit(1);
      }

      if (!sessionExists(project.slug)) {
        console.log('⚠ No saved session. Run "login" first or crawl will attempt without auth.');
      }

      const session = await prisma.crawlSession.create({
        data: { projectId: project.id, status: 'pending' },
      });

      console.log(`Starting crawl for: ${project.name} (session: ${session.id})`);

      await runCrawl({
        project,
        session,
        projectSlug: project.slug,
        onProgress: (info) => {
          process.stdout.write(
            `\r  Pages: ${info.visitedCount} visited, ${info.queuedCount} queued | ${info.currentUrl.slice(0, 60)}`,
          );
        },
      });

      console.log('\n✓ Crawl complete!');
      const count = await prisma.pageCapture.count({ where: { crawlSessionId: session.id } });
      console.log(`  Session ID: ${session.id}`);
      console.log(`  Pages captured: ${count}`);
    } finally {
      await disconnectDatabase();
    }
  });

// ── analyze ───────────────────────────────────────────────────────────────
program
  .command('analyze')
  .description('Run AI analysis on crawled pages')
  .requiredOption('--project <id>', 'Project ID or slug')
  .option('--session <id>', 'Specific session ID (defaults to latest)')
  .action(async (options) => {
    await connectDatabase();
    try {
      const project = await prisma.project.findFirst({
        where: { OR: [{ id: options.project }, { slug: options.project }] },
      });
      if (!project) { console.error('Project not found'); process.exit(1); }

      const session = options.session
        ? await prisma.crawlSession.findUnique({ where: { id: options.session } })
        : await prisma.crawlSession.findFirst({
            where: { projectId: project.id, status: 'completed' },
            orderBy: { createdAt: 'desc' },
          });

      if (!session) { console.error('No completed crawl session found'); process.exit(1); }

      const llmConfig: LLMConfig = {
        baseUrl: project.llmBaseUrl ?? undefined,
        apiKey: project.llmApiKey ?? undefined,
        model: project.llmModel ?? undefined,
      };

      console.log(`Analyzing ${session.pagesCount} pages...`);
      await analyzeSession(session.id, llmConfig, project.name);
      console.log('✓ AI analysis complete!');
    } finally {
      await disconnectDatabase();
    }
  });

// ── repair-analysis ───────────────────────────────────────────────────────
program
  .command('repair-analysis')
  .description(
    'Audit pages missing AI analysis across a project, re-queue only those, and optionally reset failed report stages',
  )
  .requiredOption('--project <id>', 'Project ID or slug')
  .option('--session <id>', 'Limit to one session (default: checkpoint source sessions, else all)')
  .option('--dry-run', 'List gaps only — do not call the LLM')
  .option('--keep-downstream', 'Do not clear entity/workflow/permission checkpoint stages after repair')
  .option('--resume', 'After repair, enqueue report generation resume')
  .action(async (options) => {
    await connectDatabase();
    try {
      const project = await prisma.project.findFirst({
        where: { OR: [{ id: options.project }, { slug: options.project }] },
      });
      if (!project) {
        console.error('Project not found');
        process.exit(1);
      }

      const llmConfig: LLMConfig = {
        baseUrl: project.llmBaseUrl || config.llm.baseUrl,
        apiKey: project.llmApiKey || config.llm.apiKey || undefined,
        model: project.llmModel || config.llm.model,
      };

      console.log(`\nProject: ${project.name} (${project.slug})`);
      console.log(`Checkpoint: ${checkpointSummary(project.slug)}\n`);

      if (options.dryRun) {
        const sessionIds = options.session ? [options.session as string] : undefined;
        const gaps = await auditProjectAnalysisGaps(project.id, sessionIds);
        console.log(formatGapsReport(gaps));
        console.log('\n(dry-run — nothing changed)');
        return;
      }

      const result = await repairMissingPageAnalysis({
        projectId: project.id,
        projectSlug: project.slug,
        appName: project.name,
        llmConfig,
        sessionIds: options.session ? [options.session as string] : undefined,
        redoDownstream: !options.keepDownstream,
      });

      console.log('\n=== After repair ===');
      console.log(formatGapsReport(result.gaps));
      console.log(`Repaired sessions: ${result.repairedSessionIds.length ? result.repairedSessionIds.join(', ') : '(none needed)'}`);
      console.log(`Checkpoint updated: ${result.checkpointUpdated ? 'yes (downstream stages cleared)' : 'no'}`);

      const stillMissing = result.gaps.reduce((n, g) => n + g.missingAiCount, 0);
      if (stillMissing > 0) {
        console.error(`\n⚠ ${stillMissing} page(s) still missing AI — fix connectivity and re-run repair-analysis`);
        process.exitCode = 2;
        return;
      }

      console.log('\n✓ All extractable pages have AI analysis');

      if (options.resume) {
        const checkpoint = readCheckpoint(project.slug);
        if (!checkpoint) {
          console.error('No generation checkpoint to resume — start Extract Report from the UI first');
          process.exitCode = 1;
          return;
        }

        console.log('\nResuming report generation in this process…');
        const reportPath = await runReportGeneration({
          projectId: project.id,
          projectSlug: project.slug,
          appName: project.name,
          sessionId: checkpoint.sessionId,
          sourceSessionIds: checkpoint.sourceSessionIds,
          llmConfig,
          resume: true,
        });
        console.log(`✓ Report ready: ${reportPath}`);
      } else {
        console.log('Next: resume Extract Report from the UI, or re-run with --resume');
      }
    } finally {
      await disconnectDatabase();
    }
  });

// ── generate-report ───────────────────────────────────────────────────────
program
  .command('generate-report')
  .description('Generate full documentation report')
  .requiredOption('--project <id>', 'Project ID or slug')
  .option('--session <id>', 'Specific session ID (defaults to latest)')
  .action(async (options) => {
    await connectDatabase();
    try {
      const project = await prisma.project.findFirst({
        where: { OR: [{ id: options.project }, { slug: options.project }] },
      });
      if (!project) { console.error('Project not found'); process.exit(1); }

      const session = options.session
        ? await prisma.crawlSession.findUnique({ where: { id: options.session } })
        : await prisma.crawlSession.findFirst({
            where: { projectId: project.id, status: 'completed' },
            orderBy: { createdAt: 'desc' },
          });

      if (!session) { console.error('No completed crawl session found'); process.exit(1); }

      const llmConfig: LLMConfig = {
        baseUrl: project.llmBaseUrl ?? undefined,
        apiKey: project.llmApiKey ?? undefined,
        model: project.llmModel ?? undefined,
      };

      console.log('Inferring entities...');
      const entityModel = await inferEntities(session.id, project.id, llmConfig, project.name);
      console.log(`  Found ${entityModel.entities.length} entities`);

      console.log('Inferring workflows...');
      const workflowModel = await inferWorkflows(session.id, project.id, entityModel.entities, llmConfig, project.name);
      console.log(`  Found ${workflowModel.workflows.length} workflows`);

      console.log('Building permission matrix...');
      const permissionMatrix = await inferPermissions(session.id, entityModel.entities, llmConfig, project.name, project.id);

      console.log('Writing report...');
      const reportPath = await generateFullReport({
        projectId: project.id,
        sessionId: session.id,
        projectSlug: project.slug,
        appName: project.name,
        entityModel,
        workflowModel,
        permissionMatrix,
      });

      console.log(`\n✓ Report generated: ${reportPath}`);
    } finally {
      await disconnectDatabase();
    }
  });

// ── list-projects ─────────────────────────────────────────────────────────
program
  .command('list-projects')
  .description('List all projects')
  .action(async () => {
    await connectDatabase();
    try {
      const projects = await prisma.project.findMany({ orderBy: { createdAt: 'desc' } });
      if (projects.length === 0) {
        console.log('No projects found. Create one with: re-ai create-project');
        return;
      }
      console.log('\nProjects:');
      for (const p of projects) {
        console.log(`  ${p.name.padEnd(30)} ID: ${p.id}  URL: ${p.baseUrl}`);
      }
    } finally {
      await disconnectDatabase();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error('CLI error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
