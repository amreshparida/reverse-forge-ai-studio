import { Page, BrowserContext } from 'playwright';
import path from 'path';
import { logger } from '../utils/logger';
import { maskHeaders, maskBody, maskUrl } from '../utils/mask';

// ── Types ─────────────────────────────────────────────────────────────────

export interface GraphQLSchema {
  endpoint: string;
  types: Array<{
    name: string;
    kind: string;
    description?: string;
    fields?: Array<{ name: string; typeName: string }>;
  }>;
}

export interface OpenApiSpec {
  url: string;
  format: 'json' | 'yaml';
  title?: string;
  version?: string;
  paths: string[];
  schemas: string[];
  raw: string;
}

export interface SourceMapInfo {
  scriptUrl: string;
  mapUrl: string;
  sources: string[];
  sourceRoot?: string;
  hasContent: boolean;
}

export interface CookieInfo {
  name: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
  isAuthRelated: boolean;
}

export interface IndexedDbSchema {
  name: string;
  version: number;
  objectStores: string[];
}

export interface PageResponseHeaders {
  contentSecurityPolicy?: string;
  cors?: string;
  cacheControl?: string;
  xFrameOptions?: string;
  hsts?: string;
  xContentTypeOptions?: string;
  featurePolicy?: string;
  server?: string;
  poweredBy?: string;
  status: number;
}

export interface MobileCapture {
  screenshotPath?: string;
  viewport: { width: number; height: number };
  layoutChanged: boolean;
}

export interface AdvancedPageCapture {
  graphqlSchema?: GraphQLSchema | null;
  openApiSpec?: OpenApiSpec | null;
  sourceMaps?: SourceMapInfo[];
  cookies?: CookieInfo[];
  indexedDb?: IndexedDbSchema[];
  responseHeaders?: PageResponseHeaders;
  mobileScreenshotPath?: string;
  webSocketUrls?: string[];
  sseEndpoints?: string[];
}

// ── Common OpenAPI paths to probe ─────────────────────────────────────────

const OPENAPI_PATHS = [
  '/api-docs',
  '/api-docs.json',
  '/swagger.json',
  '/swagger/v1/swagger.json',
  '/swagger/v2/swagger.json',
  '/v1/api-docs',
  '/v2/api-docs',
  '/v3/api-docs',
  '/openapi.json',
  '/openapi.yaml',
  '/openapi/v1.json',
  '/api/swagger.json',
  '/api/openapi.json',
  '/api/v1/swagger.json',
  '/api/v2/swagger.json',
  '/.well-known/openapi.json',
  '/docs/openapi.json',
];

// ── GraphQL introspection ─────────────────────────────────────────────────

const INTROSPECTION_QUERY = `{
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      name kind description
      fields(includeDeprecated: false) {
        name description
        type { name kind ofType { name kind ofType { name kind } } }
        args { name type { name kind } }
      }
      inputFields { name type { name kind } }
      enumValues { name }
    }
  }
}`;

export async function fetchGraphQLSchema(
  page: Page,
  endpoint: string,
): Promise<GraphQLSchema | null> {
  try {
    logger.info(`[Advanced] Fetching GraphQL schema from: ${endpoint}`);

    // Use page.evaluate so the request inherits the page's cookies/auth
    const result = await page.evaluate(
      async ({ ep, query }: { ep: string; query: string }) => {
        try {
          const res = await fetch(ep, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
            credentials: 'include',
          });
          if (!res.ok) return null;
          return res.json();
        } catch {
          return null;
        }
      },
      { ep: endpoint, query: INTROSPECTION_QUERY },
    ) as { data?: { __schema?: { types?: unknown[] } } } | null;

    if (!result?.data?.__schema) return null;

    const schema = result.data.__schema;
    const types = (schema.types as Array<{
      name: string; kind: string; description?: string;
      fields?: Array<{ name: string; type: { name?: string; ofType?: { name?: string } } }>;
    }>)
      ?.filter((t) => !t.name.startsWith('__'))
      .map((t) => ({
        name: t.name,
        kind: t.kind,
        description: t.description ?? undefined,
        fields: t.fields?.map((f) => ({
          name: f.name,
          typeName: f.type?.name ?? f.type?.ofType?.name ?? 'unknown',
        })),
      })) ?? [];

    logger.info(`[Advanced] GraphQL schema: ${types.length} types`);
    return { endpoint, types };
  } catch (err) {
    logger.debug(`[Advanced] GraphQL introspection failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── OpenAPI / Swagger spec probe ──────────────────────────────────────────

export async function fetchOpenApiSpec(page: Page, baseUrl: string): Promise<OpenApiSpec | null> {
  for (const apiPath of OPENAPI_PATHS) {
    const url = new URL(apiPath, baseUrl).toString();
    try {
      const result = await page.evaluate(
        async (u: string) => {
          try {
            const res = await fetch(u, { credentials: 'include' });
            if (!res.ok) return null;
            const ct = res.headers.get('content-type') ?? '';
            const text = await res.text();
            return { text, isJson: ct.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('['), url: u };
          } catch { return null; }
        },
        url,
      ) as { text: string; isJson: boolean; url: string } | null;

      if (!result?.text || result.text.length < 100) continue;
      const isYaml = url.endsWith('.yaml') || url.endsWith('.yml') || result.text.startsWith('openapi:') || result.text.startsWith('swagger:');

      let parsed: Record<string, unknown> | null = null;
      if (result.isJson) {
        try { parsed = JSON.parse(result.text) as Record<string, unknown>; } catch { /* not JSON */ }
      }

      if (!parsed && !isYaml) continue;

      // Extract useful info
      const info = parsed?.['info'] as Record<string, string> | undefined;
      const pathKeys = Object.keys((parsed?.['paths'] as Record<string, unknown>) ?? {});
      const schemaKeys = Object.keys(
        ((parsed?.['components'] as Record<string, unknown>)?.['schemas'] as Record<string, unknown>)
        ?? (parsed?.['definitions'] as Record<string, unknown>)
        ?? {},
      );

      logger.info(`[Advanced] OpenAPI spec found at ${url}: ${pathKeys.length} paths, ${schemaKeys.length} schemas`);
      return {
        url,
        format: isYaml ? 'yaml' : 'json',
        title: info?.['title'],
        version: info?.['version'],
        paths: pathKeys.slice(0, 500),
        schemas: schemaKeys.slice(0, 200),
        raw: result.text.slice(0, 200_000),
      };
    } catch { /* try next path */ }
  }
  return null;
}

// ── Source map fetching ───────────────────────────────────────────────────

export async function fetchSourceMaps(page: Page): Promise<SourceMapInfo[]> {
  const results: SourceMapInfo[] = [];
  try {
    const scriptSrcs = await page.evaluate((): string[] =>
      Array.from(document.querySelectorAll('script[src]'))
        .map((s) => (s as HTMLScriptElement).src)
        .filter((src) => src.endsWith('.js') || src.includes('.js?'))
    );

    for (const scriptUrl of scriptSrcs.slice(0, 8)) {
      const mapUrl = scriptUrl.split('?')[0] + '.map';
      const result = await page.evaluate(
        async (url: string) => {
          try {
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) return null;
            const text = await res.text();
            if (text.length < 50) return null;
            return text.slice(0, 50_000);
          } catch { return null; }
        },
        mapUrl,
      ) as string | null;

      if (!result) continue;

      try {
        const map = JSON.parse(result) as { sources?: string[]; sourceRoot?: string };
        if (map.sources && map.sources.length > 0) {
          results.push({
            scriptUrl,
            mapUrl,
            sources: map.sources.slice(0, 100),
            sourceRoot: map.sourceRoot,
            hasContent: result.includes('"sourcesContent"'),
          });
          logger.info(`[Advanced] Source map: ${map.sources.length} source files from ${mapUrl}`);
        }
      } catch { /* not valid JSON */ }
    }
  } catch (err) {
    logger.debug(`[Advanced] Source map fetch error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return results;
}

// ── Cookie structure ──────────────────────────────────────────────────────

export async function captureCookieStructure(context: BrowserContext): Promise<CookieInfo[]> {
  try {
    const cookies = await context.cookies();
    const authPattern = /token|auth|jwt|session|csrf|bearer|user|login/i;
    return cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      expires: c.expires > 0 ? c.expires : undefined,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      isAuthRelated: authPattern.test(c.name),
    }));
  } catch {
    return [];
  }
}

// ── IndexedDB schema ──────────────────────────────────────────────────────

export async function captureIndexedDbSchema(page: Page): Promise<IndexedDbSchema[]> {
  try {
    return await page.evaluate(async (): Promise<Array<{ name: string; version: number; objectStores: string[] }>> => {
      if (!('indexedDB' in window)) return [];
      try {
        const dbs = await indexedDB.databases();
        const schemas: Array<{ name: string; version: number; objectStores: string[] }> = [];
        for (const info of dbs.slice(0, 10)) {
          if (!info.name) continue;
          await new Promise<void>((resolve) => {
            const req = indexedDB.open(info.name!);
            req.onsuccess = () => {
              const db = req.result;
              schemas.push({
                name: info.name!,
                version: db.version,
                objectStores: Array.from(db.objectStoreNames),
              });
              db.close();
              resolve();
            };
            req.onerror = () => resolve();
          });
        }
        return schemas;
      } catch { return []; }
    });
  } catch {
    return [];
  }
}

// ── Page response headers ─────────────────────────────────────────────────

export function extractResponseHeaders(
  response: import('playwright').Response | null,
): PageResponseHeaders | null {
  if (!response) return null;
  try {
    const h = response.headers();
    const get = (name: string) => h[name.toLowerCase()];
    return {
      status: response.status(),
      contentSecurityPolicy: get('content-security-policy'),
      cors: get('access-control-allow-origin'),
      cacheControl: get('cache-control'),
      xFrameOptions: get('x-frame-options'),
      hsts: get('strict-transport-security'),
      xContentTypeOptions: get('x-content-type-options'),
      featurePolicy: get('permissions-policy') || get('feature-policy'),
      server: get('server'),
      poweredBy: get('x-powered-by'),
    };
  } catch {
    return null;
  }
}

// ── Mobile viewport screenshot ────────────────────────────────────────────

export async function captureMobileView(
  page: Page,
  screenshotsDir: string,
  filename: string,
): Promise<{ path: string; layoutChanged: boolean } | null> {
  try {
    const desktopHtml = await page.evaluate(() => document.body?.innerHTML?.slice(0, 500) ?? '');
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14 Pro
    await page.waitForTimeout(600);

    const mobilePath = path.join(screenshotsDir, 'mobile_' + filename);
    await page.screenshot({ path: mobilePath, timeout: 10_000 });

    const mobileHtml = await page.evaluate(() => document.body?.innerHTML?.slice(0, 500) ?? '');

    // Restore desktop viewport
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);

    const relativePath = path.relative(
      path.resolve(process.cwd(), process.env['OUTPUT_DIR'] ?? './project-output'),
      mobilePath,
    ).replace(/\\/g, '/');

    return {
      path: relativePath,
      layoutChanged: desktopHtml !== mobileHtml,
    };
  } catch {
    return null;
  }
}

// ── SSE endpoint detection ────────────────────────────────────────────────

export function detectSseEndpoints(
  networkCalls: Array<{ url: string; responseContentType?: string; resourceType?: string }>,
): string[] {
  return networkCalls
    .filter((c) =>
      c.responseContentType?.includes('text/event-stream') ||
      c.url.includes('/sse') ||
      c.url.includes('/events') ||
      c.url.includes('/stream') ||
      c.url.includes('/subscribe'),
    )
    .map((c) => maskUrl(c.url))
    .filter((u, i, arr) => arr.indexOf(u) === i);
}
