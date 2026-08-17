import { Page, Request, Response } from 'playwright';
import { isSensitiveKey, maskHeaders, maskBody, maskUrl, truncateBody } from '../utils/mask';

export interface WebSocketMessage {
  direction: 'sent' | 'received';
  payload: string;
  timestamp: number;
}

export interface WebSocketCapture {
  url: string;
  messages: WebSocketMessage[];
  messageCount: number;
}

export interface WebSocketRecorder {
  getCaptures(): WebSocketCapture[];
  stop(): void;
}

export function createWebSocketRecorder(page: Page): WebSocketRecorder {
  const captures = new Map<string, WebSocketCapture>();

  page.on('websocket', (ws) => {
    const url = maskUrl(ws.url());
    const capture: WebSocketCapture = { url, messages: [], messageCount: 0 };
    captures.set(url, capture);

    ws.on('framesent', (frame) => {
      capture.messageCount++;
      if (capture.messages.length < 20) { // sample first 20 messages
        const payload = typeof frame.payload === 'string' ? frame.payload : `[binary ${frame.payload.byteLength}b]`;
        capture.messages.push({ direction: 'sent', payload: String(maskBody(payload)).slice(0, 1000), timestamp: Date.now() });
      }
    });

    ws.on('framereceived', (frame) => {
      capture.messageCount++;
      if (capture.messages.length < 20) {
        const payload = typeof frame.payload === 'string' ? frame.payload : `[binary ${frame.payload.byteLength}b]`;
        capture.messages.push({ direction: 'received', payload: String(maskBody(payload)).slice(0, 1000), timestamp: Date.now() });
      }
    });
  });

  return {
    getCaptures: () => Array.from(captures.values()),
    stop: () => undefined,
  };
}


export interface RecordedNetworkCall {
  /** Stable identifier for this browser request, even when URLs repeat concurrently. */
  requestId: string;
  method: string;
  url: string;
  queryParams: Record<string, string>;
  requestPayload: string | undefined;
  requestContentType: string | undefined;
  responseStatus: number | undefined;
  responseBody: string | undefined;
  responseContentType: string | undefined;
  /** Inferred JSON schema keys from the response root object */
  responseSchemaKeys: string[] | undefined;
  requestHeaders: string | undefined;
  responseHeaders: string | undefined;
  timingMs: number | undefined;
  resourceType: string;
  isGraphQL: boolean;
  graphQLOperationName: string | undefined;
}

/** HAR 1.2 log object (https://w3c.github.io/web-performance/specs/HAR/Overview.html) */
export interface HarLog {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    pages: Array<{
      startedDateTime: string;
      id: string;
      title: string;
      pageTimings: { onContentLoad: number; onLoad: number };
    }>;
    entries: HarEntry[];
  };
}

export interface HarEntry {
  _requestId: string;
  pageref: string;
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: unknown[];
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    postData?: { mimeType: string; text: string };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: unknown[];
    headers: Array<{ name: string; value: string }>;
    content: { size: number; mimeType: string; text?: string; encoding?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: {
    blocked: number;
    dns: number;
    connect: number;
    send: number;
    wait: number;
    receive: number;
    ssl: number;
  };
  _resourceType: string;
}

export interface NetworkRecorder {
  /** Wait until every response handler currently in flight has finished. */
  flush(): Promise<void>;
  getCalls(): RecordedNetworkCall[];
  /** HAR 1.2 for the current page window (all resource types; bodies masked/truncated) */
  getHar(pageUrl?: string): HarLog;
  /** Clear accumulated calls (call between pages when reusing one browser tab) */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

const API_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'websocket']);
/** Skip response body text for bulky/binary types (still emit the HAR entry). */
const BINARY_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'imageset']);
const JSON_CONTENT_TYPES = ['application/json', 'text/json', 'application/graphql'];
const TEXTUAL_CONTENT_HINT = /json|text\/|javascript|ecmascript|xml|svg|css|html|graphql|wasm/i;
const MAX_HAR_ENTRIES = 800;
const MAX_HAR_BODY = 16_000;

interface PendingTiming {
  startedAt: number;
  startedDateTime: string;
}

function headersToHarList(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function queryToHarList(queryParams: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(queryParams).map(([name, value]) => ({ name, value }));
}

function normalizeHeaderMap(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function shouldCaptureResponseText(resourceType: string, contentType: string): boolean {
  if (BINARY_RESOURCE_TYPES.has(resourceType)) return false;
  if (!contentType) return resourceType === 'document' || resourceType === 'script' || resourceType === 'stylesheet' || API_RESOURCE_TYPES.has(resourceType);
  return TEXTUAL_CONTENT_HINT.test(contentType);
}

export function createNetworkRecorder(page: Page): NetworkRecorder {
  const calls: RecordedNetworkCall[] = [];
  const harEntries: HarEntry[] = [];
  const requestTimings = new Map<Request, PendingTiming>();
  const requestIds = new WeakMap<Request, string>();
  const pendingResponses = new Set<Promise<void>>();
  let requestSequence = 0;
  let pageStartedAt = Date.now();

  const onRequest = (request: Request) => {
    const now = Date.now();
    requestSequence += 1;
    requestIds.set(request, `req-${requestSequence}`);
    requestTimings.set(request, {
      startedAt: now,
      startedDateTime: new Date(now).toISOString(),
    });
  };

  const onResponse = async (response: Response) => {
    const request = response.request();
    const rt = request.resourceType();
    const requestId = requestIds.get(request) ?? `req-${++requestSequence}`;
    const timing = requestTimings.get(request);
    requestTimings.delete(request);

    const startedAt = timing?.startedAt ?? Date.now();
    const startedDateTime = timing?.startedDateTime ?? new Date().toISOString();
    const timingMs = Math.max(0, Date.now() - startedAt);

    const rawUrl = request.url();
    const maskedUrl = maskUrl(rawUrl);

    // ── Query params ───────────────────────────────────────────────────────
    let queryParams: Record<string, string> = {};
    try {
      const parsed = new URL(rawUrl);
      parsed.searchParams.forEach((v, k) => { queryParams[k] = v; });
    } catch { /* invalid URL */ }
    for (const key of Object.keys(queryParams)) {
      if (isSensitiveKey(key)) queryParams[key] = '***REDACTED***';
    }

    // ── Request headers ────────────────────────────────────────────────────
    let requestHeaderMap: Record<string, string> = {};
    let requestContentType: string | undefined;
    try {
      requestHeaderMap = normalizeHeaderMap(maskHeaders(await request.allHeaders()));
      requestContentType = requestHeaderMap['content-type']?.split(';')[0].trim();
    } catch { /* ignore */ }

    // ── Request body ───────────────────────────────────────────────────────
    let requestPayload: string | undefined;
    let isGraphQL = false;
    let graphQLOperationName: string | undefined;
    try {
      const postData = request.postData();
      if (postData) {
        try {
          const json = JSON.parse(postData) as Record<string, unknown>;
          if (json['query'] || json['operationName'] || json['mutation']) {
            isGraphQL = true;
            graphQLOperationName = (json['operationName'] as string) || undefined;
            if (json['variables']) {
              json['variables'] = maskBody(json['variables']);
            }
          }
          requestPayload = truncateBody(JSON.stringify(maskBody(json)), MAX_HAR_BODY);
        } catch {
          requestPayload = truncateBody(String(maskBody(postData)), MAX_HAR_BODY);
        }
      }
    } catch { /* ignore */ }

    // ── Response headers ───────────────────────────────────────────────────
    let responseHeaderMap: Record<string, string> = {};
    let responseContentType: string | undefined;
    try {
      responseHeaderMap = normalizeHeaderMap(maskHeaders(response.headers()));
      responseContentType = responseHeaderMap['content-type']?.split(';')[0].trim();
    } catch { /* ignore */ }

    // ── Response body ──────────────────────────────────────────────────────
    let responseBody: string | undefined;
    let responseSchemaKeys: string[] | undefined;
    let responseBodySize = -1;
    const ct = responseContentType ?? '';
    const captureText = shouldCaptureResponseText(rt, ct);

    try {
      if (captureText) {
        if (JSON_CONTENT_TYPES.some((jct) => ct.includes(jct)) || ct.includes('json')) {
          const body = await response.json().catch(() => null) as Record<string, unknown> | unknown[] | null;
          if (body) {
            const masked = maskBody(body);
            const serializedBody = JSON.stringify(masked, null, 2);
            responseBody = truncateBody(serializedBody, MAX_HAR_BODY);
            responseBodySize = serializedBody.length;
            if (typeof masked === 'object' && masked !== null && !Array.isArray(masked)) {
              responseSchemaKeys = Object.keys(masked as Record<string, unknown>).slice(0, 30);
            } else if (Array.isArray(masked) && masked.length > 0 && typeof masked[0] === 'object') {
              responseSchemaKeys = Object.keys(masked[0] as Record<string, unknown>).slice(0, 30);
            }
          }
        } else {
          const text = await response.text().catch(() => '');
          const maskedText = String(maskBody(text));
          responseBodySize = maskedText.length;
          responseBody = truncateBody(maskedText, MAX_HAR_BODY);
        }
      } else {
        // Prefer content-length when we intentionally skip body text
        const cl = responseHeaderMap['content-length'];
        if (cl && /^\d+$/.test(cl)) responseBodySize = Number(cl);
      }
    } catch { /* response may be consumed */ }

    if (!isGraphQL && /graphql|gql/.test(rawUrl.toLowerCase())) {
      isGraphQL = true;
    }

    // Existing API-focused strategy (xhr/fetch/websocket only)
    if (API_RESOURCE_TYPES.has(rt)) {
      calls.push({
        requestId,
        method: request.method(),
        url: maskedUrl,
        queryParams,
        requestPayload,
        requestContentType,
        responseStatus: response.status(),
        responseBody,
        responseContentType,
        responseSchemaKeys,
        requestHeaders: JSON.stringify(requestHeaderMap),
        responseHeaders: JSON.stringify(responseHeaderMap),
        timingMs,
        resourceType: rt,
        isGraphQL,
        graphQLOperationName,
      });
    }

    // Full-page HAR entry (all resource types)
    if (harEntries.length < MAX_HAR_ENTRIES) {
      const postData = requestPayload
        ? { mimeType: requestContentType || 'application/octet-stream', text: requestPayload }
        : undefined;

      harEntries.push({
        _requestId: requestId,
        pageref: 'page_1',
        startedDateTime,
        time: timingMs,
        request: {
          method: request.method(),
          url: maskedUrl,
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: headersToHarList(requestHeaderMap),
          queryString: queryToHarList(queryParams),
          ...(postData ? { postData } : {}),
          headersSize: -1,
          bodySize: requestPayload ? requestPayload.length : 0,
        },
        response: {
          status: response.status(),
          statusText: response.statusText(),
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: headersToHarList(responseHeaderMap),
          content: {
            size: responseBodySize,
            mimeType: responseContentType || 'application/octet-stream',
            ...(responseBody !== undefined ? { text: responseBody } : {}),
          },
          redirectURL: responseHeaderMap['location'] || '',
          headersSize: -1,
          bodySize: responseBodySize,
        },
        cache: {},
        timings: {
          blocked: -1,
          dns: -1,
          connect: -1,
          send: 0,
          wait: timingMs,
          receive: 0,
          ssl: -1,
        },
        _resourceType: rt,
      });
    }
  };

  const onResponseWrapper = (response: Response) => {
    const pending = onResponse(response).catch(() => undefined);
    pendingResponses.add(pending);
    void pending.finally(() => pendingResponses.delete(pending));
  };

  const flush = async (): Promise<void> => {
    while (pendingResponses.size > 0) {
      await Promise.all([...pendingResponses]);
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponseWrapper);

  return {
    flush,
    getCalls: () => [...calls],
    getHar: (pageUrl?: string): HarLog => {
      const title = pageUrl || page.url() || 'page';
      const onLoad = Math.max(0, Date.now() - pageStartedAt);
      return {
        log: {
          version: '1.2',
          creator: { name: 'reverse-forge-ai-studio', version: '1.0.0' },
          pages: [{
            startedDateTime: new Date(pageStartedAt).toISOString(),
            id: 'page_1',
            title,
            pageTimings: { onContentLoad: -1, onLoad },
          }],
          entries: [...harEntries],
        },
      };
    },
    reset: async () => {
      await flush();
      calls.length = 0;
      harEntries.length = 0;
      requestTimings.clear();
      pageStartedAt = Date.now();
    },
    stop: async () => {
      page.off('request', onRequest);
      page.off('response', onResponseWrapper);
      await flush();
      requestTimings.clear();
    },
  };
}
