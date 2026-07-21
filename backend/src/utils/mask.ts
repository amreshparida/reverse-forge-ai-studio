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
  if (depth > 5) return body;
  if (body === null || body === undefined) return body;
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      return JSON.stringify(maskBody(parsed, depth + 1));
    } catch {
      return body;
    }
  }
  if (Array.isArray(body)) {
    return body.map((item) => maskBody(item, depth + 1));
  }
  if (typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = SENSITIVE_BODY_KEYS.has(key.toLowerCase())
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
    const sensitiveParams = ['token', 'key', 'secret', 'password', 'auth', 'api_key'];
    for (const param of sensitiveParams) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, MASK);
      }
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
