/**
 * Safety rules — the crawler operates in READ-ONLY mode.
 * NEVER create, update, delete, submit, approve, send, pay, or change any data.
 */

export const UNSAFE_TEXT_PATTERNS: RegExp[] = [
  // CRUD mutations
  /\bdelete\b/i, /\bremove\b/i, /\bdestroy\b/i,
  /\bsave\b/i, /\bsave\s*(and|&)\s*(close|continue|next|exit)/i,
  /\bsubmit\b/i,
  /\bcreate\b/i, /\badd\s+new\b/i, /\bnew\s+(record|entry|item|user|employee|account)/i,
  /\bupdate\b/i, /\bedit\s+and\s+save\b/i, /\bapply\s+(changes|settings)\b/i,

  // Workflow / approval
  /\bapprove\b/i, /\breject\b/i, /\bdeny\b/i,
  /\baccept\b/i, /\bdecline\b/i, /\bconfirm\b/i,
  /\bassign\b/i, /\bunassign\b/i, /\bescalate\b/i,
  /\bwithdraw\b/i, /\brecall\b/i, /\bsign\s+off\b/i,
  /\bcertify\b/i, /\bauthoriz/i,
  /\bcomplet(e|ion)\b/i, /\bfinish\b/i,
  /\bmark\s+as\s+(complete|done|finished|approved|rejected)/i,
  /\bclose\s+(ticket|case|issue|request)\b/i,
  /\bresolve\b/i, /\bpublish\b/i, /\bunpublish\b/i,
  /\brelease\b/i, /\bdeploy\b/i, /\blaunch\b/i,

  // Account lifecycle
  /\barchive\b/i, /\bunarchive\b/i,
  /\bdisable\b/i, /\bdeactivate\b/i,
  /\bactivate\b/i, /\benable\b/i,
  /\bban\b/i, /\bunban\b/i, /\bblock\b/i, /\bunblock\b/i,
  /\bsuspend\b/i, /\bunsuspend\b/i, /\bterminate\b/i,
  /\boffboard\b/i, /\bdelete\s+account\b/i, /\bclose\s+account\b/i,

  // ── Logout / Sign-out / Session terminate (all variants) ──────────────
  /\blog[\s_-]*out\b/i,
  /\blogout\b/i,
  /\bsign[\s_-]*out\b/i,
  /\bsignout\b/i,
  /\bsign[\s_-]*off\b/i,
  /\blog[\s_-]*off\b/i,
  /\bend[\s_-]*(the[\s_-]*)?session\b/i,
  /\bkill[\s_-]*(the[\s_-]*)?session\b/i,
  /\bterminate[\s_-]*(the[\s_-]*)?session\b/i,
  /\bdestroy[\s_-]*(the[\s_-]*)?session\b/i,
  /\binvalidate[\s_-]*(the[\s_-]*)?session\b/i,
  /\bclear[\s_-]*(the[\s_-]*)?session\b/i,
  /\bexpire[\s_-]*(the[\s_-]*)?session\b/i,
  /\bsession[\s_-]*(end|kill|terminate|destroy|invalidate|expire|timeout)\b/i,
  /\bend[\s_-]*user[\s_-]*session\b/i,
  /\bforce[\s_-]*logout\b/i,
  /\bforced[\s_-]*log[\s_-]*out\b/i,
  /\blog[\s_-]*me[\s_-]*out\b/i,
  /\bsign[\s_-]*me[\s_-]*out\b/i,
  /\bexit[\s_-]*(app|application|system|portal|account)\b/i,
  /\bquit[\s_-]*(app|application|session|system|portal)\b/i,
  /\bclose[\s_-]*(session|account)\b/i,
  /\bdisconnect[\s_-]*(session|account|user)?\b/i,
  /\bsingle[\s_-]*log[\s_-]*out\b/i,
  /\bslo\b/i,
  // Arabic & common transliterations
  /تسجيل\s*الخروج/,            // Arabic: sign out
  /خروج/,                      // Arabic: exit
  /\bdeconnexion\b/i,          // French
  /\bdeconnect(er)?\b/i,
  /\babmelden\b/i,              // German
  /\bausloggen\b/i,
  /\bsair\b/i,
  /\bçıkış\b/i,                 // Turkish
  /\bsalir\b/i,                 // Spanish
  /\bcerrar[\s_-]*sesi[oó]n\b/i,
  /\besci\b/i,                  // Italian
  /\bdisconnetti\b/i,

  // Communications
  /\bsend\b/i,
  /\bnotif(y|ication)\b/i, /\balert\s+user\b/i,
  /\bbroadcast\b/i, /\binvite\b/i,

  // Financial
  /\bpay(ment)?\b/i, /\bcheckout\b/i, /\bpurchase\b/i,
  /\border\b/i, /\brefund\b/i, /\btransfer\b/i,
  /\bcharge\b/i, /\binvoic(e|ing)\b/i, /\bdisburse\b/i,

  // Data management
  /\bpurge\b/i, /\bwipe\b/i,
  /\bclear\s+(all|data|records)\b/i,
  /\breset\s+(all|data|password|settings|to\s+default)\b/i,
  /\btruncate\b/i, /\bmerge\b/i, /\bdeduplic/i,
  /\bimport\s+(data|file|csv|excel)\b/i,
  /\bbulk\s+(delete|update|remove|edit)\b/i,
  /\bforce\s+(delete|sync|update)\b/i,
  /\bsync\s+(now|all)\b/i,

  // System ops
  /\brestart\b/i, /\bshutdown\b/i,
  /\bkill\s+(process|job|session)\b/i,
  /\brebuild\b/i, /\breindex\b/i,
  /\bflush\s+(cache|queue)\b/i,

  // Cancel transactional
  /\bcancel\s+(order|booking|subscription|request|appointment|payment)\b/i,
];

export const SAFE_TEXT_PATTERNS: RegExp[] = [
  /\bview\b/i, /\bpreview\b/i, /\bdetails?\b/i,
  /\bsee\s+more\b/i, /\bread\s+more\b/i,
  /\bsearch\b/i, /\bfind\b/i, /\bfilter\b/i, /\bsort\b/i,
  /\bnext\b/i, /\bprevious?\b/i, /\bback\b/i,
  /\bexpand\b/i, /\bcollapse\b/i, /\bopen\b/i,
  /\btab\b/i, /\bshow\b/i, /\bhide\b/i,
  /\bload\s+more\b/i, /\bmore\b/i,
  /\brefresh\b/i, /\breload\b/i,
  /\bexport\b/i, /\bdownload\b/i, /\bprint\b/i, /\bpdf\b/i,
  /^\d+$/,
];

export const READ_ONLY_OPEN_TEXT_PATTERNS: RegExp[] = [
  /\bcreate\b/i,
  /\badd\s+new\b/i,
  /\bnew\s+(record|entry|item|user|employee|account|request|form)\b/i,
  /^\s*new\s*$/i,
  /^\s*add\s*$/i,
  /^\s*edit\s*$/i,
  /\bedit\s+(details?|record|item|profile|form)\b/i,
];

/** Shared source for browser scripts + Node — logout / session-kill URLs */
export const SESSION_END_HREF_PATTERN_SOURCE =
  // Match logout/signout even when glued to suffixes like logouta.get / logoutPage
  'log[_\\-]?out|sign[_\\-]?out|signout|sign[_\\-]?off|log[_\\-]?off|' +
  'end[_\\-]?session|kill[_\\-]?session|terminate[_\\-]?session|destroy[_\\-]?session|' +
  'invalidate[_\\-]?session|session[_\\/\\-]?(end|kill|terminate|destroy|invalidate|expire)|' +
  'force[_\\-]?logout|single[_\\-]?log[_\\-]?out|SingleLogOut|slo\\b|' +
  'discovery\\?entityID|Shibboleth\\.sso|\\/idp\\/|\\/adfs\\/|returnIDParam=idp|' +
  'oauth2?\\/logout|openid.*logout|endsession|revoke.*session';

export const SESSION_END_HREF_RE = new RegExp(SESSION_END_HREF_PATTERN_SOURCE, 'i');

export const UNSAFE_URL_PATTERNS: RegExp[] = [
  SESSION_END_HREF_RE,
  /\/logout/i, /\/signout/i, /\/sign-out/i, /\/log-out/i, /\/logoff/i, /\/sign-off/i,
  /\/end-?session/i, /\/kill-?session/i, /\/terminate-?session/i, /\/invalidate-?session/i,
  /\/session\/(end|kill|terminate|destroy|invalidate)/i,
  /\/delete\//i, /\/remove\//i, /\/destroy\//i, /\/terminate\//i,
  /\/disable\//i, /\/deactivate\//i,
  /\/archive\//i, /\/purge\//i, /\/wipe\//i,
  /\/reset-password/i, /\/payment/i, /\/checkout/i,
  /\/confirm\//i, /\/approve\//i, /\/reject\//i,
  /\/cancel\//i, /\/send\//i, /\/publish\//i, /\/deploy\//i,

  // SSO / SAML / OAuth / IdP patterns
  // These trigger re-authentication flows which break the crawl session
  /\/discovery\?entityID=/i,     // Shibboleth SP discovery
  /\/Shibboleth\.sso\//i,        // Shibboleth SSO endpoints
  /\/saml\//i,                   // Generic SAML
  /\/saml2\//i,
  /returnIDParam=idp/i,          // IdP discovery param
  /\/idp\//i,                    // Identity Provider
  /\/adfs\//i,                   // Microsoft ADFS
  /\/oauth2?\//i,                // OAuth
  /\/openid/i,                   // OpenID Connect
  /\/metadata\.xml/i,            // SAML metadata
  /\/SingleSignOn/i,             // SAML SSO
  /\/SingleLogOut/i,             // SAML SLO
  /\/wsFed/i,                    // WS-Federation
];

export const UNSAFE_SELECTOR_PATTERNS = [
  '[data-action="delete"]', '[data-action="remove"]', '[data-action="destroy"]',
  '[data-action="approve"]', '[data-action="reject"]', '[data-action="submit"]',
  '[data-action="cancel"]', '[data-action="publish"]', '[data-action="deactivate"]',
  '[data-action="logout"]', '[data-action="signout"]', '[data-action="sign-out"]',
  '[data-action="log-out"]', '[data-action="end-session"]', '[data-action="terminate-session"]',
  '[data-testid*="logout" i]', '[data-testid*="signout" i]', '[data-testid*="sign-out" i]',
  '[id*="logout" i]', '[id*="signout" i]', '[id*="sign-out" i]', '[id*="log-out" i]',
  '[class*="logout" i]', '[class*="signout" i]', '[class*="sign-out" i]', '[class*="log-out" i]',
  '[href*="logout" i]', '[href*="signout" i]', '[href*="sign-out" i]', '[href*="log-out" i]',
  '[href*="end-session" i]', '[href*="terminate-session" i]', '[href*="SingleLogOut" i]',
  '[data-confirm]',
  'form button[type="submit"]',
  'input[type="submit"]',
  '.btn-danger', '.delete', '.remove', '.destroy',
];

/** Attribute / id / class / data-* fingerprints for logout & session kill controls */
export const SESSION_END_ATTR_PATTERN_SOURCE =
  'logout|log[_\\-]?out|sign[_\\-]?out|signout|sign[_\\-]?off|log[_\\-]?off|' +
  'end[_\\-]?session|kill[_\\-]?session|terminate[_\\-]?session|destroy[_\\-]?session|' +
  'invalidate[_\\-]?session|session[_\\-]?(end|kill|terminate|destroy)|force[_\\-]?logout|slo\\b';

export const SESSION_END_ATTR_RE = new RegExp(SESSION_END_ATTR_PATTERN_SOURCE, 'i');

/** Human-readable summary injected into agent/navigator prompts */
export const SAFETY_SUMMARY = [
  'READ-ONLY MODE - NEVER click:',
  '- Save / Submit / Update / Delete / Remove',
  '- Approve / Reject / Confirm / Accept / Decline / Assign',
  '- Send (email, message, notification, invite)',
  '- Pay / Purchase / Checkout / Transfer / Refund',
  '- Activate / Deactivate / Enable / Disable / Ban / Block / Suspend',
  '- Archive / Publish / Deploy / Launch / Release',
  '- Merge / Import / Purge / Wipe / Reset data / Clear all',
  '- Logout / Log out / Sign out / Sign off / Log off',
  '- End session / Kill session / Terminate session / Invalidate session',
  '- Force logout / Single logout / Disconnect session / Exit application',
  '- Any control whose id/class/data-action/href looks like logout or session-end',
  '- Register / Sign up',
  '- Any form submit button (type="submit")',
  '- Any element with data-confirm attribute',
  '',
  'Opening Create/Edit/Add/New pages or modals is allowed only to inspect fields.',
  'Do not click the final commit button inside those forms.',
  '',
  'ONLY click: navigation links, tabs, menu items, View/Details/Preview,',
  'Create/Edit/Add/New openers, Search/Filter/Sort, Expand/Collapse,',
  'Export/Download/Print (read-only outputs).',
].join('\n');

/** True if text clearly means logout / end / kill / terminate session */
export function isSessionEndingText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return [
    /\blog[\s_-]*out\b/i,
    /\blogout\b/i,
    /\bsign[\s_-]*out\b/i,
    /\bsignout\b/i,
    /\bsign[\s_-]*off\b/i,
    /\blog[\s_-]*off\b/i,
    /\bend[\s_-]*(the[\s_-]*)?session\b/i,
    /\bkill[\s_-]*(the[\s_-]*)?session\b/i,
    /\bterminate[\s_-]*(the[\s_-]*)?session\b/i,
    /\bdestroy[\s_-]*(the[\s_-]*)?session\b/i,
    /\binvalidate[\s_-]*(the[\s_-]*)?session\b/i,
    /\bsession[\s_-]*(end|kill|terminate|destroy|invalidate|expire)\b/i,
    /\bforce[\s_-]*logout\b/i,
    /\blog[\s_-]*me[\s_-]*out\b/i,
    /\bsign[\s_-]*me[\s_-]*out\b/i,
    /\bsingle[\s_-]*log[\s_-]*out\b/i,
    /\bexit[\s_-]*(app|application|system|portal)\b/i,
    /\bquit[\s_-]*(app|application|session|system|portal)\b/i,
    /تسجيل\s*الخروج/,
    /\bdeconnexion\b/i,
    /\babmelden\b/i,
    /\bcerrar[\s_-]*sesi[oó]n\b/i,
  ].some((p) => p.test(trimmed));
}

export function isSessionEndingUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return SESSION_END_HREF_RE.test(url);
}

export function isSessionEndingAttrBlob(blob: string | null | undefined): boolean {
  if (!blob) return false;
  return SESSION_END_ATTR_RE.test(blob);
}

/** Combined check used by action builders / explorers */
export function isSessionEndingAction(opts: {
  text?: string | null;
  href?: string | null;
  id?: string | null;
  className?: string | null;
  dataAction?: string | null;
  ariaLabel?: string | null;
  title?: string | null;
  testId?: string | null;
}): boolean {
  if (opts.text && isSessionEndingText(opts.text)) return true;
  if (opts.ariaLabel && isSessionEndingText(opts.ariaLabel)) return true;
  if (opts.title && isSessionEndingText(opts.title)) return true;
  if (opts.href && isSessionEndingUrl(opts.href)) return true;
  const attrBlob = [opts.id, opts.className, opts.dataAction, opts.testId].filter(Boolean).join(' ');
  return isSessionEndingAttrBlob(attrBlob);
}

/** Return why a text is blocked, or null if safe */
export function getBlockReason(text: string): string | null {
  if (isSessionEndingText(text)) return 'blocked: logout/session-terminate control';
  for (const p of UNSAFE_TEXT_PATTERNS) {
    if (p.test(text.trim())) return `blocked by pattern ${p}`;
  }
  return null;
}

export function isUrlSafe(url: string, allowedDomains: string[], excludedUrls: string[]): boolean {
  try {
    const parsed = new URL(url);

    // Must be http or https
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    // Check excluded URLs
    for (const excluded of excludedUrls) {
      if (url.startsWith(excluded) || url.includes(excluded)) return false;
    }

    // Check unsafe URL patterns
    for (const pattern of UNSAFE_URL_PATTERNS) {
      if (pattern.test(url)) return false;
    }

    // Must be in allowed domains (if specified)
    if (allowedDomains.length > 0) {
      const hostname = parsed.hostname;
      const isAllowed = allowedDomains.some(
        (domain) => hostname === domain || hostname.endsWith('.' + domain),
      );
      if (!isAllowed) return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function isTextSafe(text: string, extraSafeSelectors: string[] = []): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Logout / session-end can NEVER be allow-listed via safeClickSelectors
  if (isSessionEndingText(trimmed)) return false;
  if (extraSafeSelectors.some((s) => trimmed.toLowerCase().includes(s.toLowerCase()))) return true;
  for (const p of UNSAFE_TEXT_PATTERNS) {
    if (p.test(trimmed)) return false;
  }
  return true;
}

export function isSafeToClick(
  text: string,
  href: string | null,
  extraSafeSelectors: string[] = [],
): boolean {
  if (isSessionEndingAction({ text, href })) return false;
  if (href && !isUrlSafe(href, [], [])) return false;
  return isTextSafe(text, extraSafeSelectors);
}

export function isReadOnlyOpenAction(text: string): boolean {
  const trimmed = text.trim();
  return READ_ONLY_OPEN_TEXT_PATTERNS.some((p) => p.test(trimmed));
}

export function isSafeExplorationClick(
  text: string,
  href: string | null | undefined,
  extraSafeSelectors: string[] = [],
  opts: { isFormSubmit?: boolean; actionKind?: string; id?: string; className?: string; dataAction?: string } = {},
): boolean {
  if (isSessionEndingAction({
    text,
    href,
    id: opts.id,
    className: opts.className,
    dataAction: opts.dataAction,
  })) return false;
  if (href && !isUrlSafe(href, [], [])) return false;
  if (opts.isFormSubmit || opts.actionKind === 'submit') return false;
  if (isReadOnlyOpenAction(text) && (opts.actionKind === 'navigation' || opts.actionKind === 'modal' || opts.actionKind === 'form-open' || opts.actionKind === 'table-action')) {
    return true;
  }
  return isTextSafe(text, extraSafeSelectors);
}
