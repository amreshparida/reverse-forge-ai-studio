import { describe, expect, it } from 'vitest';
import { isBlankOrNewTabUrl } from './new-page-follower';

describe('new-page follower URL helpers', () => {
  it('treats blank and browser-internal URLs as unset destinations', () => {
    expect(isBlankOrNewTabUrl('')).toBe(true);
    expect(isBlankOrNewTabUrl('about:blank')).toBe(true);
    expect(isBlankOrNewTabUrl('chrome://new-tab-page/')).toBe(true);
    expect(isBlankOrNewTabUrl('https://app.example.com/orders')).toBe(false);
  });
});
