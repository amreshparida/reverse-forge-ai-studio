import { Page } from 'playwright';
import { UNSAFE_TEXT_PATTERNS } from '../crawler/safety';

// ── Type definitions ───────────────────────────────────────────────────────

export interface FieldOption { value: string; text: string; selected: boolean }

export interface FormField {
  name: string;
  id?: string;
  type: string;
  label: string;
  placeholder?: string;
  required: boolean;
  readonly: boolean;
  disabled: boolean;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
  step?: string;
  defaultValue?: string;
  options?: FieldOption[];
  ariaLabel?: string;
  ariaDescribedBy?: string;
  autocomplete?: string;
  dataAttributes: Record<string, string>;
  validationMessage?: string;
}

export interface DeepForm {
  id?: string;
  action?: string;
  method?: string;
  enctype?: string;
  title?: string;
  description?: string;
  fields: FormField[];
  submitButtons: Array<{ text: string; type: string; name?: string }>;
  cancelButtons: Array<{ text: string }>;
}

export interface TableColumn { header: string; key?: string; sortable: boolean; dataType?: string }
export interface PaginationInfo {
  type: 'page-based' | 'cursor' | 'load-more' | 'infinite-scroll' | 'none';
  currentPage?: number;
  totalPages?: number;
  pageSize?: number;
  controls: string[];
}
export interface TableFilter { label: string; type: string; options?: string[]; selector: string }

export interface DeepTable {
  id?: string;
  title?: string;
  caption?: string;
  columns: TableColumn[];
  rowCount: number;
  sampleRows: Array<Record<string, string>>;
  pagination: PaginationInfo;
  filters: TableFilter[];
  searchBox?: { placeholder: string; selector: string };
  bulkActions: string[];
  rowActions: string[];
  hasCheckboxSelection: boolean;
  hasExport: boolean;
  hasImport: boolean;
  hasCreate: boolean;
  apiEndpointHint?: string;
}

export interface NavItem { label: string; href?: string; icon?: string; badge?: string; children?: NavItem[]; active?: boolean }
export interface TabItem { label: string; id?: string; href?: string; active: boolean }
export interface DropdownMenu { trigger: string; triggerSelector: string; items: NavItem[] }

export interface DeepNavigation {
  sidebar: NavItem[];
  topbar: NavItem[];
  breadcrumbs: string[];
  tabs: TabItem[];
  dropdownMenus: DropdownMenu[];
  currentModule?: string;
}

export interface ModalInfo {
  id?: string;
  title?: string;
  isVisible: boolean;
  triggerText?: string;
  content?: string;
  formCount: number;
  buttons: string[];
}

export interface SearchBox {
  id?: string;
  placeholder: string;
  selector: string;
  isGlobalSearch: boolean;
  scope?: string;
}

export interface CardWidget {
  title?: string;
  subtitle?: string;
  value?: string;
  metric?: string;
  description?: string;
  actions: string[];
  badge?: string;
  type: 'stat' | 'content' | 'chart' | 'action' | 'unknown';
}

export interface ChartInfo {
  type?: string;
  title?: string;
  description?: string;
  hasLegend: boolean;
}

export interface AlertMessage {
  type: 'success' | 'error' | 'warning' | 'info' | 'unknown';
  text: string;
}

export interface Clickable {
  tag: string;
  text: string;
  href?: string;
  type?: string;
  selector: string;
  ariaLabel?: string;
  role?: string;
  dataAttributes: Record<string, string>;
  isSafe: boolean;
  parentContext?: string;
}

export interface TechStack {
  frameworks: string[];
  cssFramework: string | null;
  hasJQuery: boolean;
  hasSPA: boolean;
  authHints: string[];
  apiPatterns: string[];
  buildInfo?: string;
}

export interface StorageItem { key: string; valuePreview: string; isAuthRelated: boolean }
export interface ConsoleEntry { type: 'error' | 'warning' | 'info' | 'log'; text: string }

export interface PageHeading { level: number; text: string; id?: string }

export interface ComprehensivePageData {
  // ── Identity ────────────────────────────────────────────────────────────
  url: string;
  title: string;
  metaDescription?: string;
  lang?: string;
  pageType: 'list' | 'form' | 'detail' | 'dashboard' | 'login' | 'settings' | 'report' | 'unknown';

  // ── Content hierarchy ────────────────────────────────────────────────────
  headings: PageHeading[];
  visibleText: string;
  paragraphs: string[];
  breadcrumbs: string[];

  // ── All clickables ───────────────────────────────────────────────────────
  allClickables: Clickable[];

  // ── Forms (deep) ─────────────────────────────────────────────────────────
  forms: DeepForm[];

  // ── Tables (deep) ────────────────────────────────────────────────────────
  tables: DeepTable[];

  // ── Navigation ───────────────────────────────────────────────────────────
  navigation: DeepNavigation;

  // ── Modals ───────────────────────────────────────────────────────────────
  modals: ModalInfo[];

  // ── Search ───────────────────────────────────────────────────────────────
  searchBoxes: SearchBox[];

  // ── Cards / Widgets ──────────────────────────────────────────────────────
  cards: CardWidget[];

  // ── Charts ───────────────────────────────────────────────────────────────
  charts: ChartInfo[];

  // ── Alerts / Status ──────────────────────────────────────────────────────
  alerts: AlertMessage[];

  // ── Pagination standalone ────────────────────────────────────────────────
  pagination: PaginationInfo[];

  // ── Browser storage ─────────────────────────────────────────────────────
  storage: { localStorage: StorageItem[]; sessionStorage: StorageItem[] };

  // ── Tech stack ───────────────────────────────────────────────────────────
  techStack: TechStack;

  // ── Console errors (injected from crawler) ───────────────────────────────
  consoleErrors?: ConsoleEntry[];

  // ── Data attributes map ──────────────────────────────────────────────────
  customDataAttributes: Record<string, string[]>;

  // ── Unique API endpoint hints from DOM ──────────────────────────────────
  apiEndpointHints: string[];
}
