/**
 * browser-extract.js — pure JavaScript (no TypeScript, no esbuild transformation)
 * Injected into every page via page.addInitScript({ path }) before navigation.
 * Defines window.__reAiExtract(unsafePatterns) which the crawler calls via page.evaluate.
 */

window.__reAiExtract = function(unsafePatterns) {
  var unsafeRegexes = unsafePatterns.map(function(p) { return new RegExp(p, 'i'); });

  // Href patterns that indicate logout / session kill / SSO logout
  var LOGOUT_HREF_RE = /logout|log[_-]?out|sign[_-]?out|signout|sign[_-]?off|log[_-]?off|end[_-]?session|kill[_-]?session|terminate[_-]?session|destroy[_-]?session|invalidate[_-]?session|session[_-]?(end|kill|terminate|destroy|invalidate|expire)|force[_-]?logout|single[_-]?log[_-]?out|SingleLogOut|slo\b|discovery\?entityID|Shibboleth\.sso|\/idp\/|\/adfs\/|returnIDParam=idp|oauth2?\/logout|openid.*logout|endsession|revoke.*session/i;

  var LOGOUT_ATTR_RE = /logout|log[_-]?out|sign[_-]?out|signout|sign[_-]?off|log[_-]?off|end[_-]?session|kill[_-]?session|terminate[_-]?session|destroy[_-]?session|invalidate[_-]?session|session[_-]?(end|kill|terminate|destroy)|force[_-]?logout|slo\b/i;

  function isSafe(text) {
    return !unsafeRegexes.some(function(r) { return r.test(text); });
  }

  function isHrefSafe(href) {
    if (!href) return true;
    return !LOGOUT_HREF_RE.test(href);
  }

  function isLogoutControl(el, text, href) {
    if (text && LOGOUT_ATTR_RE.test(text)) return true;
    if (href && !isHrefSafe(href)) return true;
    var id = el.id || '';
    var className = el.className ? el.className.toString() : '';
    var dataAction = el.getAttribute('data-action') || el.getAttribute('data-testid') || '';
    var aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (LOGOUT_ATTR_RE.test(id) || LOGOUT_ATTR_RE.test(className) || LOGOUT_ATTR_RE.test(dataAction)) return true;
    if (aria && (LOGOUT_ATTR_RE.test(aria) || !isSafe(aria))) return true;
    return false;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function getUniqueSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var tag = el.tagName.toLowerCase();
    var classes = Array.from(el.classList)
      .filter(function(c) { return !/^(ng-|css-|svelte-)/.test(c) && c.length < 30; })
      .slice(0, 2);
    if (classes.length) return tag + '.' + classes.join('.');
    var text = (el.textContent || '').trim().slice(0, 25);
    if (text) return tag + ':text("' + text.replace(/"/g, "'") + '"):first';
    return tag;
  }

  function getDataAttrs(el) {
    var result = {};
    Array.from(el.attributes).forEach(function(attr) {
      if (attr.name.startsWith('data-')) result[attr.name] = attr.value.slice(0, 200);
    });
    return result;
  }

  function findLabel(el) {
    var id = el.getAttribute('id');
    if (id) {
      var lbl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lbl) return (lbl.textContent || '').trim();
    }
    var wrap = el.closest('label');
    if (wrap) {
      var clone = wrap.cloneNode(true);
      clone.querySelectorAll('input,select,textarea').forEach(function(c) { c.remove(); });
      return (clone.textContent || '').trim();
    }
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    var placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;
    return el.getAttribute('name') || '';
  }

  function classifyPage() {
    var url = window.location.href.toLowerCase();
    if (/login|signin|sign-in/.test(url)) return 'login';
    if (/setting|config|preference/.test(url)) return 'settings';
    if (/report|analytics|dashboard/.test(url)) return 'report';
    var forms = document.querySelectorAll('form').length;
    var tables = document.querySelectorAll('table, [role="grid"]').length;
    var h1Text = (document.querySelector('h1') || {}).textContent || '';
    h1Text = h1Text.toLowerCase();
    if (forms >= 1 && tables === 0) return 'form';
    if (tables >= 1) return 'list';
    var cards = document.querySelectorAll('[class*="card"],[class*="widget"],[class*="stat"]').length;
    if (cards > 3) return 'dashboard';
    if (/detail|view|show|profile/.test(h1Text)) return 'detail';
    return 'unknown';
  }

  // ── Headings ────────────────────────────────────────────────────────────
  var headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(function(h) {
    return { level: parseInt(h.tagName[1], 10), text: (h.textContent || '').trim(), id: h.id || undefined };
  }).filter(function(h) { return h.text; });

  // ── Breadcrumbs ─────────────────────────────────────────────────────────
  var breadcrumbs = Array.from(
    document.querySelectorAll('[aria-label*="breadcrumb"] *, [class*="breadcrumb"] li')
  ).map(function(el) { return (el.textContent || '').trim(); }).filter(Boolean);

  // ── All clickables ───────────────────────────────────────────────────────
  var seen = new Set();
  var allClickables = Array.from(document.querySelectorAll(
    'a[href], button, [role="button"], [role="menuitem"], [role="tab"], ' +
    'input[type="submit"], input[type="button"], [onclick], [data-action]'
  )).map(function(el) {
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    var href = el.href || el.getAttribute('href');
    var key = el.tagName + ':' + text.toLowerCase();
    if (!text || seen.has(key)) return null;
    seen.add(key);
    return {
      tag: el.tagName.toLowerCase(),
      text: text,
      href: href || undefined,
      type: el.type || el.getAttribute('type') || undefined,
      selector: getUniqueSelector(el),
      ariaLabel: el.getAttribute('aria-label') || undefined,
      role: el.getAttribute('role') || undefined,
      dataAttributes: getDataAttrs(el),
      // Mark unsafe if text matches patterns OR href/attrs look like logout/session-end
      isSafe: !isLogoutControl(el, text, href || el.getAttribute('href') || '') &&
        isSafe(text) &&
        isHrefSafe(href || el.getAttribute('href') || ''),
    };
  }).filter(Boolean).slice(0, 150);

  // ── Forms (deep) ─────────────────────────────────────────────────────────
  var formEls = Array.from(document.querySelectorAll('form, [role="form"]'));
  var forms = formEls.map(function(form) {
    var fields = Array.from(form.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select'
    )).map(function(el) {
      var type = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text');
      var options = el.tagName === 'SELECT'
        ? Array.from(el.options).map(function(o) { return { value: o.value, text: o.text.trim(), selected: o.selected }; })
        : undefined;
      return {
        name: el.name || el.id || '',
        id: el.id || undefined,
        type: type,
        label: findLabel(el),
        placeholder: el.getAttribute('placeholder') || undefined,
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
        readonly: el.readOnly || false,
        disabled: el.disabled || false,
        defaultValue: (el.defaultValue || '').slice(0, 100) || undefined,
        options: options,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        dataAttributes: getDataAttrs(el),
      };
    });
    var titleEl = form.querySelector('h1,h2,h3,h4,legend,[class*="title"]');
    var submitBtns = Array.from(form.querySelectorAll('button[type="submit"],input[type="submit"],button:not([type])')).map(function(b) {
      return { text: (b.textContent || '').trim() || b.value || '', type: b.type || 'submit' };
    }).filter(function(b) { return b.text; });
    return {
      id: form.id || undefined,
      action: form.action || undefined,
      method: form.method || undefined,
      title: titleEl ? (titleEl.textContent || '').trim() : undefined,
      fields: fields,
      submitButtons: submitBtns,
    };
  });

  // ── Tables (deep) ────────────────────────────────────────────────────────
  var tableEls = Array.from(document.querySelectorAll('table, [role="table"], [role="grid"]'));
  var tables = tableEls.map(function(table) {
    var headerCells = Array.from(table.querySelectorAll('thead th, [role="columnheader"]'));
    var columns = headerCells.map(function(th) {
      return { header: (th.textContent || '').trim(), sortable: th.hasAttribute('aria-sort') };
    }).filter(function(c) { return c.header; });
    var bodyRows = Array.from(table.querySelectorAll('tbody tr, [role="row"]:not([role="columnheader"])'));
    var container = table.closest('[class*="table"],[class*="Table"]') || table.parentElement;
    var searchEl = container ? container.querySelector('input[type="search"], input[placeholder*="search" i]') : null;
    return {
      id: table.id || undefined,
      title: container ? (container.querySelector('h1,h2,h3,h4,[class*="title"]') || {}).textContent : undefined,
      columns: columns,
      rowCount: bodyRows.length,
      hasCheckboxSelection: !!table.querySelector('input[type="checkbox"]'),
      hasExport: !!(container && container.querySelector('[class*="export"],[data-action*="export"]')),
      searchBox: searchEl ? { placeholder: searchEl.placeholder, selector: getUniqueSelector(searchEl) } : undefined,
    };
  });

  // ── Navigation ────────────────────────────────────────────────────────────
  function extractNavItems(el) {
    return Array.from(el.children).map(function(child) {
      var anchor = child.tagName === 'A' ? child : child.querySelector('a');
      var label = (anchor ? anchor.textContent : child.textContent || '').trim();
      var href = anchor ? (anchor.href || anchor.getAttribute('href') || undefined) : undefined;
      return { label: label, href: href };
    }).filter(function(i) { return i.label && i.label.length > 0 && i.label.length < 60; });
  }

  var sidebarEl = document.querySelector(
    'nav[class*="side"], aside nav, [class*="sidebar"] nav, [class*="Sidebar"]'
  ) || document.querySelector('aside');
  var topbarEl = document.querySelector('header nav, [class*="topbar"], [class*="Navbar"]');
  var tabs = Array.from(document.querySelectorAll('[role="tab"], [class*="tab-item"], .nav-tabs a')).map(function(el) {
    return { label: (el.textContent || '').trim(), active: el.getAttribute('aria-selected') === 'true' || el.classList.contains('active') };
  }).filter(function(t) { return t.label; });

  // ── Search ────────────────────────────────────────────────────────────────
  var searchBoxes = Array.from(document.querySelectorAll(
    'input[type="search"], input[placeholder*="search" i], input[aria-label*="search" i]'
  )).map(function(el) {
    return { placeholder: el.placeholder || el.getAttribute('aria-label') || 'Search', selector: getUniqueSelector(el), isGlobalSearch: !!el.closest('header, [class*="topbar"]') };
  }).filter(function(s, i, arr) { return arr.findIndex(function(x) { return x.placeholder === s.placeholder; }) === i; });

  // ── Modals ───────────────────────────────────────────────────────────────
  var modals = Array.from(document.querySelectorAll('[role="dialog"], .modal, [class*="Modal"]')).map(function(modal) {
    return {
      id: modal.id || undefined,
      title: (modal.querySelector('[class*="title"],h3,h4,h5') || {}).textContent || undefined,
      isVisible: window.getComputedStyle(modal).display !== 'none' && modal.getAttribute('aria-hidden') !== 'true',
      buttons: Array.from(modal.querySelectorAll('button')).map(function(b) { return (b.textContent || '').trim(); }).filter(Boolean),
    };
  }).slice(0, 10);

  // ── Cards ─────────────────────────────────────────────────────────────────
  var cards = Array.from(document.querySelectorAll('[class*="card"]:not(table):not(tr), [class*="stat-card"]')).slice(0, 20).map(function(el) {
    return {
      title: ((el.querySelector('[class*="title"],[class*="label"],h3,h4') || {}).textContent || '').trim() || undefined,
      value: ((el.querySelector('[class*="value"],[class*="count"],[class*="number"]') || {}).textContent || '').trim() || undefined,
    };
  }).filter(function(c) { return c.title || c.value; });

  // ── Alerts ───────────────────────────────────────────────────────────────
  var alerts = Array.from(document.querySelectorAll('[role="alert"], .alert, [class*="toast"]')).map(function(el) {
    var cls = el.className.toString();
    var type = /success|green/.test(cls) ? 'success' : /error|danger|red/.test(cls) ? 'error' : /warn|yellow/.test(cls) ? 'warning' : 'info';
    return { type: type, text: (el.textContent || '').trim().slice(0, 200) };
  }).filter(function(a) { return a.text; });

  // ── Tech stack ─────────────────────────────────────────────────────────
  var w = window;
  var frameworks = [];
  if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot]')) frameworks.push('React');
  if (w.__NEXT_DATA__) frameworks.push('Next.js');
  if (w.Vue || document.querySelector('[data-v-app]')) frameworks.push('Vue');
  if (w.__nuxt__) frameworks.push('Nuxt');
  if (w.ng || document.querySelector('[ng-version]')) frameworks.push('Angular');
  if (document.querySelector('[class*="svelte-"]')) frameworks.push('Svelte');
  var allCls = Array.from(document.querySelectorAll('[class]')).map(function(el) { return el.className.toString(); }).join(' ');
  var hasTailwind = /\b(flex|grid|text-\w+|bg-\w+|p-\d|m-\d|rounded|border-)/.test(allCls);
  var hasBootstrap = !!document.querySelector('.container,.btn,.row');
  var hasMUI = !!document.querySelector('[class*="Mui"]');
  var hasAntd = !!document.querySelector('[class*="ant-"]');
  var authHints = [];
  document.cookie.split(';').forEach(function(c) {
    var name = c.split('=')[0].trim().toLowerCase();
    if (/token|auth|jwt|session|csrf/.test(name)) authHints.push('cookie:' + name);
  });
  try {
    for (var i = 0; i < localStorage.length && i < 20; i++) {
      var k = localStorage.key(i) || '';
      if (/token|auth|jwt|user/.test(k.toLowerCase())) authHints.push('localStorage:' + k);
    }
  } catch(e) {}

  // ── Storage ────────────────────────────────────────────────────────────
  var lsItems = [], ssItems = [];
  try {
    for (var i = 0; i < localStorage.length && i < 30; i++) {
      var lk = localStorage.key(i) || '';
      var lv = localStorage.getItem(lk) || '';
      lsItems.push({ key: lk, valuePreview: lv.slice(0, 60), isAuthRelated: /token|auth|jwt|user/.test(lk.toLowerCase()) });
    }
    for (var i = 0; i < sessionStorage.length && i < 30; i++) {
      var sk = sessionStorage.key(i) || '';
      var sv = sessionStorage.getItem(sk) || '';
      ssItems.push({ key: sk, valuePreview: sv.slice(0, 60), isAuthRelated: /token|auth|jwt|user/.test(sk.toLowerCase()) });
    }
  } catch(e) {}

  // ── API hints ─────────────────────────────────────────────────────────
  var apiHints = [];
  document.querySelectorAll('[data-url],[data-api],[data-endpoint],[action]').forEach(function(el) {
    ['data-url','data-api','data-endpoint','action'].forEach(function(attr) {
      var val = el.getAttribute(attr);
      if (val && /^\/api|\/v\d|\/rest|\/graphql/.test(val)) apiHints.push(val);
    });
  });

  var visibleText = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 5000);

  return {
    url: window.location.href,
    title: document.title,
    metaDescription: (document.querySelector('meta[name="description"]') || {}).content || undefined,
    lang: document.documentElement.lang || undefined,
    pageType: classifyPage(),
    headings: headings,
    visibleText: visibleText,
    paragraphs: Array.from(document.querySelectorAll('p')).map(function(p) { return (p.textContent || '').trim(); }).filter(function(t) { return t.length > 10 && t.length < 400; }).slice(0, 15),
    breadcrumbs: breadcrumbs,
    allClickables: allClickables,
    forms: forms,
    tables: tables,
    navigation: {
      sidebar: sidebarEl ? extractNavItems(sidebarEl).slice(0, 50) : [],
      topbar: topbarEl ? extractNavItems(topbarEl).slice(0, 20) : [],
      breadcrumbs: breadcrumbs,
      tabs: tabs,
      dropdownMenus: [],
      currentModule: undefined,
    },
    modals: modals,
    searchBoxes: searchBoxes,
    cards: cards,
    charts: [],
    alerts: alerts,
    pagination: [],
    storage: { localStorage: lsItems, sessionStorage: ssItems },
    techStack: {
      frameworks: frameworks,
      cssFramework: hasMUI ? 'MUI' : hasAntd ? 'Ant Design' : hasTailwind ? 'Tailwind CSS' : hasBootstrap ? 'Bootstrap' : null,
      hasJQuery: !!(w.jQuery || w.$),
      hasSPA: frameworks.length > 0,
      authHints: authHints.slice(0, 10),
      apiPatterns: w.__APOLLO_CLIENT__ ? ['GraphQL/Apollo'] : [],
    },
    customDataAttributes: {},
    apiEndpointHints: Array.from(new Set(apiHints)),
  };
};
