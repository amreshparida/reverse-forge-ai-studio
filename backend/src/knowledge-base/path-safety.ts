import path from 'path';
import fs from 'fs';

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSafetyError';
  }
}

/** Resolve a relative path under the KB root; reject traversal / absolute / null bytes. */
export function resolveUnderRoot(rootDir: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('\0')) {
    throw new PathSafetyError(`Invalid path: ${relativePath}`);
  }
  const normalized = relativePath.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new PathSafetyError(`Absolute paths are not allowed: ${relativePath}`);
  }
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '..')) {
    throw new PathSafetyError(`Path escapes knowledge base root: ${relativePath}`);
  }
  const abs = path.resolve(rootDir, normalized);
  const rootAbs = path.resolve(rootDir);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new PathSafetyError(`Path escapes knowledge base root: ${relativePath}`);
  }
  return abs;
}

/** Asset paths must resolve beneath output/assets/. */
export function resolveAssetPath(rootDir: string, relativePath: string): string {
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const underAssets = cleaned.startsWith('assets/')
    ? cleaned
    : `assets/${cleaned.replace(/^\/+/, '')}`;
  const abs = resolveUnderRoot(rootDir, underAssets);
  const assetsRoot = path.resolve(rootDir, 'assets');
  if (abs !== assetsRoot && !abs.startsWith(assetsRoot + path.sep)) {
    throw new PathSafetyError(`Asset path must be under assets/: ${relativePath}`);
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new PathSafetyError(`Asset not found: ${underAssets}`);
  }
  return abs;
}

export function isProvenanceOnlyPath(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  return (
    n.endsWith('.docx')
    || n.startsWith('exports/')
    || n.includes('/exports/')
    || (!n.startsWith('assets/') && !n.startsWith('markdown/') && !n.startsWith('canonical/')
      && !n.startsWith('structured/') && !n.startsWith('ingestion/') && !n.startsWith('graph/')
      && !n.startsWith('indexes/') && !n.startsWith('reports/') && n !== 'manifest.json'
      && n !== 'README.md' && !fs.existsSync(n))
  );
}

export function walkFiles(rootDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) results.push(abs);
    }
  };
  walk(rootDir);
  return results.sort();
}

export function toPosixRelative(rootDir: string, absPath: string): string {
  return path.relative(rootDir, absPath).replace(/\\/g, '/');
}
