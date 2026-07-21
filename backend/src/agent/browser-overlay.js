/**
 * browser-overlay.js — plain JavaScript (no TypeScript/esbuild).
 * Injected into every page to define window.__reAiOverlay.
 *
 * Color scheme:
 *   blue   (#3b82f6) — navigation links / tabs / menu items
 *   green  (#10b981) — form inputs / selects / textareas
 *   orange (#f59e0b) — buttons (safe)
 *   purple (#8b5cf6) — other interactive (role=button, etc.)
 *   red    (#ef4444) — unsafe elements (blocked by safety rules)
 */

window.__reAiOverlay = {

  inject: function(elements) {
    window.__reAiOverlay.remove();

    var container = document.createElement('div');
    container.id = '__re-ai-overlay__';
    container.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'width:100vw',
      'height:100vh',
      'pointer-events:none',
      'z-index:2147483647',
      'overflow:visible',
    ].join(';');

    var labeled = 0;

    elements.forEach(function(el) {
      // Locate the element in the DOM
      var domEl = null;
      try {
        if (el.selector && el.selector.startsWith('#')) {
          domEl = document.getElementById(el.selector.slice(1));
        }
        if (!domEl && el.selector) {
          domEl = document.querySelector(el.selector);
        }
      } catch(e) { /* invalid selector — skip */ }

      if (!domEl) return;

      var rect = domEl.getBoundingClientRect();

      // Skip invisible or off-viewport elements
      if (!rect.width && !rect.height) return;
      if (rect.bottom < 0 || rect.top > window.innerHeight) return;
      if (rect.right < 0 || rect.left > window.innerWidth) return;

      // Pick color
      var color;
      if (!el.isSafe) {
        color = '#ef4444'; // red — unsafe (should not be clicked)
      } else if (el.isNavigation || el.tag === 'a') {
        color = '#3b82f6'; // blue — navigation
      } else if (el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea') {
        color = '#10b981'; // green — form field
      } else if (el.tag === 'button' || el.type === 'submit' || el.role === 'button') {
        color = '#f59e0b'; // orange — button
      } else {
        color = '#8b5cf6'; // purple — other interactive
      }

      // Bounding box outline
      var box = document.createElement('div');
      box.style.cssText = [
        'position:fixed',
        'left:' + rect.left + 'px',
        'top:' + rect.top + 'px',
        'width:' + rect.width + 'px',
        'height:' + rect.height + 'px',
        'border:2px solid ' + color,
        'border-radius:3px',
        'pointer-events:none',
        'box-sizing:border-box',
      ].join(';');

      // Number badge (top-left corner, above the element)
      var badge = document.createElement('div');
      badge.textContent = String(el.index);
      var badgeTop = Math.max(0, rect.top - 18);
      badge.style.cssText = [
        'position:fixed',
        'left:' + Math.max(0, rect.left) + 'px',
        'top:' + badgeTop + 'px',
        'background:' + color,
        'color:#fff',
        'font-size:11px',
        'font-weight:700',
        'font-family:ui-monospace,monospace',
        'padding:1px 4px',
        'border-radius:3px',
        'line-height:15px',
        'pointer-events:none',
        'white-space:nowrap',
        'min-width:16px',
        'text-align:center',
      ].join(';');

      container.appendChild(box);
      container.appendChild(badge);
      labeled++;
    });

    document.body.appendChild(container);
    return labeled;
  },

  remove: function() {
    var el = document.getElementById('__re-ai-overlay__');
    if (el) el.remove();
  },
};
