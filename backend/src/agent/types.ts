// Agent action types and shared data structures

export type ActionType =
  | 'click'       // Click an element by index
  | 'navigate'    // Go directly to a URL
  | 'input'       // Type into an input field
  | 'select'      // Select a dropdown option by visible text/value
  | 'send_keys'   // Send keyboard keys to the page/active element
  | 'scroll'      // Scroll the page
  | 'scroll_to_text'
  | 'scroll_to_percent'
  | 'open_tab'
  | 'switch_tab'
  | 'close_tab'
  | 'back'        // Go back in history
  | 'done';       // No more useful actions on this page

export interface AgentAction {
  type: ActionType;
  /** Index from the numbered interactive elements list */
  elementIndex?: number;
  /** Direct URL for navigate actions */
  url?: string;
  /** Text value for input actions */
  value?: string;
  /** Dropdown option text/value for select actions */
  optionText?: string;
  /** Keyboard keys such as Escape, Tab, ArrowDown, Enter */
  keys?: string;
  /** Text target for scroll_to_text */
  text?: string;
  /** Vertical page percentage for scroll_to_percent */
  yPercent?: number;
  /** Browser tab index for switch_tab / close_tab */
  tabIndex?: number;
  /** LLM's explanation of why this action was chosen */
  reason: string;
  /** LLM confidence 0–1 */
  confidence: number;
}

export interface InteractiveElement {
  index: number;
  tag: string;
  text: string;
  /** Unique CSS selector for the element */
  selector: string;
  type?: string;
  href?: string;
  options?: string[];
  /** Stable-ish page-local fingerprint used to avoid repeated row/pagination clicks */
  actionKey?: string;
  /** Coarse action class for exploration priority and de-duping */
  actionKind?: 'navigation' | 'modal' | 'form-open' | 'detail' | 'toggle' | 'pagination' | 'table-action' | 'field' | 'dropdown' | 'submit' | 'unsafe' | 'other';
  /** True when the element is inside a form or acts like a form submitter */
  isFormSubmit?: boolean;
  /** True = safe to click (not delete/submit/approve) */
  isSafe: boolean;
  /** True if this is navigation (menu, link, tab) */
  isNavigation: boolean;
}

export interface PageState {
  url: string;
  title: string;
  /** Truncated visible text for LLM context */
  visibleText: string;
  interactiveElements: InteractiveElement[];
  navigationItems: string[];
  breadcrumbs: string[];
  hasForm: boolean;
  hasTables: boolean;
  hasModal: boolean;
  pageType: 'list' | 'form' | 'detail' | 'dashboard' | 'login' | 'settings' | 'unknown';
}

export interface InteractionRecord {
  step: number;
  url: string;
  title: string;
  pageType?: string;
  actionType: string;
  /** Human-readable action, e.g. click [3] "Capture" */
  actionDetail: string;
  reason: string;
  resultUrl: string;
  /** Validator / outcome notes */
  outcome?: string;
}

export interface RollingSummary {
  fromStep: number;
  toStep: number;
  summary: string;
  openThreads?: string[];
  avoidRepeating?: string[];
  nextFocus?: string[];
  createdAt: string;
}

export interface AgentMemory {
  visitedUrls: Set<string>;
  visitedFeatures: Set<string>;
  discoveredEntities: string[];
  explorationGoals: string[];
  currentDepth: number;
  /** Full chronological interaction log (capped). */
  interactionHistory: InteractionRecord[];
  /** Compounded summaries every ~10 interactions. */
  rollingSummaries: RollingSummary[];
  /** Goals + latest summary focus lines fed into every navigator decision. */
  activeInstructions: string[];
}

export interface AgentStep {
  stepNumber: number;
  url: string;
  pageTitle: string;
  action: AgentAction;
  resultUrl: string;
  timestamp: Date;
  notes?: string;
}
