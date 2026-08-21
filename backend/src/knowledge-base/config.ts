import path from 'path';

/**
 * Knowledge-base roots are resolved from an absolute path or relative to the
 * backend package root — never from process.cwd(), which is unstable in production.
 */
const BACKEND_ROOT = path.resolve(__dirname, '../..');

export interface KnowledgeBaseConfig {
  /** Absolute path to the KB root (the directory that contains manifest.json). */
  rootDir: string;
  /** Optional AbortSignal for streaming loaders. */
  signal?: AbortSignal;
}

export function resolveKnowledgeBaseRoot(configuredPath: string): string {
  if (path.isAbsolute(configuredPath)) return path.resolve(configuredPath);
  return path.resolve(BACKEND_ROOT, configuredPath);
}

export function defaultFixtureKbRoot(): string {
  return path.join(__dirname, 'fixtures', 'sample-kb');
}
