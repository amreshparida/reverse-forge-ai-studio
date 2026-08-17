import { describe, expect, it } from 'vitest';
import { templateUrl } from './har-intelligence';

describe('HAR URL templating', () => {
  it('replaces numeric ids and uuids', () => {
    expect(templateUrl('https://api.acme.com/v1/orders/10482')).toBe('https://api.acme.com/v1/orders/{id}');
    expect(
      templateUrl('https://api.acme.com/items/550e8400-e29b-41d4-a716-446655440000'),
    ).toBe('https://api.acme.com/items/{uuid}');
  });
});
