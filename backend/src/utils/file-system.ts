import fs from 'fs';
import path from 'path';
import { config } from '../config';

export function ensureDir(dirPath: string): string {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

export function getProjectOutputDir(projectSlug: string): string {
  return ensureDir(path.join(config.outputDir, projectSlug));
}

export function getSessionOutputDir(projectSlug: string, sessionId: string): string {
  return ensureDir(path.join(config.outputDir, projectSlug, sessionId));
}

export function getScreenshotsDir(projectSlug: string, sessionId: string): string {
  return ensureDir(path.join(config.outputDir, projectSlug, sessionId, 'screenshots'));
}

export function getHtmlDir(projectSlug: string, sessionId: string): string {
  return ensureDir(path.join(config.outputDir, projectSlug, sessionId, 'html'));
}

export function getPagesDir(projectSlug: string, sessionId: string): string {
  return ensureDir(path.join(config.outputDir, projectSlug, sessionId, 'pages'));
}

export function getApiDir(projectSlug: string, sessionId: string): string {
  return ensureDir(path.join(config.outputDir, projectSlug, sessionId, 'api'));
}

export function getHarDir(projectSlug: string, sessionId: string): string {
  return ensureDir(path.join(config.outputDir, projectSlug, sessionId, 'har'));
}

export function getAnalysisDir(projectSlug: string, sessionId: string): string {
  return ensureDir(path.join(config.outputDir, projectSlug, sessionId, 'analysis'));
}

export function getReportsDir(projectSlug: string, sessionId: string): string {
  return ensureDir(path.join(config.outputDir, projectSlug, sessionId, 'reports'));
}

export function getUploadedEvidenceDir(projectSlug: string, sessionId: string): string {
  return ensureDir(path.join(config.outputDir, projectSlug, sessionId, 'uploaded-evidence'));
}

export function getKnowledgeBaseDir(projectSlug: string, sessionId: string): string {
  return ensureDir(path.join(config.outputDir, projectSlug, sessionId, 'knowledge-base'));
}

export function getSessionStorageDir(projectSlug: string): string {
  return ensureDir(path.join(config.sessionDir, projectSlug));
}

function sanitizeFilenamePart(raw: string, maxLen = 100): string {
  return raw
    .replace(/^\//, '')
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, maxLen) || 'index';
}

export function urlToFilename(url: string, ext = '.html'): string {
  if (!url || typeof url !== 'string') return `unknown${ext}`;

  try {
    const parsed = new URL(url);
    // upload://host/path and kb://id — host carries the first path segment
    const pathPart =
      parsed.protocol === 'upload:' || parsed.protocol === 'kb:'
        ? [parsed.host, parsed.pathname.replace(/^\//, ''), parsed.hash.replace(/^#/, '')]
            .filter(Boolean)
            .join('__')
        : parsed.pathname;
    return sanitizeFilenamePart(pathPart) + ext;
  } catch {
    const fallback = url
      .replace(/^[^:]+:\/\//, '')
      .replace(/[#?].*$/, '');
    return sanitizeFilenamePart(fallback || url) + ext;
  }
}

export function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function readJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function listFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath).map((f) => path.join(dirPath, f));
}

/** Recursively delete a directory if it exists. Safe no-op when missing. */
export function removeDir(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) return false;
  fs.rmSync(dirPath, { recursive: true, force: true });
  return true;
}
