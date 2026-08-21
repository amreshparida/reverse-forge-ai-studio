/**
 * browser-observe.js — plain JavaScript (no TypeScript/esbuild).
 * Injected into the page to define window.__reAiObserve().
 * Called by observer.ts via page.evaluate.
 */

window.__reAiObserve = function(unsafePatterns) {
  var unsafeRegexes = unsafePatterns.map(function(p) { return new RegExp(p, 'i'); });

  // Href / URL patterns that always indicate logout / session kill / SSO logout
  var LOGOUT_HREF_RE = /logout|log[_-]?out|sign[_-]?out|signout|sign[_-]?off|log[_-]?off|end[_-]?session|kill[_-]?session|terminate[_-]?session|destroy[_-]?session|invalidate[_-]?session|session[_-]?(end|kill|terminate|destroy|invalidate|expire)|force[_-]?logout|single[_-]?log[_-]?out|SingleLogOut|slo\b|discovery\?entityID|Shibboleth\.sso|\/idp\/|\/adfs\/|returnIDParam=idp|oauth2?\/logout|openid.*logout|endsession|revoke.*session/i;

  // id / class / data-action / data-testid fingerprints
  var LOGOUT_ATTR_RE = /logout|log[_-]?out|sign[_-]?out|signout|sign[_-]?off|log[_-]?off|end[_-]?session|kill[_-]?session|terminate[_-]?session|destroy[_-]?session|invalidate[_-]?session|session[_-]?(end|kill|terminate|destroy)|force[_-]?logout|slo\b/i;

  function isSafeText(text) {
    return !unsafeRegexes.some(function(r) { return r.test(text); });
  }

  function isLogoutControl(el, text, href) {
    if (text && LOGOUT_ATTR_RE.test(text)) return true;
    if (href && LOGOUT_HREF_RE.test(href)) return true;
    var id = el.id || '';
    var className = el.className ? el.className.toString() : '';
    var dataAction = el.getAttribute('data-action') || el.getAttribute('data-testid') || '';
    var aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (LOGOUT_ATTR_RE.test(id) || LOGOUT_ATTR_RE.test(className) || LOGOUT_ATTR_RE.test(dataAction)) return true;
    if (aria && (LOGOUT_ATTR_RE.test(aria) || unsafeRegexes.some(function(r) { return r.test(aria); }))) return true;
    return false;
  }

  function isReadOnlyOpenText(text) {
    return /\bcreate\b/i.test(text) ||
      /\badd\s+new\b/i.test(text) ||
      /\bnew\s+(record|entry|item|user|employee|account|request|form)\b/i.test(text) ||
      /^\s*new\s*$/i.test(text) ||
      /^\s*add\s*$/i.test(text) ||
      /^\s*edit\s*$/i.test(text) ||
      /\bedit\s+(details?|record|item|profile|form)\b/i.test(text);
  }

  function closest(el, selector) {
    return el.closest ? el.closest(selector) : null;
  }

  function isHashOrJsHref(href) {
    if (!href) return true;
    if (/^#|^javascript:/i.test(href)) return true;
    // Browser resolves href="#" to https://host/path#
    try {
      var u = new URL(href, window.location.href);
      return u.hash === '#' || /#$/.test(href);
    } catch (e) {
      return false;
    }
  }

  function classifyAction(el, text, href) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role') || '';
    var type = (el.getAttribute('type') || '').toLowerCase();
    var dataToggle = (el.getAttribute('data-bs-toggle') || el.getAttribute('data-toggle') || '').toLowerCase();
    var className = el.className ? el.className.toString() : '';
    var lower = text.toLowerCase();

    if (isLogoutControl(el, text, href)) return 'unsafe';
    if (type === 'submit' || closest(el, 'form') && tag === 'button' && (!type || type === 'submit')) return 'submit';
    // Account/avatar menus — treat as unsafe for exploration (contain Logout)
    if (/navbar-avatar|dropdown-toggle|avatar|user-menu|account-menu|wb-power/i.test(className + ' ' + text) &&
        (dataToggle === 'dropdown' || role === 'menuitem' || /logout/i.test(href || ''))) {
      if (isLogoutControl(el, text, href) || /logout|wb-power/i.test(className + ' ' + text + ' ' + (href || ''))) return 'unsafe';
    }
    if (role === 'menuitem' && isLogoutControl(el, text, href)) return 'unsafe';
    if (href && !isHashOrJsHref(href)) return 'navigation';
    if (dataToggle === 'modal' || el.getAttribute('data-modal') || el.getAttribute('aria-haspopup') === 'dialog' || /modal|dialog/i.test(className)) return 'modal';
    if (/view|preview|details?|open|show|read more/i.test(text)) return 'detail';
    if (isReadOnlyOpenText(text)) return 'form-open';
    if (role === 'tab' || /expand|collapse|accordion|tab/i.test(lower + ' ' + className)) return 'toggle';
    if (/^(next|previous|prev|\d+)$/i.test(lower) || /paginat/i.test(className)) return 'pagination';
    if (closest(el, 'tr,[role="row"]')) return 'table-action';
    if (!isSafeText(text)) return 'unsafe';
    return 'other';
  }

  function isSafe(el, text, href, actionKind) {
    if (isLogoutControl(el, text, href)) return false;
    if (href && LOGOUT_HREF_RE.test(href)) return false;
    if (actionKind === 'submit' || actionKind === 'unsafe') return false;
    if (isReadOnlyOpenText(text) && /^(navigation|modal|form-open|table-action)$/.test(actionKind)) return true;
    return isSafeText(text);
  }

  function uniqueSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var tag = el.tagName.toLowerCase();
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    // Text-scoped selectors beat generic Bootstrap class combos like button.btn.btn-sm
    // (those often match a window.close() control first).
    if (text) {
      var escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return tag + ':has-text("' + escaped + '"):visible';
    }
    var aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (aria) {
      return tag + '[aria-label="' + aria.replace(/"/g, '\\"') + '"], ' + tag + '[title="' + aria.replace(/"/g, '\\"') + '"]';
    }
    var classes = Array.from(el.classList)
      .filter(function(c) {
        return !/^(ng-|css-|svelte-|d-(none|sm|md|lg|xl|xxl)|hidden-|visible-|col-|row$|container|btn$|btn-sm$|btn-xs$|btn-lg$|pull-right|pull-left|top-\d+)/.test(c);
      })
      .slice(0, 3)
      .join('.');
    if (classes) return tag + '.' + classes;
    return tag;
  }

  function isWindowCloseControl(el, text) {
    var onclick = (el.getAttribute('onclick') || '') + ' ' + (el.getAttribute('href') || '');
    if (/window\s*\.\s*close\s*\(|self\s*\.\s*close\s*\(/i.test(onclick)) return true;
    if (/^\s*[×x✕✖]\s*$/i.test(text || '')) {
      var cls = el.className ? el.className.toString() : '';
      if (/close|dismiss|pull-right|btn-dark/i.test(cls)) return true;
    }
    var aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
    if (/close\s*(window|tab|dialog)?/.test(aria) && /window\s*\.\s*close/i.test(onclick)) return true;
    return false;
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    var style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch (e) { /* older browsers */ }
    }
    var rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    // Off-screen responsive duplicates (common Bootstrap mobile nav clones)
    if (rect.bottom < 0 || rect.right < 0 || rect.top > (window.innerHeight || 0) + 50) return false;
    return true;
  }

  function labelFor(el) {
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (text) return text;
    var aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder');
    if (aria) return aria.trim();
    var id = el.id;
    if (id) {
      var label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (label && label.textContent) return label.textContent.trim().replace(/\s+/g, ' ');
    }
    var wrapped = closest(el, 'label');
    if (wrapped && wrapped.textContent) return wrapped.textContent.trim().replace(/\s+/g, ' ');
    var name = el.getAttribute('name') || el.getAttribute('data-testid') || el.getAttribute('data-field') || '';
    return name.trim();
  }

  function classifyPageType() {
    var url = window.location.href.toLowerCase();
    var title = (document.title || '').toLowerCase();
    if (/login|signin|sign-in|auth|forgot|reset.?password/.test(url)) return 'login';
    if (/^\s*log\s*in\s*$/i.test(title) || /sign\s*in|forgot\s*password|reset\s*password/i.test(title)) return 'login';
    if (/setting|config|preference/.test(url)) return 'settings';
    var h1 = ((document.querySelector('h1') || {}).textContent || '').toLowerCase();
    var forms = document.querySelectorAll('form, [role="form"]').length;
    var tables = document.querySelectorAll('table, [role="grid"]').length;
    var cards = document.querySelectorAll('[class*="card"], [class*="widget"]').length;
    // Password forms on auth screens
    if (document.querySelector('input[type="password"]') && forms > 0 && tables === 0) return 'login';
    if (forms > tables && forms > cards) return 'form';
    if (tables > 0) return 'list';
    if (cards > 2) return 'dashboard';
    if (/detail|view|show/.test(h1)) return 'detail';
    return 'unknown';
  }

  // Gather interactive elements
  var candidates = Array.from(document.querySelectorAll(
    'a[href], button:not([disabled]), input:not([type="hidden"]), select, ' +
    '[role="button"], [role="menuitem"], [role="tab"], [role="link"], ' +
    '[class*="nav-item"], [class*="menu-item"], [class*="sidebar-item"]'
  ));

  var elements = [];
  var seen = new Set();

  candidates.forEach(function(el, rawIdx) {
    if (!isElementVisible(el)) return;
    var text = labelFor(el).slice(0, 80);
    if (!text) return;
    if (isWindowCloseControl(el, text)) return;
    // Auth dead-ends — never explore after a successful login session
    if (/forgot\s*password|reset\s*password|sign\s*up|create\s*account|register/i.test(text)) return;
    var key = el.tagName + ':' + text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    var tag = el.tagName.toLowerCase();
    var href = el.href || el.getAttribute('href') || undefined;
    var type = el.getAttribute('type') || undefined;
    var actionKind = classifyAction(el, text, href);
    if (tag === 'select') actionKind = 'dropdown';
    if (tag === 'input' || tag === 'textarea') actionKind = type === 'submit' ? 'submit' : 'field';
    var isFormSubmit = actionKind === 'submit';
    var isNavigation = tag === 'a' ||
      el.getAttribute('role') === 'tab' ||
      el.getAttribute('role') === 'menuitem' ||
      /nav|menu|sidebar/i.test(el.className ? el.className.toString() : '');
    var row = closest(el, 'tr,[role="row"]');
    var rowKey = row ? 'row-action' : '';
    var actionKey = [
      actionKind,
      tag,
      (href || '').replace(/[?#].*$/, ''),
      text.toLowerCase(),
      rowKey
    ].filter(Boolean).join('|');

    elements.push({
      index: rawIdx,
      tag: tag,
      text: text,
      selector: uniqueSelector(el),
      type: type,
      href: href,
      options: tag === 'select'
        ? Array.from(el.querySelectorAll('option')).map(function(o) { return (o.textContent || o.value || '').trim(); }).filter(Boolean).slice(0, 40)
        : undefined,
      actionKey: actionKey,
      actionKind: actionKind,
      isFormSubmit: isFormSubmit,
      isSafe: isSafe(el, text, href || el.getAttribute('href') || '', actionKind),
      isNavigation: isNavigation,
    });
  });

  // Navigation items
  var navItems = Array.from(document.querySelectorAll('nav a, [class*="sidebar"] a, [class*="menu"] a'))
    .map(function(a) { return (a.textContent || '').trim(); })
    .filter(function(t) { return t.length > 0; })
    .filter(function(t, i, arr) { return arr.indexOf(t) === i; })
    .slice(0, 30);

  // Breadcrumbs
  var breadcrumbs = Array.from(document.querySelectorAll(
    '[aria-label*="breadcrumb"] *, [class*="breadcrumb"] li, [class*="Breadcrumb"] li'
  ))
    .map(function(el) { return (el.textContent || '').trim(); })
    .filter(Boolean);

  return {
    url: window.location.href,
    title: document.title,
    visibleText: ((document.body || {}).innerText || '').replace(/\s+/g, ' ').slice(0, 1200),
    interactiveElements: elements.filter(function(e) { return e.isSafe; }).slice(0, 80),
    navigationItems: navItems,
    breadcrumbs: breadcrumbs,
    hasForm: document.querySelectorAll('form, [role="form"]').length > 0,
    hasTables: document.querySelectorAll('table, [role="grid"]').length > 0,
    hasModal: document.querySelectorAll('[role="dialog"], .modal, [class*="modal"]').length > 0,
    pageType: classifyPageType(),
  };
};
