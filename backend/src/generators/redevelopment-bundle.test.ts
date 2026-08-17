import { describe, expect, it } from 'vitest';
import { buildApiContractCatalog, type CapturedCall } from './redevelopment-bundle';

function call(overrides: Partial<CapturedCall> = {}): CapturedCall {
  return {
    crawlSessionId: 'session-a',
    method: 'GET',
    url: 'https://api.example.test/orders/123?token=redacted',
    responseStatus: 200,
    requestContentType: null,
    responseContentType: 'application/json',
    responseSchemaKeys: '["id","status"]',
    isGraphQL: false,
    graphQLOperationName: null,
    pageCapture: { url: 'https://app.example.test/orders' },
    ...overrides,
  };
}

describe('buildApiContractCatalog', () => {
  it('groups observed IDs into a stable contract with provenance', () => {
    const catalog = buildApiContractCatalog([
      call(),
      call({ crawlSessionId: 'session-b', url: 'https://api.example.test/orders/456', responseStatus: 404 }),
    ]);

    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      contract: 'GET https://api.example.test/orders/:id',
      observations: 2,
      sourceSessionIds: ['session-a', 'session-b'],
      statuses: [200, 404],
      responseFields: ['id', 'status'],
      confidence: 'medium',
    });
  });

  it('keeps different methods as separate contracts', () => {
    const catalog = buildApiContractCatalog([call(), call({ method: 'POST' })]);
    expect(catalog.map((entry) => entry['method'])).toEqual(['GET', 'POST']);
  });
});
