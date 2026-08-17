import { describe, expect, it } from 'vitest';
import { maskBody, maskUrl } from './mask';

describe('sensitive data masking', () => {
  it('redacts sensitive values nested deeper than the previous depth limit', () => {
    const payload = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                level6: {
                  Access_Token: 'must-not-leak',
                },
              },
            },
          },
        },
      },
    };

    expect(JSON.stringify(maskBody(payload))).not.toContain('must-not-leak');
  });

  it('redacts case and separator variants in body keys', () => {
    expect(maskBody({ apiKey: 'one', 'Refresh-Token': 'two', PASSWORD: 'three' })).toEqual({
      apiKey: '***REDACTED***',
      'Refresh-Token': '***REDACTED***',
      PASSWORD: '***REDACTED***',
    });
  });

  it('redacts case and separator variants in URL query parameters', () => {
    const masked = maskUrl('https://example.test/path?Access_Token=secret&API-KEY=key&safe=value');

    expect(masked).not.toContain('secret');
    expect(masked).not.toContain('API-KEY=key');
    expect(masked).toContain('safe=value');
  });

  it('redacts form-encoded and plain-text credentials', () => {
    const form = String(maskBody('username=person&password=secret&access_token=token-value'));
    const text = String(maskBody('Authorization: Bearer abc.def.ghi'));

    expect(form).not.toContain('secret');
    expect(form).not.toContain('token-value');
    expect(form).toContain('username=person');
    expect(text).not.toContain('abc.def.ghi');
  });
});
