import { Page, Request, Response } from 'playwright';
import { maskHeaders, maskBody, maskUrl, truncateBody } from '../utils/mask';

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

export interface NetworkRecorder {
  getCalls(): RecordedNetworkCall[];
  /** Clear accumulated calls (call between pages when reusing one browser tab) */
  reset(): void;
  stop(): void;
}

const API_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'websocket']);
/** Also capture JSON responses from document/script resources that look like APIs */
const JSON_CONTENT_TYPES = ['application/json', 'text/json', 'application/graphql'];

export function createNetworkRecorder(page: Page): NetworkRecorder {
  const calls: RecordedNetworkCall[] = [];
  const requestTimings = new Map<string, number>();

  const onRequest = (request: Request) => {
    const rt = request.resourceType();
    if (!API_RESOURCE_TYPES.has(rt)) return;
    requestTimings.set(request.url(), Date.now());
  };

  const onResponse = async (response: Response) => {
    const request = response.request();
    const rt = request.resourceType();
    if (!API_RESOURCE_TYPES.has(rt)) return;

    const startTime = requestTimings.get(request.url());
    const timingMs = startTime ? Date.now() - startTime : undefined;
    requestTimings.delete(request.url());

    const rawUrl = request.url();
    const maskedUrl = maskUrl(rawUrl);

    // ── Query params ───────────────────────────────────────────────────────
    let queryParams: Record<string, string> = {};
    try {
      const parsed = new URL(rawUrl);
      parsed.searchParams.forEach((v, k) => { queryParams[k] = v; });
    } catch { /* invalid URL */ }
    const sensitiveParams = ['token', 'key', 'secret', 'password', 'auth', 'api_key', 'apikey'];
    for (const p of sensitiveParams) {
      if (queryParams[p]) queryParams[p] = '***REDACTED***';
    }

    // ── Request headers ────────────────────────────────────────────────────
    let requestHeaders: string | undefined;
    let requestContentType: string | undefined;
    try {
      const headers = await request.allHeaders();
      requestContentType = headers['content-type']?.split(';')[0].trim();
      requestHeaders = JSON.stringify(maskHeaders(headers));
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
          // GraphQL detection
          if (json['query'] || json['operationName'] || json['mutation']) {
            isGraphQL = true;
            graphQLOperationName = (json['operationName'] as string) || undefined;
            // Mask variables but keep query structure
            if (json['variables']) {
              json['variables'] = maskBody(json['variables']);
            }
          }
          requestPayload = truncateBody(JSON.stringify(maskBody(json)));
        } catch {
          requestPayload = truncateBody(String(maskBody(postData)));
        }
      }
    } catch { /* ignore */ }

    // ── Response headers ───────────────────────────────────────────────────
    let responseHeaders: string | undefined;
    let responseContentType: string | undefined;
    try {
      const headers = response.headers();
      responseContentType = headers['content-type']?.split(';')[0].trim();
      responseHeaders = JSON.stringify(maskHeaders(headers));
    } catch { /* ignore */ }

    // ── Response body ──────────────────────────────────────────────────────
    let responseBody: string | undefined;
    let responseSchemaKeys: string[] | undefined;
    try {
      const ct = responseContentType ?? '';
      if (JSON_CONTENT_TYPES.some((jct) => ct.includes(jct)) || ct.includes('json')) {
        const body = await response.json().catch(() => null) as Record<string, unknown> | unknown[] | null;
        if (body) {
          const masked = maskBody(body);
          responseBody = truncateBody(JSON.stringify(masked, null, 2), 8000);

          // Extract schema keys from root object
          if (typeof masked === 'object' && masked !== null && !Array.isArray(masked)) {
            responseSchemaKeys = Object.keys(masked as Record<string, unknown>).slice(0, 30);
          } else if (Array.isArray(masked) && masked.length > 0 && typeof masked[0] === 'object') {
            responseSchemaKeys = Object.keys(masked[0] as Record<string, unknown>).slice(0, 30);
          }
        }
      } else if (ct.includes('text/html') || ct.includes('text/plain')) {
        const text = await response.text().catch(() => '');
        responseBody = truncateBody(text, 2000);
      }
    } catch { /* response may be consumed */ }

    // ── GraphQL URL detection ──────────────────────────────────────────────
    if (!isGraphQL && /graphql|gql/.test(rawUrl.toLowerCase())) {
      isGraphQL = true;
    }

    calls.push({
      method: request.method(),
      url: maskedUrl,
      queryParams,
      requestPayload,
      requestContentType,
      responseStatus: response.status(),
      responseBody,
      responseContentType,
      responseSchemaKeys,
      requestHeaders,
      responseHeaders,
      timingMs,
      resourceType: rt,
      isGraphQL,
      graphQLOperationName,
    });
  };

  page.on('request', onRequest);
  page.on('response', (response) => {
    onResponse(response).catch(() => undefined);
  });

  return {
    getCalls: () => [...calls],
    reset: () => { calls.length = 0; },
    stop: () => { page.off('request', onRequest); },
  };
}

