import { describe, expect, it } from 'vitest';
import { manualCaptureFilename } from './manual';

describe('manualCaptureFilename', () => {
  it('keeps repeated URL captures distinct and ordered', () => {
    const first = manualCaptureFilename(1, 'https://app.example.test/orders/42?tab=details', '.png');
    const second = manualCaptureFilename(2, 'https://app.example.test/orders/42?tab=history', '.png');

    expect(first).toBe('manual-0001-orders__42.png');
    expect(second).toBe('manual-0002-orders__42.png');
    expect(first).not.toBe(second);
  });

  it('falls back safely for non-URL browser states', () => {
    expect(manualCaptureFilename(7, 'not a url', '.json')).toBe('manual-0007-page.json');
  });
});
