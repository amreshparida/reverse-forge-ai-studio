import fs from 'fs';
import path from 'path';
import { prisma } from '../database/client';
import { config } from '../config';
import {
  createLLMClient,
  isLLMConfigured,
  resolveAnalysisLlmConfig,
  type LLMConfig,
  type LLMMessage,
} from '../ai/llm';
import { buildImageOcrPrompt } from '../ai/prompts';
import { KnowledgeBaseRepository } from '../knowledge-base';
import { getAnalysisDir, getKnowledgeBaseDir, getUploadedEvidenceDir, writeJson } from '../utils/file-system';
import { logger } from '../utils/logger';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export interface ImageOcrResult {
  relativePath: string;
  source: 'page_screenshot' | 'uploaded_evidence' | 'knowledge_base_asset';
  linkedPageId?: string;
  linkedRecordId?: string;
  contextLabel: string;
  extractedText: string;
  visualDescription: string;
  detectedElements: string[];
  documentType: string;
  language?: string;
  confidenceScore: number;
  analyzedAt: string;
}

interface ImageCandidate {
  absolutePath: string;
  relativePath: string;
  source: ImageOcrResult['source'];
  contextLabel: string;
  linkedPageId?: string;
  linkedRecordId?: string;
}

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function mimeForImage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/png';
}

function resolveOutputPath(relativePath: string): string {
  return path.resolve(config.outputDir, relativePath.replace(/\\/g, '/'));
}

function walkImages(dir: string, relPrefix: string, source: ImageOcrResult['source'], contextLabel: string): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkImages(abs, rel, source, contextLabel));
      continue;
    }
    if (!entry.isFile() || !isImageFile(entry.name)) continue;
    out.push({
      absolutePath: abs,
      relativePath: rel.replace(/\\/g, '/'),
      source,
      contextLabel,
    });
  }
  return out;
}

function collectImageCandidates(projectSlug: string, sessionId: string): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const seen = new Set<string>();

  const add = (c: ImageCandidate) => {
    const key = c.absolutePath;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(c);
  };

  // Page captures with screenshot paths (includes uploaded images indexed as pages)
  // Loaded synchronously via prisma in async function below — placeholder here

  // uploaded-evidence folder
  const uploadedDir = getUploadedEvidenceDir(projectSlug, sessionId);
  for (const c of walkImages(uploadedDir, 'uploaded-evidence', 'uploaded_evidence', 'Uploaded evidence image')) {
    add(c);
  }

  // knowledge-base assets
  const kbDir = getKnowledgeBaseDir(projectSlug, sessionId);
  const kbAssets = path.join(kbDir, 'assets');
  for (const c of walkImages(kbAssets, `knowledge-base/assets`, 'knowledge_base_asset', 'Knowledge base asset image')) {
    add(c);
  }

  return candidates;
}

async function collectAllCandidates(projectSlug: string, sessionId: string): Promise<ImageCandidate[]> {
  const candidates = collectImageCandidates(projectSlug, sessionId);
  const seen = new Set(candidates.map((c) => c.absolutePath));

  const pages = await prisma.pageCapture.findMany({
    where: { crawlSessionId: sessionId, screenshotPath: { not: null } },
    select: { id: true, url: true, title: true, screenshotPath: true },
  });

  for (const page of pages) {
    if (!page.screenshotPath) continue;
    const abs = resolveOutputPath(page.screenshotPath);
    if (!fs.existsSync(abs) || !isImageFile(abs)) continue;
    if (seen.has(abs)) {
      const existing = candidates.find((c) => c.absolutePath === abs);
      if (existing) existing.linkedPageId = page.id;
      continue;
    }
    seen.add(abs);
    candidates.push({
      absolutePath: abs,
      relativePath: page.screenshotPath.replace(/\\/g, '/'),
      source: page.url.startsWith('upload://') ? 'uploaded_evidence' : 'page_screenshot',
      contextLabel: page.title ?? page.url,
      linkedPageId: page.id,
    });
  }

  // KB record-referenced images not already found via assets walk
  const kbManifest = path.join(getKnowledgeBaseDir(projectSlug, sessionId), 'manifest.json');
  if (fs.existsSync(kbManifest)) {
    try {
      const repo = new KnowledgeBaseRepository(getKnowledgeBaseDir(projectSlug, sessionId));
      await repo.initialize();
      for await (const record of repo.streamKnowledge()) {
        for (const img of [...(record.images ?? []), ...(record.frames ?? [])]) {
          const rel = img.startsWith('assets/') ? `knowledge-base/${img}` : `knowledge-base/assets/${img.replace(/^\.\//, '')}`;
          const abs = path.join(getKnowledgeBaseDir(projectSlug, sessionId), img.replace(/^assets\//, 'assets/'));
          const absAlt = path.join(getKnowledgeBaseDir(projectSlug, sessionId), img);
          const resolved = fs.existsSync(absAlt) ? absAlt : abs;
          if (!fs.existsSync(resolved) || !isImageFile(resolved) || seen.has(resolved)) continue;
          seen.add(resolved);
          candidates.push({
            absolutePath: resolved,
            relativePath: rel,
            source: 'knowledge_base_asset',
            contextLabel: `${record.title} (${record.id})`,
            linkedRecordId: record.id,
          });
        }
      }
    } catch (err) {
      logger.warn(`[ImageOCR] KB asset scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return candidates;
}

interface VisionOcrPayload {
  extractedText: string;
  visualDescription: string;
  detectedElements: string[];
  documentType: string;
  language?: string;
  confidenceScore: number;
}

async function runVisionOcr(
  llmConfig: LLMConfig | undefined,
  candidate: ImageCandidate,
): Promise<VisionOcrPayload | null> {
  if (!isLLMConfigured(llmConfig)) return null;
  const llm = createLLMClient(llmConfig);
  const imageBase64 = fs.readFileSync(candidate.absolutePath).toString('base64');
  const mime = mimeForImage(candidate.absolutePath);

  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: buildImageOcrPrompt(candidate.contextLabel, candidate.relativePath),
        },
        {
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${imageBase64}`, detail: 'high' },
        },
      ] as unknown as string,
    },
  ];

  return llm.chatJson<VisionOcrPayload>(messages, { maxTokens: 4000 });
}

export async function analyzeEvidenceImages(args: {
  projectSlug: string;
  sessionId: string;
  llmConfig?: LLMConfig;
}): Promise<{ analyzed: number; skipped: number; results: ImageOcrResult[] }> {
  const analysisLlmConfig = resolveAnalysisLlmConfig(args.llmConfig);
  if (!isLLMConfigured(analysisLlmConfig)) {
    logger.warn('[ImageOCR] LLM not configured — skipping image OCR for evidence');
    return { analyzed: 0, skipped: 0, results: loadStoredImageOcr(args.projectSlug, args.sessionId) };
  }

  const candidates = await collectAllCandidates(args.projectSlug, args.sessionId);
  const analysisDir = getAnalysisDir(args.projectSlug, args.sessionId);
  const existing = loadStoredImageOcr(args.projectSlug, args.sessionId);
  const existingByPath = new Map(existing.map((r) => [r.relativePath, r]));

  const results: ImageOcrResult[] = [...existing];
  let analyzed = 0;
  let skipped = 0;

  const pending = candidates.filter((c) => {
    if (existingByPath.has(c.relativePath)) {
      skipped += 1;
      return false;
    }
    return true;
  });
  const concurrency = Math.min(config.llm.analysisConcurrency, Math.max(1, pending.length));

  logger.info(
    `[ImageOCR] Analyzing ${pending.length} evidence image(s) (${skipped} cached) for session ${args.sessionId} model=${analysisLlmConfig.model} concurrency=${concurrency}`,
  );

  const persistResults = () => {
    writeJson(path.join(analysisDir, 'image-ocr-results.json'), {
      sessionId: args.sessionId,
      analyzedAt: new Date().toISOString(),
      totalImages: results.length,
      results,
    });
  };

  const processCandidate = async (candidate: ImageCandidate): Promise<void> => {
    try {
      const ocr = await runVisionOcr(analysisLlmConfig, candidate);
      if (!ocr) return;

      const result: ImageOcrResult = {
        relativePath: candidate.relativePath,
        source: candidate.source,
        linkedPageId: candidate.linkedPageId,
        linkedRecordId: candidate.linkedRecordId,
        contextLabel: candidate.contextLabel,
        extractedText: ocr.extractedText ?? '',
        visualDescription: ocr.visualDescription ?? '',
        detectedElements: ocr.detectedElements ?? [],
        documentType: ocr.documentType ?? 'other',
        language: ocr.language,
        confidenceScore: ocr.confidenceScore ?? 0,
        analyzedAt: new Date().toISOString(),
      };
      results.push(result);
      existingByPath.set(result.relativePath, result);
      analyzed += 1;

      if (candidate.linkedPageId) {
        const page = await prisma.pageCapture.findUnique({
          where: { id: candidate.linkedPageId },
          select: { visibleText: true, extractedData: true, aiAnalysis: true },
        });
        if (page) {
          let extracted: Record<string, unknown> = {};
          try {
            extracted = page.extractedData ? JSON.parse(page.extractedData) as Record<string, unknown> : {};
          } catch {
            extracted = {};
          }
          extracted['imageOcr'] = result;
          const ocrBlock = result.extractedText
            ? `\n\n[Image OCR — ${candidate.relativePath}]\n${result.extractedText}`
            : `\n\n[Image visual analysis — ${candidate.relativePath}]\n${result.visualDescription}`;
          const priorAnalysis = page.aiAnalysis ? JSON.parse(page.aiAnalysis) as Record<string, unknown> : {};
          await prisma.pageCapture.update({
            where: { id: candidate.linkedPageId },
            data: {
              visibleText: ((page.visibleText ?? '') + ocrBlock).slice(0, 50_000),
              extractedData: JSON.stringify(extracted),
              aiAnalysis: JSON.stringify({
                ...priorAnalysis,
                imageOcr: result,
              }),
            },
          });
        }
      }

      if (analyzed % concurrency === 0) {
        persistResults();
        logger.info(`[ImageOCR] Progress ${analyzed}/${pending.length} for session ${args.sessionId}`);
      }
    } catch (err) {
      logger.warn(
        `[ImageOCR] Failed for ${candidate.relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= pending.length) break;
      await processCandidate(pending[i]!);
    }
  });
  await Promise.all(workers);
  persistResults();

  return { analyzed, skipped, results };
}

export function loadStoredImageOcr(projectSlug: string, sessionId: string): ImageOcrResult[] {
  const file = path.join(getAnalysisDir(projectSlug, sessionId), 'image-ocr-results.json');
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { results?: ImageOcrResult[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}

export function loadAllImageOcrForSessions(
  projectSlug: string,
  sourceSessionIds: string[],
): ImageOcrResult[] {
  const all: ImageOcrResult[] = [];
  for (const sessionId of sourceSessionIds) {
    all.push(...loadStoredImageOcr(projectSlug, sessionId));
  }
  return all;
}
