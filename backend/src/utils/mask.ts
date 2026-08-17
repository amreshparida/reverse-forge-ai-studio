/**
 * Masks sensitive values in objects and strings to prevent secrets from
 * being stored or logged. Covers passwords, tokens, cookies, auth headers,
 * and personal identifiers.
 */

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
  'x-csrf-token',
  'proxy-authorization',
]);

const SENSITIVE_BODY_KEYS = new Set([
  'password',
  'passwd',
  'pass',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'private_key',
  'privatekey',
  'ssn',
  'social_security',
  'credit_card',
  'card_number',
  'cvv',
  'pin',
]);

const MASK = '***REDACTED***';
const MAX_MASK_DEPTH = 20;
const NORMALIZED_SENSITIVE_BODY_KEYS = new Set(
  [...SENSITIVE_BODY_KEYS].map((key) => key.replace(/[^a-z0-9]/g, '')),
);
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi;

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return NORMALIZED_SENSITIVE_BODY_KEYS.has(normalized);
}

export function maskHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = SENSITIVE_HEADER_KEYS.has(key.toLowerCase()) ? MASK : value;
  }
  return result;
}

export function maskBody(body: unknown, depth = 0): unknown {
  // Never return deep content unmasked: nested payloads often contain auth or PII.
  if (depth > MAX_MASK_DEPTH) return MASK;
  if (body === null || body === undefined) return body;
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      return JSON.stringify(maskBody(parsed, depth + 1));
    } catch {
      // Cover form-encoded and plain-text credential formats that are not JSON.
      if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(body)) {
        const params = new URLSearchParams(body);
        for (const key of [...params.keys()]) {
          if (isSensitiveKey(key)) params.set(key, MASK);
        }
        return params.toString();
      }
      return body
        .replace(BEARER_PATTERN, `$1${MASK}`)
        .replace(JWT_PATTERN, MASK)
        .replace(
          /((?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|authorization)\s*[=:]\s*)[^\s&,;]+/gi,
          `$1${MASK}`,
        );
    }
  }
  if (Array.isArray(body)) {
    return body.map((item) => maskBody(item, depth + 1));
  }
  if (typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = isSensitiveKey(key)
        ? MASK
        : maskBody(value, depth + 1);
    }
    return result;
  }
  return body;
}

export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const param of [...parsed.searchParams.keys()]) {
      if (isSensitiveKey(param)) parsed.searchParams.set(param, MASK);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function truncateBody(body: string | undefined, maxLength = 4000): string | undefined {
  if (!body) return body;
  return body.length > maxLength ? body.slice(0, maxLength) + '…[truncated]' : body;
}
