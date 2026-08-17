export interface Project {
  id: string;
  name: string;
  slug: string;
  baseUrl: string;
  loginUrl?: string;
  loginRequired: boolean;
  crawlDepth: number;
  screenshotEnabled: boolean;
  networkCaptureEnabled: boolean;
  llmModel?: string;
  llmApiKeyConfigured?: boolean;
  createdAt: string;
  updatedAt: string;
  crawlSessions?: CrawlSession[];
  _count?: { crawlSessions: number };
}

export interface CrawlSession {
  id: string;
  projectId: string;
  status: 'pending' | 'awaiting_login' | 'running' | 'completed' | 'failed' | 'stopped';
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
  pagesCount: number;
  createdAt: string;
  _count?: { pages: number; networkCalls: number };
}

export interface PageCapture {
  id: string;
  crawlSessionId: string;
  url: string;
  title?: string;
  depth: number;
  screenshotPath?: string;
  fullScreenshotPath?: string;
  loadTimeMs?: number;
  breadcrumbs?: string[];
  extractedData?: ExtractedData;
  aiAnalysis?: PageAnalysis;
  networkCalls?: NetworkCall[];
  createdAt: string;
  _count?: { networkCalls: number };
}

export interface ExtractedData {
  url: string;
  title: string;
  breadcrumbs: string[];
  navigation: {
    sidebarItems: NavItem[];
    topbarItems: NavItem[];
    buttons: string[];
    tabs: string[];
    breadcrumbs: string[];
  };
  forms: FormData[];
  tables: TableData[];
  cards: CardData[];
}

export interface NavItem {
  label: string;
  href?: string;
  children?: NavItem[];
}

export interface FormData {
  id?: string;
  title?: string;
  fields: FormField[];
}

export interface FormField {
  label: string;
  name: string;
  type: string;
  placeholder: string;
  required: boolean;
  options?: string[];
}

export interface TableData {
  title?: string;
  columns: { header: string }[];
  rowCount: number;
  hasFilters: boolean;
  hasPagination: boolean;
}

export interface CardData {
  title?: string;
  value?: string;
}

export interface PageAnalysis {
  businessModule: string;
  primaryEntity: string;
  relatedEntities: string[];
  pagePurpose: string;
  userActions: string[];
  workflowStage: string;
  possibleRoles: string[];
  businessRules: string[];
  confidenceScore: number;
}

export interface NetworkCall {
  id: string;
  method?: string;
  url: string;
  responseStatus?: number;
  timingMs?: number;
  resourceType?: string;
  queryParams?: string;
  requestPayload?: string;
  requestContentType?: string;
  responseBody?: string;
  responseContentType?: string;
  responseSchemaKeys?: string;
  requestHeaders?: string;
  responseHeaders?: string;
  isGraphQL?: boolean;
  graphQLOperationName?: string;
  pageCapture?: { url: string; title?: string };
  createdAt: string;
}

export interface EntityModel {
  id: string;
  name: string;
  fields: EntityField[];
  relationships: EntityRelationship[];
  primaryModule?: string;
}

export interface EntityField {
  name: string;
  type: string;
  label: string;
  required: boolean;
}

export interface EntityRelationship {
  type: string;
  entity: string;
}

export interface WorkflowModel {
  id: string;
  name: string;
  entityName?: string;
  states: string[];
  transitions: WorkflowTransition[];
  actors: string[];
}

export interface WorkflowTransition {
  from: string;
  to: string;
  trigger: string;
  actor: string;
  approvalRequired: boolean;
}

export interface Report {
  id: string;
  projectId: string;
  crawlSessionId?: string;
  type: string;
  filePath: string;
  createdAt: string;
}

export interface Job {
  id: string;
  type: string;
  status: 'waiting' | 'active' | 'completed' | 'failed';
  progress: number;
  error?: string;
  createdAt: string;
}

export type GenerationStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed';

export interface GenerationProgress {
  projectId: string;
  status: GenerationStatus;
  progress: number;
  currentStage: string | null;
  stageLabel: string;
  message: string;
  completedStages: string[];
  error?: string | null;
  canResume: boolean;
  jobActive: boolean;
  updatedAt: string;
  reportPath?: string | null;
}

export interface CrawlLogEntry {
  id: number;
  sessionId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  meta?: Record<string, unknown>;
}
