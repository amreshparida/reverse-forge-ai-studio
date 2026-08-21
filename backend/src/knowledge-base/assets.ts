import fs from 'fs';
import path from 'path';
import { resolveAssetPath, resolveUnderRoot } from './path-safety';
import type { ResolvedAsset } from './types';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
};

export function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export async function resolveAsset(rootDir: string, relativePath: string): Promise<ResolvedAsset> {
  const absolutePath = resolveAssetPath(rootDir, relativePath);
  const bytes = fs.readFileSync(absolutePath);
  const rel = path.relative(rootDir, absolutePath).replace(/\\/g, '/');
  return {
    absolutePath,
    relativePath: rel,
    mimeType: mimeForPath(absolutePath),
    sizeBytes: bytes.length,
    bytes,
  };
}

/** Extract local image refs from markdown and verify they exist relative to the md file. */
export function verifyMarkdownImageLinks(
  rootDir: string,
  markdownRelativePath: string,
  markdown: string,
): string[] {
  const missing: string[] = [];
  const mdAbs = resolveUnderRoot(rootDir, markdownRelativePath);
  const mdDir = path.dirname(mdAbs);
  const re = /!\[[^\]]*]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const ref = match[1]?.trim() ?? '';
    if (!ref || ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('data:')) {
      continue;
    }
    const cleaned = ref.split(/[?#]/)[0] ?? ref;
    const candidate = path.resolve(mdDir, cleaned);
    const rootAbs = path.resolve(rootDir);
    if (candidate !== rootAbs && !candidate.startsWith(rootAbs + path.sep)) {
      missing.push(ref);
      continue;
    }
    if (!fs.existsSync(candidate)) missing.push(ref);
  }
  return missing;
}
