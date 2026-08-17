# 08 — Safety System

## Design Principle

The crawler is a **read-only observer**. It must never:
- Log out an active session
- Trigger an SSO/SAML re-authentication flow
- Submit forms that write data
- Click delete, remove, or terminate actions
- Approve or reject pending items

This is enforced through three independent layers, so a single bypass cannot cause harm.

Captured data is treated as sensitive. The API binds to loopback by default, requires an API token before remote binding, never returns stored project LLM keys, and masks credential-like headers, URL parameters, and nested payload keys before persistence. Recorder snapshots flush pending response handlers before writing a page window.

---

## Layer 1 — Text Pattern Matching

Maintained in `backend/src/crawler/safety.ts`.

### Unsafe text patterns (60+ entries)

Covers destructive actions in multiple languages:

```
Logout, Log out, Sign out, Sign Off, Exit, End session
Delete, Remove, Terminate, Disable, Deactivate, Archive
Submit, Approve, Reject, Deny, Confirm deletion
تسجيل الخروج (Arabic — logout)
Déconnexion (French — logout)
Salir (Spanish — exit)
Выйти (Russian — logout)
```

The text check is **case-insensitive** and **partial-match** — "Sign Out" matches a button labeled "Sign Out of MyApp".

### How it's applied

Every clickable element discovered by `browser-extract.js` or `browser-observe.js` is checked:

```js
isSafe(elementText, elementHref)
```

If either check fails, the element is:
- Colored **red** in the annotated screenshot overlay
- Excluded from the list of clickable elements sent to the LLM navigator
- Never included in discovered navigation links

---

## Layer 2 — URL / Href Pattern Matching

### LOGOUT_HREF_RE

Applied to the `href` attribute of every link before it is clicked:

```
/logout, /signout, /sign-out, /logoff, /log-off
/auth/logout, /sso/logout, /saml/logout, /oidc/logout
/disconnect, /deauth
```

### UNSAFE_URL_PATTERNS

Checked against the full URL before a page navigation is attempted:

```
?logout=true, ?signout=true
/auth/logout, /sso/logout, /saml/logout
/oidc/end-session
/adfs/ls/?wa=wsignout
SingleLogOut (SAML SLO endpoints)
Shibboleth.sso
discovery?entityID=              (Shibboleth SP discovery — SSO redirect)
returnIDParam=idp                (IdP redirect parameter)
/idp/                            (Identity Provider paths)
```

**This catches SSO logout even when the logout doesn't say "logout"** — for example, a dashboard link that href-redirects through a Shibboleth discovery endpoint.

---

## Layer 3 — Pre-click Safety in ActionBuilder

`backend/src/agent/action-builder.ts` re-checks safety **at execution time**, immediately before any Playwright click or navigate call. This catches cases where:

- The element text was safe but the `href` was unsafe
- The LLM chose an element that slipped through earlier filtering
- The page had dynamically rendered content after the initial scan

If the pre-click check fails, the action returns `{ success: false, reason: "SAFETY_BLOCK: ..." }` and the LLM agent moves on.

---

## Layer 4 — LLM Prompt Injection

A `SAFETY_SUMMARY` string is prepended to every LLM navigation prompt:

```
You are a read-only documentation assistant analyzing a web application.
NEVER take any action that:
  - Logs out, signs out, or ends the session
  - Deletes, removes, terminates, or archives any record
  - Submits, approves, rejects, or confirms any action
  - Navigates to SSO, SAML, or identity provider URLs
Your role is observation and documentation only.
```

This is a soft guardrail — the LLM may still return an unsafe action, which is why Layers 1–3 exist as hard blocks.

---

## Login Page Detection

The crawler must not treat an SSO redirect as a normal page to index. The `isLoginPage()` function in `crawler/index.ts` detects:

- URL path includes `/login`, `/auth/login`, `/signin`
- URL query includes `returnUrl=`, `redirect_uri=`, `next=`
- URL matches SSO patterns: `discovery?entityID=`, `/Shibboleth.sso/`, `returnIDParam=idp`
- Page title contains "Sign In", "Log In", "Authentication Required"

When a login page is detected during crawl, the URL is skipped (not crawled, not added to queue).

---

## Configuring Excluded URLs

For apps with complex SSO setups, add known SSO paths to **Excluded URLs** on the project:

```
/auth/shibboleth
/Shibboleth.sso
/discovery
/idp/profile
/adfs/ls
```

This prevents these URLs from even entering the queue, providing an early exit before any pattern matching.

---

## What Is Not Blocked

By design, the safety system only blocks destructive or session-ending actions. The crawler **will** visit:

- Settings and configuration pages (read-only view)
- Admin panels (read, no write)
- User profile pages
- Reports and dashboards
- Any page the authenticated user can navigate to

If a page contains only destructive actions (e.g. a "Delete All Data" confirmation page), the crawler will visit and screenshot it but all interactive elements will be marked red and none will be clicked.

---

## Extending the Safety Rules

To add new patterns, edit `backend/src/crawler/safety.ts`:

```typescript
// Add to UNSAFE_TEXT_PATTERNS array:
/terminate contract/i,
/close account/i,

// Add to UNSAFE_URL_PATTERNS array:
'/billing/cancel',
'/account/close',
```

Both plain strings and regular expressions are supported.
