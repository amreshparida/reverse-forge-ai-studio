import { describe, expect, it } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { resolveWorkspacePath } from './synthesis-workspace';

describe('synthesis workspace path safety', () => {
  it('resolves paths inside the workspace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-ws-'));
    const abs = resolveWorkspacePath(root, 'page-analyses/index.json');
    expect(abs).toBe(path.resolve(root, 'page-analyses/index.json'));
  });

  it('rejects path traversal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-ws-'));
    expect(() => resolveWorkspacePath(root, '../secret.json')).toThrow(/escapes/);
  });
});
