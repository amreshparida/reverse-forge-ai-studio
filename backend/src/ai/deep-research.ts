import fs from 'fs';
import path from 'path';
import { prisma } from '../database/client';
import { config } from '../config';
import { logger } from '../utils/logger';
import { writeJson, readJson } from '../utils/file-system';
import { retryUntilSuccess } from '../utils/retry';
import { createLLMClient, isLLMConfigured, type LLMConfig } from './llm';
import { buildHarIntelligence, compactHarIntelligence, type HarIntelligenceBriefing } from './har-intelligence';

export interface DeepResearchReport {
  researchThesis: string;
  confidence: number;
  observedFacts: string[];
  inferences: Array<{ claim: string; evidence: string[]; confidence: number }>;
  integrationMap: {
    firstPartyApiFamilies: Array<{ family: string; baseUrlHint: string; methods: string[]; purpose: string; evidence: string[] }>;
    thirdParties: Array<{ host: string; category: string; purpose: string; risk: string }>;
  };
  authAndSessionModel: {
    mechanism: string;
    evidence: string[];
    risks: string[];
  };
  contractCatalog: Array<{
    method: string;
    endpoint: string;
    purpose: string;
    requestShape: string[];
    responseShape: string[];
    usedOnPages: string[];
  }>;
  pageLoadStories: Array<{ pageUrl: string; story: string; dependentApis: string[] }>;
  riskRegister: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    title: string;
    detail: string;
    evidence: string[];
    recommendation: string;
  }>;
  reconstructionPlaybook: {
    recommendedApproach: string;
    modulesToRebuildFirst: string[];
    dataContractsToClone: string[];
    unknownsToValidate: string[];
  };
  openQuestions: string[];
}

function seedNotesFromBriefing(briefing: HarIntelligenceBriefing): string {
  return [
    'DETERMINISTIC HAR INTELLIGENCE (observed facts — do not contradict unless HAR evidence shows otherwise):',
    ...briefing.facts,
    `Top endpoints: ${briefing.endpoints.slice(0, 15).map((e) => `${e.method} ${e.urlPattern} ×${e.count}`).join('; ')}`,
    `Auth: 401=${briefing.auth.status401} 403=${briefing.auth.status403} Authorization=${briefing.auth.authorizationHeaderPresent} Set-Cookie=${briefing.auth.setCookiePresent} CSRF=${briefing.auth.csrfHeaderPresent}`,
  ].join('\n');
}

export async function runDeepResearch(args: {
  sessionId: string;
  projectId: string;
  projectSlug: string;
  appName: string;
  sourceSessionIds: string[];
  reportsDir: string;
  llmConfig?: LLMConfig;
}): Promise<{ briefing: HarIntelligenceBriefing; research: DeepResearchReport | null }> {
  const sessionIds = args.sourceSessionIds.length ? args.sourceSessionIds : [args.sessionId];
  const briefing = buildHarIntelligence({
    projectSlug: args.projectSlug,
    sourceSessionIds: sessionIds,
  });
  writeJson(path.join(args.reportsDir, 'har-intelligence.json'), briefing);
  logger.info(
    `[DeepResearch] HAR intelligence: ${briefing.stats.harFiles} files, ${briefing.stats.entries} entries, ${briefing.stats.uniqueEndpoints} endpoints`,
  );

  if (!isLLMConfigured(args.llmConfig)) {
    return { briefing, research: null };
  }

  if (config.llm.synthesisAgentEnabled) {
    const research = await retryUntilSuccess(
      async () => {
        const { materializeEvidenceWorkspace } = await import('./synthesis-workspace.js');
        const { runSynthesisAgent } = await import('./synthesis-agent.js');

        const workspace = await materializeEvidenceWorkspace({
          projectId: args.projectId,
          projectSlug: args.projectSlug,
          sessionId: args.sessionId,
          sourceSessionIds: sessionIds,
          includeNetworkCalls: true,
        });

        writeJson(path.join(workspace.root, 'har-intelligence.json'), briefing);
        for (const name of ['entity-model.json', 'workflow-model.json', 'permission-matrix.json', 'architecture.json'] as const) {
          const src = path.join(args.reportsDir, '_generation', name);
          const alt = path.join(args.reportsDir, name);
          const from = fs.existsSync(src) ? src : fs.existsSync(alt) ? alt : null;
          if (from) fs.copyFileSync(from, path.join(workspace.root, name));
        }

        const notesPath = path.join(workspace.root, 'working-notes.json');
        const existing = readJson<{ notes: string[] }>(notesPath);
        const notes = existing?.notes ?? [];
        notes.push(seedNotesFromBriefing(briefing));
        writeJson(notesPath, { notes });

        const { artifact, steps, coverage } = await runSynthesisAgent<DeepResearchReport>({
          workspace,
          task: 'deep-research',
          expectedArtifact: 'deep-research.json',
          appName: args.appName,
          llmConfig: args.llmConfig,
          coverage: { requireAllPages: false, requireAllApis: true, requireAllHars: true },
          extraAllowedArtifacts: ['har-intelligence.json', 'deep-research.json'],
          reuseSharedEvidence: true,
        });

        logger.info(`[DeepResearch] Synthesis complete in ${steps} steps`, coverage);
        return artifact;
      },
      { label: 'Deep research synthesis agent', delayMs: 15_000, maxDelayMs: 180_000 },
    );

    writeJson(path.join(args.reportsDir, 'deep-research.json'), research);
    return { briefing, research };
  }

  const llm = createLLMClient(args.llmConfig);
  const dbCalls = await prisma.networkCall.findMany({
    where: { crawlSessionId: { in: sessionIds } },
    take: 200,
    select: {
      method: true,
      url: true,
      responseStatus: true,
      responseSchemaKeys: true,
      isGraphQL: true,
      graphQLOperationName: true,
      resourceType: true,
    },
  });

  const research = await retryUntilSuccess(
    () =>
      llm.chatJson<DeepResearchReport>(
        [
          {
            role: 'system',
            content:
              'You are a principal reverse-engineering researcher. Separate observed facts from inferences. Return only valid JSON.',
          },
          {
            role: 'user',
            content: [
              `Application: "${args.appName}".`,
              'Build a deep-research JSON report from HAR intelligence and API captures.',
              'Required keys: researchThesis, confidence, observedFacts, inferences, integrationMap, authAndSessionModel, contractCatalog, pageLoadStories, riskRegister, reconstructionPlaybook, openQuestions.',
              `HAR intelligence: ${JSON.stringify(compactHarIntelligence(briefing))}`,
              `API sample: ${JSON.stringify(dbCalls)}`,
            ].join('\n\n'),
          },
        ],
        { maxTokens: 5000 },
      ),
    { label: 'Deep research chatJson', delayMs: 10_000, maxDelayMs: 180_000 },
  );

  writeJson(path.join(args.reportsDir, 'deep-research.json'), research);
  return { briefing, research };
}
