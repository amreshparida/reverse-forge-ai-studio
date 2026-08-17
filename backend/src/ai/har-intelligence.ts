import type { HarEntry, HarLog } from '../recorder';
import { loadHarFilesForSessions, type LoadedHarFile } from './har-summary';

export type HostCategory =
  | 'first-party'
  | 'cdn'
  | 'analytics'
  | 'auth'
  | 'payments'
  | 'error-tracking'
  | 'fonts'
  | 'maps'
  | 'chat'
  | 'ads'
  | 'unknown-third-party';

export interface HostInsight {
  host: string;
  category: HostCategory;
  requestCount: number;
  resourceMix: Record<string, number>;
  sampleUrls: string[];
}

export interface EndpointInsight {
  method: string;
  urlPattern: string;
  count: number;
  statuses: Record<string, number>;
  p50Ms: number;
  p95Ms: number;
  resourceTypes: string[];
  graphqlOperation?: string;
  samplePageUrls: string[];
  schemaHint?: string[];
}

export interface PageSequenceCall {
  method: string;
  url: string;
  status: number;
  timeMs: number;
  resourceType: string;
}

export interface PageSequence {
  pageUrl: string;
  sourceFile: string;
  documentStatus?: number;
  callCount: number;
  calls: PageSequenceCall[];
}

export interface AuthSignals {
  status401: number;
  status403: number;
  authorizationHeaderPresent: boolean;
  setCookiePresent: boolean;
  csrfHeaderPresent: boolean;
  cookieNames: string[];
  wwwAuthenticate: string[];
}

export interface HarIntelligenceBriefing {
  generatedAt: string;
  projectSlug: string;
  sourceSessionIds: string[];
  stats: {
    harFiles: number;
    entries: number;
    uniqueHosts: number;
    uniqueEndpoints: number;
    pages: number;
    xhrFetchCount: number;
  };
  resourceMix: Record<string, number>;
  hosts: HostInsight[];
  endpoints: EndpointInsight[];
  pageSequences: PageSequence[];
  auth: AuthSignals;
  graphqlOperations: Array<{ name: string; count: number; sampleUrl: string }>;
  errors: Array<{ method: string; urlPattern: string; status: number; count: number }>;
  slowest: Array<{ method: string; url: string; timeMs: number; pageUrl: string }>;
  facts: string[];
}

const THIRD_PARTY_RULES: Array<{ category: HostCategory; match: RegExp }> = [
  { category: 'analytics', match: /google-analytics|googletagmanager|gtm\.|mixpanel|amplitude|segment\.|hotjar|fullstory|heap-|clarity\.ms|newrelic|datadoghq/i },
  { category: 'ads', match: /doubleclick|googlesyndication|adservice|facebook\.net|fbcdn|tiktok|linkedin\.com\/px/i },
  { category: 'error-tracking', match: /sentry\.io|bugsnag|rollbar|honeycomb|logrocket/i },
  { category: 'payments', match: /stripe|paypal|braintree|adyen|checkout\.com/i },
  { category: 'auth', match: /auth0|okta|onelogin|login\.microsoftonline|accounts\.google|cognito|keycloak/i },
  { category: 'cdn', match: /cloudflare|cloudfront|akamai|fastly|jsdelivr|unpkg|cdnjs|azureedge|fbcdn/i },
  { category: 'fonts', match: /fonts\.googleapis|fonts\.gstatic|typekit|use\.fontawesome/i },
  { category: 'maps', match: /maps\.googleapis|mapbox|here\.com|openstreetmap/i },
  { category: 'chat', match: /intercom|zendesk|drift\.com|livechat|crisp\.chat/i },
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] ?? 0);
}

export function templateUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}')
      .replace(/[0-9a-f]{32,}/gi, '{hash}')
      .replace(/\b\d{4,}\b/g, '{id}');
    return `${u.origin}${path}`;
  } catch {
    return raw
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}')
      .replace(/\b\d{4,}\b/g, '{id}');
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function registrable(host: string): string {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  const needle = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === needle)?.value;
}

function classifyHost(host: string, firstPartyRoots: Set<string>): HostCategory {
  if ([...firstPartyRoots].some((root) => host === root || host.endsWith('.' + root))) return 'first-party';
  for (const rule of THIRD_PARTY_RULES) {
    if (rule.match.test(host)) return rule.category;
  }
  return 'unknown-third-party';
}

function schemaKeysFromBody(text: string | undefined): string[] | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>).slice(0, 20);
    }
    if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object') {
      return Object.keys(parsed[0] as Record<string, unknown>).slice(0, 20);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function graphqlName(entry: HarEntry): string | undefined {
  const url = entry.request.url.toLowerCase();
  const post = entry.request.postData?.text;
  if (post) {
    try {
      const json = JSON.parse(post) as Record<string, unknown>;
      if (typeof json['operationName'] === 'string') return json['operationName'];
    } catch {
      /* ignore */
    }
  }
  if (/graphql|gql/.test(url)) return '(unnamed)';
  return undefined;
}

function isApiLike(rt: string): boolean {
  return rt === 'xhr' || rt === 'fetch' || rt === 'websocket';
}

export function buildHarIntelligence(args: {
  projectSlug: string;
  sourceSessionIds: string[];
  files?: LoadedHarFile[];
  maxFiles?: number;
}): HarIntelligenceBriefing {
  const files = args.files ?? loadHarFilesForSessions(args.projectSlug, args.sourceSessionIds, args.maxFiles ?? 200);

  const documentHosts: string[] = [];
  const allEntries: Array<{ entry: HarEntry; pageUrl: string; sourceFile: string }> = [];

  for (const file of files) {
    const pageUrl = file.pageUrl;
    for (const entry of file.har.log.entries) {
      allEntries.push({ entry, pageUrl, sourceFile: file.sourceFile });
      if ((entry._resourceType || '') === 'document') {
        const h = hostOf(entry.request.url);
        if (h) documentHosts.push(h);
      }
    }
  }

  const firstPartyRoots = new Set(
    (documentHosts.length ? documentHosts : files.map((f) => hostOf(f.pageUrl)).filter(Boolean) as string[])
      .map(registrable),
  );

  const resourceMix: Record<string, number> = {};
  const hostMap = new Map<string, HostInsight>();
  const endpointMap = new Map<string, EndpointInsight & { timings: number[] }>();
  const gqlMap = new Map<string, { name: string; count: number; sampleUrl: string }>();
  const errorMap = new Map<string, { method: string; urlPattern: string; status: number; count: number }>();
  const slowest: HarIntelligenceBriefing['slowest'] = [];
  const auth: AuthSignals = {
    status401: 0,
    status403: 0,
    authorizationHeaderPresent: false,
    setCookiePresent: false,
    csrfHeaderPresent: false,
    cookieNames: [],
    wwwAuthenticate: [],
  };
  const cookieSet = new Set<string>();
  const wwwAuth = new Set<string>();

  for (const { entry, pageUrl, sourceFile } of allEntries) {
    const rt = entry._resourceType || 'other';
    resourceMix[rt] = (resourceMix[rt] ?? 0) + 1;

    const host = hostOf(entry.request.url) ?? 'unknown';
    let hostInsight = hostMap.get(host);
    if (!hostInsight) {
      hostInsight = {
        host,
        category: classifyHost(host, firstPartyRoots),
        requestCount: 0,
        resourceMix: {},
        sampleUrls: [],
      };
      hostMap.set(host, hostInsight);
    }
    hostInsight.requestCount += 1;
    hostInsight.resourceMix[rt] = (hostInsight.resourceMix[rt] ?? 0) + 1;
    if (hostInsight.sampleUrls.length < 4) hostInsight.sampleUrls.push(entry.request.url.slice(0, 220));

    const pattern = templateUrl(entry.request.url);
    const epKey = `${entry.request.method} ${pattern}`;
    let ep = endpointMap.get(epKey);
    if (!ep) {
      ep = {
        method: entry.request.method,
        urlPattern: pattern,
        count: 0,
        statuses: {},
        p50Ms: 0,
        p95Ms: 0,
        resourceTypes: [],
        samplePageUrls: [],
        timings: [],
      };
      endpointMap.set(epKey, ep);
    }
    ep.count += 1;
    const st = String(entry.response.status);
    ep.statuses[st] = (ep.statuses[st] ?? 0) + 1;
    ep.timings.push(entry.time || 0);
    if (!ep.resourceTypes.includes(rt)) ep.resourceTypes.push(rt);
    if (ep.samplePageUrls.length < 5 && !ep.samplePageUrls.includes(pageUrl)) ep.samplePageUrls.push(pageUrl);
    const keys = schemaKeysFromBody(entry.response.content.text);
    if (keys && !ep.schemaHint) ep.schemaHint = keys;

    const gql = graphqlName(entry);
    if (gql) {
      ep.graphqlOperation = gql === '(unnamed)' ? ep.graphqlOperation : gql;
      const prev = gqlMap.get(gql) ?? { name: gql, count: 0, sampleUrl: entry.request.url };
      prev.count += 1;
      gqlMap.set(gql, prev);
    }

    if (entry.response.status === 401) auth.status401 += 1;
    if (entry.response.status === 403) auth.status403 += 1;
    if (headerValue(entry.request.headers, 'authorization')) auth.authorizationHeaderPresent = true;
    if (headerValue(entry.response.headers, 'set-cookie')) auth.setCookiePresent = true;
    if (headerValue(entry.request.headers, 'x-csrf-token') || headerValue(entry.request.headers, 'x-xsrf-token')) {
      auth.csrfHeaderPresent = true;
    }
    const setCookie = headerValue(entry.response.headers, 'set-cookie');
    if (setCookie) {
      const name = setCookie.split('=')[0]?.trim();
      if (name) cookieSet.add(name);
    }
    const www = headerValue(entry.response.headers, 'www-authenticate');
    if (www) wwwAuth.add(www.slice(0, 80));

    if (entry.response.status >= 400) {
      const errKey = `${entry.request.method}|${pattern}|${entry.response.status}`;
      const prev = errorMap.get(errKey) ?? {
        method: entry.request.method,
        urlPattern: pattern,
        status: entry.response.status,
        count: 0,
      };
      prev.count += 1;
      errorMap.set(errKey, prev);
    }

    if (isApiLike(rt) && (entry.time || 0) > 0) {
      slowest.push({
        method: entry.request.method,
        url: entry.request.url.slice(0, 220),
        timeMs: entry.time,
        pageUrl,
      });
    }

    void sourceFile;
  }

  auth.cookieNames = [...cookieSet].slice(0, 20);
  auth.wwwAuthenticate = [...wwwAuth];

  const endpoints: EndpointInsight[] = [...endpointMap.values()]
    .map(({ timings, ...rest }) => {
      const sorted = [...timings].sort((a, b) => a - b);
      return { ...rest, p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95) };
    })
    .sort((a, b) => b.count - a.count);

  const pageSequences: PageSequence[] = files.map((file) => {
    const apiCalls = file.har.log.entries
      .filter((e) => isApiLike(e._resourceType) || e._resourceType === 'document')
      .slice(0, 40)
      .map((e) => ({
        method: e.request.method,
        url: e.request.url.slice(0, 220),
        status: e.response.status,
        timeMs: e.time || 0,
        resourceType: e._resourceType || 'other',
      }));
    const doc = file.har.log.entries.find((e) => e._resourceType === 'document');
    return {
      pageUrl: file.pageUrl,
      sourceFile: file.sourceFile,
      documentStatus: doc?.response.status,
      callCount: file.har.log.entries.filter((e) => isApiLike(e._resourceType)).length,
      calls: apiCalls,
    };
  });

  const hosts = [...hostMap.values()].sort((a, b) => b.requestCount - a.requestCount);
  const xhrFetchCount = (resourceMix['xhr'] ?? 0) + (resourceMix['fetch'] ?? 0);

  const facts: string[] = [
    `${files.length} HAR file(s), ${allEntries.length} request(s), ${hosts.length} host(s), ${endpoints.length} templated endpoint(s).`,
    `XHR/fetch volume: ${xhrFetchCount}. Resource mix: ${Object.entries(resourceMix).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}.`,
  ];
  if (auth.status401 || auth.status403) {
    facts.push(`Auth failures observed: HTTP 401×${auth.status401}, 403×${auth.status403}.`);
  }
  if (auth.authorizationHeaderPresent) facts.push('Authorization request header present on at least one call.');
  if (auth.setCookiePresent) facts.push(`Set-Cookie observed (${auth.cookieNames.join(', ') || 'names masked/unknown'}).`);
  if (auth.csrfHeaderPresent) facts.push('CSRF/XSRF request header present.');
  const third = hosts.filter((h) => h.category !== 'first-party');
  if (third.length) {
    facts.push(
      `Third-party hosts: ${third.slice(0, 12).map((h) => `${h.host} (${h.category})`).join(', ')}${third.length > 12 ? '…' : ''}.`,
    );
  }
  if (gqlMap.size) facts.push(`GraphQL operations: ${[...gqlMap.values()].map((g) => g.name).slice(0, 10).join(', ')}.`);

  return {
    generatedAt: new Date().toISOString(),
    projectSlug: args.projectSlug,
    sourceSessionIds: args.sourceSessionIds,
    stats: {
      harFiles: files.length,
      entries: allEntries.length,
      uniqueHosts: hosts.length,
      uniqueEndpoints: endpoints.length,
      pages: files.length,
      xhrFetchCount,
    },
    resourceMix,
    hosts: hosts.slice(0, 80),
    endpoints: endpoints.filter((e) => e.resourceTypes.some(isApiLike) || e.resourceTypes.includes('document') || e.graphqlOperation).slice(0, 200),
    pageSequences: pageSequences.slice(0, 80),
    auth,
    graphqlOperations: [...gqlMap.values()].sort((a, b) => b.count - a.count).slice(0, 40),
    errors: [...errorMap.values()].sort((a, b) => b.count - a.count).slice(0, 40),
    slowest: slowest.sort((a, b) => b.timeMs - a.timeMs).slice(0, 20),
    facts,
  };
}

/** Compact subset for LLM prompts (still fact-complete, not a paraphrase of HAR bodies). */
export function compactHarIntelligence(briefing: HarIntelligenceBriefing): Record<string, unknown> {
  return {
    stats: briefing.stats,
    facts: briefing.facts,
    auth: briefing.auth,
    resourceMix: briefing.resourceMix,
    hosts: briefing.hosts.slice(0, 30),
    endpoints: briefing.endpoints.slice(0, 80),
    graphqlOperations: briefing.graphqlOperations,
    errors: briefing.errors.slice(0, 20),
    slowest: briefing.slowest.slice(0, 10),
    pageSequences: briefing.pageSequences.slice(0, 20).map((p) => ({
      pageUrl: p.pageUrl,
      documentStatus: p.documentStatus,
      callCount: p.callCount,
      calls: p.calls.slice(0, 15),
    })),
  };
}
