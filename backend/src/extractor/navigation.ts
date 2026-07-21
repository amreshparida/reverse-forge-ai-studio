import { Page } from 'playwright';

export interface NavigationItem {
  label: string;
  href?: string;
  children?: NavigationItem[];
  icon?: string;
  badge?: string;
}

export interface NavigationData {
  sidebarItems: NavigationItem[];
  topbarItems: NavigationItem[];
  breadcrumbs: string[];
  tabs: string[];
  dropdownMenus: NavigationItem[];
  pageTitle: string;
  pageHeadings: string[];
  buttons: string[];
  modalTriggers: string[];
}

export async function extractNavigation(page: Page): Promise<NavigationData> {
  return page.evaluate(() => {
    function extractItems(selector: string): { label: string; href?: string }[] {
      return Array.from(document.querySelectorAll(selector))
        .map((el) => ({
          label: el.textContent?.trim() ?? '',
          href: (el as HTMLAnchorElement).href || el.getAttribute('href') || undefined,
        }))
        .filter((item) => item.label.length > 0);
    }

    function extractNavItemsRecursive(container: Element): { label: string; href?: string; children?: { label: string; href?: string }[] }[] {
      const children = Array.from(container.children);
      return children
        .map((child) => {
          const anchor = child.tagName === 'A' ? child : child.querySelector('a');
          const label = anchor?.textContent?.trim() || child.textContent?.trim() || '';
          const href = anchor ? (anchor as HTMLAnchorElement).href || anchor.getAttribute('href') || undefined : undefined;
          const subList = child.querySelector('ul, ol, [role="menu"]');
          const subItems = subList ? extractNavItemsRecursive(subList) : undefined;
          return { label, href, children: subItems && subItems.length > 0 ? subItems : undefined };
        })
        .filter((item) => item.label.length > 0);
    }

    // Sidebar
    const sidebarEl =
      document.querySelector(
        'nav[class*="side"], aside nav, [class*="sidebar"] nav, [class*="Sidebar"] nav, ' +
          '[class*="side-nav"], [class*="sidenav"], [role="navigation"][class*="side"]',
      ) ?? document.querySelector('aside, [class*="sidebar"]');

    const sidebarItems = sidebarEl
      ? extractNavItemsRecursive(sidebarEl)
      : extractItems('nav a, [role="navigation"] a').slice(0, 30);

    // Topbar/header nav
    const topbarEl = document.querySelector('header nav, [class*="topbar"], [class*="navbar"]');
    const topbarItems = topbarEl
      ? extractNavItemsRecursive(topbarEl)
      : [];

    // Breadcrumbs
    const breadcrumbEl = document.querySelector(
      '[aria-label="breadcrumb"], [class*="breadcrumb"], nav[class*="bread"], ol.breadcrumb',
    );
    const breadcrumbs = breadcrumbEl
      ? Array.from(breadcrumbEl.querySelectorAll('li, a, span')).map(
          (el) => el.textContent?.trim() ?? '',
        ).filter(Boolean)
      : [];

    // Tabs
    const tabs = Array.from(
      document.querySelectorAll('[role="tab"], [class*="tab-item"], [class*="TabItem"], .nav-tabs a'),
    )
      .map((el) => el.textContent?.trim() ?? '')
      .filter(Boolean);

    // Dropdown menus
    const dropdownItems = Array.from(
      document.querySelectorAll('[class*="dropdown-menu"] a, [class*="dropdownMenu"] a'),
    )
      .map((el) => ({
        label: el.textContent?.trim() ?? '',
        href: (el as HTMLAnchorElement).href || undefined,
      }))
      .filter((item) => item.label);

    // Page title
    const pageTitle =
      document.querySelector('h1, [class*="page-title"], [class*="PageTitle"]')?.textContent?.trim() ?? '';

    // Page headings
    const pageHeadings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((h) => h.textContent?.trim() ?? '')
      .filter(Boolean)
      .slice(0, 20);

    // Buttons (actions)
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a.btn'))
      .map((btn) => btn.textContent?.trim() ?? '')
      .filter(Boolean)
      .filter((text, idx, arr) => arr.indexOf(text) === idx)
      .slice(0, 30);

    // Modal triggers
    const modalTriggers = Array.from(
      document.querySelectorAll('[data-toggle="modal"], [data-bs-toggle="modal"], [data-modal]'),
    )
      .map((el) => el.textContent?.trim() ?? '')
      .filter(Boolean);

    return {
      sidebarItems: sidebarItems.slice(0, 50),
      topbarItems: topbarItems.slice(0, 20),
      breadcrumbs,
      tabs,
      dropdownMenus: dropdownItems.slice(0, 20),
      pageTitle,
      pageHeadings: pageHeadings.slice(0, 10),
      buttons: buttons.slice(0, 30),
      modalTriggers,
    };
  });
}
