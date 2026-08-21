import type { LLMMessage } from '../ai/llm';
import { SAFETY_SUMMARY } from '../crawler/safety';
import { formatRollingContextForPrompt } from './rolling-context';
import type { PageState, AgentAction, AgentMemory } from './types';

/** Navigator prompt: given current page state + memory, select next action */
export function buildNavigatorPrompt(
  state: PageState,
  memory: AgentMemory,
  appName: string,
  hasVision = false,
): string {
  const safeElements = state.interactiveElements
    .filter((e) => e.isSafe)
    .map((e) => {
      const kind = e.actionKind ? `/${e.actionKind}` : '';
      const href = e.href ? ` -> ${e.href.slice(0, 60)}` : '';
      const options = e.options?.length ? ` options=[${e.options.slice(0, 8).join(', ')}]` : '';
      return `[${e.index}] ${e.tag}${e.isNavigation ? '(nav)' : ''}${kind}: "${e.text}"${href}${options}`;
    })
    .join('\n');

  const recentVisits = [...memory.visitedUrls].slice(-8).join(', ');
  const rolling = formatRollingContextForPrompt(memory);

  return `You are an AI agent reverse-engineering the web application "${appName}".
Your goal: explore ALL features, modules, forms, tables, modals, and workflows to build documentation.

${SAFETY_SUMMARY}

${rolling}

Current page: [${state.pageType.toUpperCase()}] ${state.title}
URL: ${state.url}
Breadcrumbs: ${state.breadcrumbs.join(' > ')}
Has form: ${state.hasForm} | Has tables: ${state.hasTables} | Has modal/dialog: ${state.hasModal}
${hasVision ? 'Vision: screenshot attached. Numbered colored boxes in the image match the element indexes below.' : 'Vision: not attached for this step.'}

Safe interactive elements (by index):
${safeElements || '(none)'}

Navigation items: ${state.navigationItems.slice(0, 15).join(', ')}

Already visited URLs: ${recentVisits || 'none yet'}
Discovered features: ${[...memory.visitedFeatures].slice(0, 10).join(', ') || 'none yet'}

Visible text excerpt: ${state.visibleText.slice(0, 400)}

Choose the BEST next action to explore new, unseen functionality.
Use the rolling summaries + recent interaction history: continue open threads, avoid repeating covered areas, and respect active instructions.
Priority order: navigation links > buttons that open modals/dialogs > create/edit/view form pages > detail pages > tabs/accordions > filters.

Return JSON:
{
  "type": "click|navigate|input|select|send_keys|scroll|scroll_to_text|scroll_to_percent|open_tab|switch_tab|close_tab|back|done",
  "elementIndex": 5,
  "url": "https://... (only for navigate)",
  "value": "text for input or up/down for scroll",
  "optionText": "visible dropdown option for select",
  "keys": "Escape|Tab|ArrowDown|Enter",
  "text": "text to scroll to",
  "yPercent": 50,
  "tabIndex": 1,
  "reason": "This opens the Training module which we haven't visited yet",
  "confidence": 0.9
}

Rules:
- Return "done" if ALL elements lead to already-visited URLs or there's nothing new to explore
- NEVER click anything marked unsafe (delete, approve, submit, confirm)
- NEVER click Logout / Log out / Sign out / Sign off / End session / Kill session / Terminate session / Force logout / Disconnect session — or any control whose id/class/href looks like logout
- Use the screenshot to understand visual grouping, hidden menus, primary actions, disabled-looking elements, and whether a modal/panel is already open
- It is OK to open Create/Edit/Add/New/View screens or modals to inspect fields, but NEVER click the final Save/Submit/Update/Create/Edit/Confirm button inside them
- Prefer one representative table row action such as View/Edit/Details, then avoid clicking the same repeated row button again
- Avoid repeated pagination/page-number clicks; use them only when they reveal meaningfully different screens
- Prefer navigation items that reveal new modules
- Avoid clicking pagination "Next" unless we need data
- Use select only on dropdown elements and choose one representative non-destructive option
- Use input only to explore search/filter fields with harmless values like "test" or a visible table term; never enter real personal data
- Use send_keys mostly for Escape, Tab, ArrowDown, or Enter in search/filter contexts; never use it to submit a transactional form
- Use scroll / scroll_to_text / scroll_to_percent when more page content may be below the fold
- Use open_tab / switch_tab / close_tab only for read-only links or recovering useful tabs
- In "reason", briefly connect this action to an active instruction or open thread when possible

Return only valid JSON.`;
}

/** Planner prompt: given overall exploration state, plan next goals */
export function buildPlannerPrompt(
  appName: string,
  visitedPages: Array<{ url: string; title: string; pageType: string }>,
  discoveredFeatures: string[],
  memory?: AgentMemory,
): string {
  const pageSummary = visitedPages
    .slice(-20)
    .map((p) => `${p.pageType}: ${p.title} (${p.url.slice(0, 60)})`)
    .join('\n');

  const rolling = memory ? `\n${formatRollingContextForPrompt(memory)}\n` : '';

  return `You are planning the reverse-engineering exploration of "${appName}".
${rolling}
Pages visited so far (${visitedPages.length} total):
${pageSummary}

Discovered features: ${discoveredFeatures.join(', ') || 'none yet'}

Analyze what we've seen and identify what's MISSING from our exploration.
A complete RE would cover: all CRUD screens, all workflows, all dashboards, all reports, settings, user management.
Build on the rolling summaries — do not reset focus; refine goals and open threads.

Return JSON:
{
  "coverageEstimate": 0.4,
  "missingModules": ["Billing", "Reports", "User Management"],
  "nextPriorityUrl": "/admin/users or description",
  "explorationGoals": ["Explore all modules in sidebar", "Find all forms", "Discover workflows"],
  "recommendation": "What to focus on next"
}

Return only valid JSON.`;
}

export function buildNavigatorMessages(
  state: PageState,
  memory: AgentMemory,
  appName: string,
  screenshotDataUrl?: string,
): LLMMessage[] {
  const prompt = buildNavigatorPrompt(state, memory, appName, Boolean(screenshotDataUrl));

  return [
    {
      role: 'system',
      content:
        'You are an expert web application reverse-engineering agent. You navigate systematically to discover all features, data models, workflows, and permissions. You use rolling exploration history and summaries to stay consistent across steps. You always return valid JSON.',
    },
    {
      role: 'user',
      content: screenshotDataUrl
        ? [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'low' } },
          ]
        : prompt,
    },
  ];
}

export function buildPlannerMessages(
  appName: string,
  visitedPages: Array<{ url: string; title: string; pageType: string }>,
  discoveredFeatures: string[],
  memory?: AgentMemory,
): LLMMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a software reverse-engineering planner. You analyze what has been explored and identify gaps, using rolling summaries as durable memory.',
    },
    {
      role: 'user',
      content: buildPlannerPrompt(appName, visitedPages, discoveredFeatures, memory),
    },
  ];
}

export interface PlannerOutput {
  coverageEstimate: number;
  missingModules: string[];
  nextPriorityUrl: string;
  explorationGoals: string[];
  recommendation: string;
}

export interface ValidatorOutput {
  success: boolean;
  observation: string;
  newInfoFound: boolean;
  shouldBacktrack: boolean;
  retryReason?: string;
}

export function buildValidatorMessages(
  appName: string,
  before: PageState,
  after: PageState,
  action: AgentAction,
  screenshotDataUrl?: string,
): LLMMessage[] {
  const prompt = `You are validating a read-only browser exploration step for "${appName}".

Action attempted:
${JSON.stringify(action)}

Before:
- URL: ${before.url}
- Title: ${before.title}
- Type: ${before.pageType}
- Form: ${before.hasForm} | Tables: ${before.hasTables} | Modal: ${before.hasModal}

After:
- URL: ${after.url}
- Title: ${after.title}
- Type: ${after.pageType}
- Form: ${after.hasForm} | Tables: ${after.hasTables} | Modal: ${after.hasModal}
- Text excerpt: ${after.visibleText.slice(0, 500)}

Return JSON:
{
  "success": true,
  "observation": "The click opened a details modal with fields",
  "newInfoFound": true,
  "shouldBacktrack": false,
  "retryReason": ""
}

Set shouldBacktrack true if the action landed on an irrelevant, repeated, unsafe-looking, logout/login, or dead-end page.
Return only valid JSON.`;

  return [
    {
      role: 'system',
      content: 'You are a validator for a safe read-only browser agent. Return only valid JSON.',
    },
    {
      role: 'user',
      content: screenshotDataUrl
        ? [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'low' } },
          ]
        : prompt,
    },
  ];
}

export function validateAction(action: AgentAction, state: PageState): AgentAction {
  if (['click', 'input', 'select'].includes(action.type) && action.elementIndex !== undefined) {
    const el = state.interactiveElements.find((e) => e.index === action.elementIndex);
    if (!el || !el.isSafe) {
      return { type: 'done', reason: 'Selected element not found or unsafe', confidence: 1 };
    }
    if (action.type === 'select' && el.actionKind !== 'dropdown' && el.tag !== 'select') {
      return { type: 'done', reason: 'Selected element is not a dropdown', confidence: 1 };
    }
  }

  if (['click', 'input', 'select'].includes(action.type) && action.elementIndex === undefined) {
    return { type: 'done', reason: 'Element action has no elementIndex', confidence: 1 };
  }

  if (action.type === 'navigate' && !action.url) {
    return { type: 'done', reason: 'Navigate action has no URL', confidence: 1 };
  }

  if (action.type === 'select' && !action.optionText) {
    return { type: 'done', reason: 'Select action has no optionText', confidence: 1 };
  }

  if (action.type === 'input' && !action.value) {
    return { type: 'done', reason: 'Input action has no value', confidence: 1 };
  }

  return action;
}
