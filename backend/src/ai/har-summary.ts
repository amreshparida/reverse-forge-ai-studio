import fs from 'fs';
import path from 'path';
import { getHarDir } from '../utils/file-system';
import type { HarLog } from '../recorder';

export function isHarLog(value: unknown): value is HarLog {
  if (!value || typeof value !== 'object') return false;
  const log = (value as { log?: unknown }).log;
  if (!log || typeof log !== 'object') return false;
  const entries = (log as { entries?: unknown }).entries;
  return Array.isArray(entries);
}

export interface LoadedHarFile {
  sourceSessionId: string;
  sourceFile: string;
  pageUrl: string;
  entryCount: number;
  /** Full HAR 1.2 document (same content as session har/*.har) */
  har: HarLog;
}

/** Load full per-page HAR files for analysis / report evidence (capped by file count only). */
export function loadHarFilesForSessions(
  projectSlug: string,
  sessionIds: string[],
  maxFiles = 80,
): LoadedHarFile[] {
  const out: LoadedHarFile[] = [];
  for (const sid of sessionIds) {
    const harDir = getHarDir(projectSlug, sid);
    if (!fs.existsSync(harDir)) continue;
    for (const name of fs.readdirSync(harDir).filter((f: string) => f.endsWith('.har')).sort()) {
      if (out.length >= maxFiles) return out;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(harDir, name), 'utf-8')) as unknown;
        if (!isHarLog(raw)) continue;
        out.push({
          sourceSessionId: sid,
          sourceFile: path.join('har', name),
          pageUrl: raw.log.pages[0]?.title || name,
          entryCount: raw.log.entries.length,
          har: raw,
        });
      } catch {
        /* skip corrupt HAR */
      }
    }
  }
  return out;
}
