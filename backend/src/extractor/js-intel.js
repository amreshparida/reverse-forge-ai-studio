/**
 * js-intel.js — injected into every page to extract JavaScript intelligence.
 * Captures: inline scripts, window globals, component trees, router config,
 * store shape, event listeners, source map hints, app config objects.
 * Plain JavaScript (no TypeScript) to avoid esbuild __name helpers.
 */

window.__reAiJsIntel = function() {
  var result = {
    inlineScripts: [],
    externalScripts: [],
    windowGlobals: {},
    reactComponents: [],
    vueComponents: [],
    clientRoutes: [],
    storeShape: {},
    appConfig: {},
    sourceMaps: [],
    eventListenerHints: [],
    webWorkers: [],
    webSockets: [],
    serviceWorkers: [],
    apiBaseUrls: [],
    featureFlags: {},
    i18nKeys: [],
    errors: [],
  };

  // ── Inline scripts ───────────────────────────────────────────────────────
  try {
    var scripts = Array.from(document.querySelectorAll('script:not([src])'));
    result.inlineScripts = scripts
      .map(function(s) { return (s.textContent || '').trim(); })
      .filter(function(t) { return t.length > 20 && t.length < 50000; })
      .map(function(t) { return t.slice(0, 5000); })  // limit size
      .slice(0, 10);
  } catch(e) { result.errors.push('inlineScripts: ' + e.message); }

  // ── External script URLs ─────────────────────────────────────────────────
  try {
    result.externalScripts = Array.from(document.querySelectorAll('script[src]'))
      .map(function(s) { return s.getAttribute('src'); })
      .filter(Boolean);
  } catch(e) { result.errors.push('externalScripts: ' + e.message); }

  // ── Source map hints (from script tags and link headers) ─────────────────
  try {
    result.sourceMaps = Array.from(document.querySelectorAll('script[src]'))
      .map(function(s) { return s.getAttribute('src') || ''; })
      .filter(function(src) { return src.endsWith('.js'); })
      .map(function(src) { return src + '.map'; })
      .slice(0, 10);
    // Also check for inline sourceMappingURL comments
    result.inlineScripts.forEach(function(s) {
      var match = s.match(/\/\/# sourceMappingURL=(.+)/);
      if (match) result.sourceMaps.push(match[1]);
    });
  } catch(e) {}

  // ── Non-standard window globals ───────────────────────────────────────────
  try {
    var standardGlobals = new Set([
      'window','document','navigator','location','history','screen','console',
      'alert','confirm','prompt','setTimeout','setInterval','clearTimeout',
      'clearInterval','requestAnimationFrame','cancelAnimationFrame','fetch',
      'XMLHttpRequest','WebSocket','Worker','localStorage','sessionStorage',
      'indexedDB','crypto','performance','matchMedia','getComputedStyle',
      'addEventListener','removeEventListener','dispatchEvent','postMessage',
      'open','close','focus','blur','print','stop','find','scroll','scrollTo',
      'scrollBy','resizeTo','resizeBy','moveTo','moveBy','innerWidth','innerHeight',
      'outerWidth','outerHeight','screenX','screenY','pageXOffset','pageYOffset',
      'scrollX','scrollY','devicePixelRatio','isSecureContext','origin',
      'caches','cookieStore','crossOriginIsolated','customElements','frames',
      'frameElement','globalThis','length','name','opener','parent','self',
      'top','visualViewport','queueMicrotask','structuredClone','reportError',
      'gc','caches','trustedTypes','Error','Object','Array','String','Number',
      'Boolean','Symbol','Function','Math','Date','RegExp','JSON','Promise',
      'Map','Set','WeakMap','WeakSet','Proxy','Reflect','Int8Array','Uint8Array',
      'Float32Array','Float64Array','ArrayBuffer','DataView','BigInt','undefined',
    ]);

    var interesting = {};
    Object.keys(window).forEach(function(key) {
      if (standardGlobals.has(key)) return;
      if (key.startsWith('__')) return; // skip internal helpers
      if (key.startsWith('webkit') || key.startsWith('moz')) return;
      try {
        var val = window[key];
        var type = typeof val;
        if (type === 'function') return; // skip plain functions
        if (val === null || val === undefined) return;
        if (type === 'object') {
          // Capture shape (keys only, not values) for objects
          var keys = Object.keys(val).slice(0, 20);
          if (keys.length > 0) {
            interesting[key] = { type: 'object', keys: keys };
          }
        } else if (type === 'string' || type === 'number' || type === 'boolean') {
          var strVal = String(val);
          if (strVal.length < 200) {
            interesting[key] = { type: type, value: strVal };
          }
        }
      } catch(e) { /* some globals throw on access */ }
    });
    result.windowGlobals = interesting;
  } catch(e) { result.errors.push('windowGlobals: ' + e.message); }

  // ── React component tree ─────────────────────────────────────────────────
  try {
    var reactHook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (reactHook && reactHook.renderers) {
      var components = new Set();
      // Walk fiber tree to collect component names
      function walkFiber(fiber, depth) {
        if (!fiber || depth > 15) return;
        try {
          var name = fiber.type && (
            fiber.type.displayName || fiber.type.name ||
            (typeof fiber.type === 'string' ? fiber.type : null)
          );
          if (name && name.length > 1 && name !== 'div' && name !== 'span' &&
              name !== 'Fragment' && !/^[a-z]/.test(name)) {
            components.add(name);
          }
          walkFiber(fiber.child, depth + 1);
          walkFiber(fiber.sibling, depth + 1);
        } catch(e) { /* fiber may be detached */ }
      }
      reactHook.renderers.forEach(function(renderer) {
        try {
          if (renderer.currentDispatcherRef) return; // skip internals
          var roots = renderer.getFiberRoots ? renderer.getFiberRoots(1) : null;
          if (roots) roots.forEach(function(root) { walkFiber(root.current, 0); });
        } catch(e) {}
      });
      result.reactComponents = Array.from(components).slice(0, 50);
    }
  } catch(e) { result.errors.push('react: ' + e.message); }

  // ── React Router routes ──────────────────────────────────────────────────
  try {
    // React Router v6 exposes __reactRouterVersion
    if (window.__reactRouterVersion || window.__RouterContext) {
      result.clientRoutes.push({ framework: 'React Router' });
    }
    // Try to find route config from window.__routes or similar
    ['__routes', '__ROUTES', 'routes', '_routes'].forEach(function(key) {
      if (window[key] && Array.isArray(window[key])) {
        window[key].forEach(function(r) {
          if (r && r.path) result.clientRoutes.push({ path: r.path, name: r.name });
        });
      }
    });
  } catch(e) {}

  // ── Vue component names ──────────────────────────────────────────────────
  try {
    var vueApp = window.__VUE__;
    if (!vueApp) {
      // Try to find Vue app from DOM
      var vueEl = document.querySelector('[data-v-app]') || document.getElementById('app');
      if (vueEl && vueEl._vei) vueApp = true;
    }
    if (vueApp) {
      var vueComponents = new Set();
      document.querySelectorAll('[data-v-app] *').forEach(function(el) {
        if (el.__vueParentComponent) {
          var name = el.__vueParentComponent.type && el.__vueParentComponent.type.__name;
          if (name) vueComponents.add(name);
        }
      });
      result.vueComponents = Array.from(vueComponents).slice(0, 50);
    }
  } catch(e) {}

  // ── State management ─────────────────────────────────────────────────────
  try {
    // Redux
    if (window.__REDUX_STORE__) {
      try {
        var state = window.__REDUX_STORE__.getState();
        result.storeShape['redux'] = { type: 'Redux', keys: Object.keys(state || {}).slice(0, 20) };
      } catch(e) {}
    }
    // React Query / TanStack Query
    if (window.__reactQueryClient || window.__REACT_QUERY_STATE__) {
      result.storeShape['react-query'] = { type: 'TanStack Query' };
    }
    // Zustand (stores are functions on window or module scope — hard to detect)
    // MobX
    if (window.__mobxGlobals) {
      result.storeShape['mobx'] = { type: 'MobX', version: window.__mobxGlobals.version };
    }
    // Pinia (Vue)
    if (window.__pinia) {
      var piniaStores = Object.keys(window.__pinia.state.value || {});
      result.storeShape['pinia'] = { type: 'Pinia', stores: piniaStores.slice(0, 20) };
    }
    // Vuex
    if (window.__vuex_store__) {
      result.storeShape['vuex'] = { type: 'Vuex', keys: Object.keys(window.__vuex_store__.state || {}).slice(0, 20) };
    }
    // NgRx / Angular
    if (window.ng) {
      result.storeShape['ngrx'] = { type: 'Angular/NgRx' };
    }
  } catch(e) { result.errors.push('store: ' + e.message); }

  // ── App config objects (common patterns) ────────────────────────────────
  try {
    var configKeys = ['APP_CONFIG', 'appConfig', '__APP_CONFIG__', 'CONFIG', 'config',
                      'APP_SETTINGS', 'appSettings', 'ENV', '__ENV', 'environment',
                      'SETTINGS', 'settings', 'featureFlags', 'features', 'flags'];
    configKeys.forEach(function(key) {
      try {
        var val = window[key];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          var safe = {};
          Object.keys(val).slice(0, 30).forEach(function(k) {
            var v = val[k];
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              // Mask anything that looks like a secret
              if (/secret|key|token|password|auth|api/i.test(k)) {
                safe[k] = '***';
              } else {
                safe[k] = String(v).slice(0, 100);
              }
            }
          });
          if (Object.keys(safe).length > 0) result.appConfig[key] = safe;
        }
      } catch(e) {}
    });

    // Feature flags patterns
    ['featureFlags', 'features', 'flags', '__featureFlags', 'LaunchDarkly',
     '__FEATURE_FLAGS__', 'posthog'].forEach(function(key) {
      try {
        var flags = window[key];
        if (flags && typeof flags === 'object') {
          Object.keys(flags).slice(0, 30).forEach(function(k) {
            var v = flags[k];
            if (typeof v === 'boolean') result.featureFlags[k] = v;
          });
        }
      } catch(e) {}
    });
  } catch(e) { result.errors.push('appConfig: ' + e.message); }

  // ── API base URLs from common patterns ───────────────────────────────────
  try {
    // Axios default baseURL
    if (window.axios && window.axios.defaults && window.axios.defaults.baseURL) {
      result.apiBaseUrls.push({ source: 'axios.defaults', url: window.axios.defaults.baseURL });
    }
    // OpenAPI/Swagger generated clients
    ['ApiClient', 'apiClient', 'API_BASE_URL', '__API_BASE_URL', 'BASE_URL',
     'baseUrl', 'BASE_PATH', 'basePath'].forEach(function(key) {
      try {
        var v = window[key];
        if (typeof v === 'string' && (v.startsWith('http') || v.startsWith('/'))) {
          result.apiBaseUrls.push({ source: key, url: v });
        }
      } catch(e) {}
    });
  } catch(e) {}

  // ── Web Workers ──────────────────────────────────────────────────────────
  try {
    // Can't enumerate active workers, but we can detect patterns
    var workerScripts = Array.from(document.querySelectorAll('script[src]'))
      .map(function(s) { return s.getAttribute('src') || ''; })
      .filter(function(src) { return /worker/i.test(src); });
    result.webWorkers = workerScripts;
  } catch(e) {}

  // ── Service Workers ──────────────────────────────────────────────────────
  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function(regs) {
        regs.forEach(function(reg) {
          result.serviceWorkers.push(reg.scope);
        });
      });
    }
  } catch(e) {}

  // ── i18n / translation keys (sample) ────────────────────────────────────
  try {
    ['i18n', '__i18n', 'I18N', 'translations', 'messages', 'locale'].forEach(function(key) {
      try {
        var obj = window[key];
        if (obj && typeof obj === 'object') {
          var keys = Object.keys(obj).slice(0, 20);
          if (keys.length > 0) result.i18nKeys = keys;
        }
      } catch(e) {}
    });
  } catch(e) {}

  return result;
};
