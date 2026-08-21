import type { LLMClient } from '../ai/llm';
import { logger } from '../utils/logger';
import type { AgentAction, AgentMemory, InteractionRecord, RollingSummary } from './types';

export const ROLLING_SUMMARY_EVERY = 10;
export const RECENT_INTERACTIONS_IN_PROMPT = 12;

export function createEmptyAgentMemory(goals: string[]): AgentMemory {
  return {
    visitedUrls: new Set(),
    visitedFeatures: new Set(),
    discoveredEntities: [],
    explorationGoals: goals,
    currentDepth: 0,
    interactionHistory: [],
    rollingSummaries: [],
    activeInstructions: [...goals],
  };
}

export function describeAction(action: AgentAction): string {
  const parts: string[] = [action.type];
  if (action.elementIndex !== undefined) parts.push(`[${action.elementIndex}]`);
  if (action.url) parts.push(`→ ${action.url.slice(0, 80)}`);
  if (action.value) parts.push(`value="${action.value.slice(0, 40)}"`);
  if (action.optionText) parts.push(`option="${action.optionText.slice(0, 40)}"`);
  if (action.keys) parts.push(`keys=${action.keys}`);
  if (action.text) parts.push(`text="${action.text.slice(0, 40)}"`);
  return parts.join(' ');
}

export function appendInteraction(
  memory: AgentMemory,
  record: Omit<InteractionRecord, 'step'> & { step?: number },
): InteractionRecord {
  const step = record.step ?? memory.interactionHistory.length + 1;
  const full: InteractionRecord = {
    step,
    url: record.url,
    title: record.title,
    pageType: record.pageType,
    actionType: record.actionType,
    actionDetail: record.actionDetail,
    reason: record.reason,
    resultUrl: record.resultUrl,
    outcome: record.outcome,
  };
  memory.interactionHistory.push(full);
  // Cap raw history in memory to avoid unbounded growth; summaries carry long-term context
  if (memory.interactionHistory.length > 200) {
    memory.interactionHistory = memory.interactionHistory.slice(-160);
  }
  return full;
}

export function formatInteractionLine(r: InteractionRecord): string {
  const outcome = r.outcome ? ` | outcome: ${r.outcome.slice(0, 120)}` : '';
  return `#${r.step} [${r.pageType ?? '?'}] "${r.title}" | ${r.actionDetail} | why: ${r.reason.slice(0, 140)} | ${r.url.slice(0, 70)} → ${r.resultUrl.slice(0, 70)}${outcome}`;
}

/** Text block injected into navigator / planner prompts. */
export function formatRollingContextForPrompt(memory: AgentMemory): string {
  const goals = memory.explorationGoals.length
    ? memory.explorationGoals.map((g) => `- ${g}`).join('\n')
    : '- Explore all modules, forms, tables, and workflows';

  const summaries = memory.rollingSummaries.length
    ? memory.rollingSummaries
        .map((s) => `[steps ${s.fromStep}-${s.toStep}]: ${s.summary}`)
        .join('\n')
    : '(none yet — first summary after 10 interactions)';

  const recent = memory.interactionHistory.slice(-RECENT_INTERACTIONS_IN_PROMPT);
  const history = recent.length
    ? recent.map(formatInteractionLine).join('\n')
    : '(none yet)';

  const instructions = memory.activeInstructions.length
    ? memory.activeInstructions.map((i) => `- ${i}`).join('\n')
    : goals;

  return `Exploration goals (follow these):
${goals}

Active instructions (rolling — prefer these when choosing the next action):
${instructions}

Rolling exploration summaries (compounded over the crawl):
${summaries}

Recent interaction history (last ${RECENT_INTERACTIONS_IN_PROMPT}; use to avoid repeats and continue unfinished threads):
${history}`;
}

interface SummaryJson {
  summary: string;
  openThreads?: string[];
  avoidRepeating?: string[];
  nextFocus?: string[];
}

/**
 * Every N interactions, ask the LLM for a compact summary and fold it into
 * rollingSummaries + activeInstructions so later decisions keep long-term context.
 */
export async function maybeCreateRollingSummary(
  llm: LLMClient,
  memory: AgentMemory,
  appName: string,
  every = ROLLING_SUMMARY_EVERY,
): Promise<RollingSummary | null> {
  const count = memory.interactionHistory.length;
  if (count === 0 || count % every !== 0) return null;

  const fromStep = memory.interactionHistory[count - every]?.step ?? count - every + 1;
  const toStep = memory.interactionHistory[count - 1]?.step ?? count;
  const batch = memory.interactionHistory.slice(-every);
  const prior = memory.rollingSummaries
    .slice(-4)
    .map((s) => `[${s.fromStep}-${s.toStep}] ${s.summary}`)
    .join('\n') || '(none)';

  const prompt = `You are summarizing reverse-engineering exploration of "${appName}".

Prior rolling summaries:
${prior}

Latest ${every} interactions (steps ${fromStep}-${toStep}):
${batch.map(formatInteractionLine).join('\n')}

Current exploration goals:
${memory.explorationGoals.map((g) => `- ${g}`).join('\n')}

Return JSON only:
{
  "summary": "2-5 sentences covering what was explored, what was learned, and what remains unfinished",
  "openThreads": ["unfinished areas still worth exploring"],
  "avoidRepeating": ["actions/pages already sufficiently covered"],
  "nextFocus": ["concrete next priorities for the navigator"]
}`;

  try {
    const result = await llm.chatJson<SummaryJson>(
      [
        {
          role: 'system',
          content:
            'You compress browser exploration history into durable rolling summaries for a reverse-engineering agent. Return valid JSON only.',
        },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 1_500 },
    );

    const summaryText = (result.summary || '').trim();
    if (!summaryText) return null;

    const entry: RollingSummary = {
      fromStep,
      toStep,
      summary: summaryText,
      openThreads: result.openThreads ?? [],
      avoidRepeating: result.avoidRepeating ?? [],
      nextFocus: result.nextFocus ?? [],
      createdAt: new Date().toISOString(),
    };
    memory.rollingSummaries.push(entry);

    // Fold into active instructions — keep goals + latest focus, drop noise
    const nextInstructions = [
      ...memory.explorationGoals.slice(0, 5),
      ...(entry.nextFocus ?? []).slice(0, 5),
      ...(entry.openThreads ?? []).slice(0, 4).map((t) => `Continue: ${t}`),
      ...(entry.avoidRepeating ?? []).slice(0, 4).map((t) => `Avoid re-doing: ${t}`),
    ];
    memory.activeInstructions = [...new Set(nextInstructions.map((s) => s.trim()).filter(Boolean))].slice(0, 16);

    logger.info(
      `[RollingContext] Summary steps ${fromStep}-${toStep}: ${summaryText.slice(0, 160)}${summaryText.length > 160 ? '…' : ''}`,
    );
    return entry;
  } catch (err) {
    logger.warn(
      `[RollingContext] Failed to create summary for steps ${fromStep}-${toStep}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Still add a deterministic fallback so history compounds without LLM
    const fallback: RollingSummary = {
      fromStep,
      toStep,
      summary: batch
        .map((r) => `${r.actionType} on "${r.title}" (${r.reason.slice(0, 60)})`)
        .join('; ')
        .slice(0, 600),
      createdAt: new Date().toISOString(),
    };
    memory.rollingSummaries.push(fallback);
    return fallback;
  }
}

export function rollingContextSnapshot(memory: AgentMemory): Record<string, unknown> {
  return {
    explorationGoals: memory.explorationGoals,
    activeInstructions: memory.activeInstructions,
    rollingSummaries: memory.rollingSummaries,
    interactionHistoryCount: memory.interactionHistory.length,
    recentInteractions: memory.interactionHistory.slice(-RECENT_INTERACTIONS_IN_PROMPT),
  };
}
