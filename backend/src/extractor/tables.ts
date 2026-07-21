import { Page } from 'playwright';

export interface TableColumn {
  header: string;
  key?: string;
}

export interface TableData {
  title?: string;
  columns: TableColumn[];
  rowCount: number;
  sampleRows: string[][];
  hasFilters: boolean;
  hasPagination: boolean;
  hasSearch: boolean;
  hasSorting: boolean;
  actions: string[];
}

export async function extractTables(page: Page): Promise<TableData[]> {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table, [role="table"], [role="grid"]'));

    function getTableTitle(table: Element): string | undefined {
      const caption = table.querySelector('caption');
      if (caption) return caption.textContent?.trim();
      const prev = table.previousElementSibling;
      if (prev && /h[1-6]/i.test(prev.tagName)) return prev.textContent?.trim();
      const container = table.closest('[class*="table"], [class*="Table"], [class*="grid"]');
      if (container) {
        const heading = container.querySelector('h1,h2,h3,h4');
        if (heading) return heading.textContent?.trim();
      }
      return undefined;
    }

    function extractColumns(table: Element): { header: string; key?: string }[] {
      const headers = Array.from(
        table.querySelectorAll('thead th, thead td, [role="columnheader"]'),
      );
      if (headers.length > 0) {
        return headers.map((h) => ({
          header: h.textContent?.trim() ?? '',
          key: h.getAttribute('data-key') || h.getAttribute('data-column') || undefined,
        }));
      }
      // Try first row as header
      const firstRow = table.querySelector('tr, [role="row"]');
      if (firstRow) {
        return Array.from(firstRow.querySelectorAll('td, th')).map((td) => ({
          header: td.textContent?.trim() ?? '',
        }));
      }
      return [];
    }

    function extractSampleRows(table: Element): string[][] {
      const bodyRows = Array.from(table.querySelectorAll('tbody tr, [role="row"]:not(:first-child)'))
        .slice(0, 5);
      return bodyRows.map((row) =>
        Array.from(row.querySelectorAll('td, [role="gridcell"]')).map(
          (td) => td.textContent?.trim() ?? '',
        ),
      );
    }

    function hasFilters(table: Element): boolean {
      const parent = table.closest('[class*="table"], [class*="Table"]') ?? table.parentElement;
      if (!parent) return false;
      return !!(
        parent.querySelector('select, input[type="text"], .filter, [class*="filter"]') ||
        parent.querySelector('[placeholder*="filter" i], [placeholder*="search" i]')
      );
    }

    function hasPagination(table: Element): boolean {
      const parent = table.closest('[class*="table"]') ?? table.parentElement ?? document;
      return !!(
        parent.querySelector('[class*="paginat"], [aria-label*="pagination"], nav') ||
        parent.querySelector('button:has-text("Next"), button:has-text("Previous")')
      );
    }

    function extractActions(table: Element): string[] {
      const actions = new Set<string>();
      const buttons = Array.from(
        table.querySelectorAll('button, [role="button"], a.btn, .action'),
      );
      buttons.forEach((btn) => {
        const text = btn.textContent?.trim();
        if (text) actions.add(text);
      });
      return Array.from(actions).slice(0, 10);
    }

    return tables.map((table) => {
      const rows = table.querySelectorAll('tbody tr, [role="row"]:not([role="columnheader"])');
      return {
        title: getTableTitle(table),
        columns: extractColumns(table),
        rowCount: rows.length,
        sampleRows: extractSampleRows(table),
        hasFilters: hasFilters(table),
        hasPagination: hasPagination(table),
        hasSearch: !!(
          document.querySelector(
            'input[type="search"], input[placeholder*="search" i], .search-box',
          )
        ),
        hasSorting: !!(table.querySelector('[aria-sort], th[class*="sort"]')),
        actions: extractActions(table),
      };
    });
  });
}
