import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { prisma } from '../database/client';
import { config } from '../config';
import {
  ensureDir,
  getApiDir,
  getHarDir,
  getHtmlDir,
  getKnowledgeBaseDir,
  getPagesDir,
  getScreenshotsDir,
  getSessionOutputDir,
  getUploadedEvidenceDir,
  readJson,
  writeJson,
} from '../utils/file-system';
import { logger } from '../utils/logger';
import { KnowledgeBaseRepository, detectKnowledgeBaseRoot } from '../knowledge-base';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.xml', '.html', '.htm',
  '.yaml', '.yml', '.log', '.sql', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py',
  '.java', '.go', '.rs', '.rb', '.php', '.cs', '.kt', '.swift', '.env', '.ini', '.cfg',
  '.conf', '.properties', '.toml', '.graphql', '.gql', '.proto', '.sh', '.bash', '.zsh',
  '.css', '.scss', '.less', '.vue', '.svelte', '.har', '.r', '.scala', '.dart', '.lua',
  '.pl', '.pm', '.ps1', '.bat', '.cmd', '.dockerfile', '.gitignore', '.npmrc', '.editorconfig',
]);

/** Cap text stored per uploaded file — full file remains on disk. */
const UPLOAD_VISIBLE_TEXT_MAX = 20_000;

/** macOS zip metadata — never import as evidence pages */
function isAppleDoubleJunk(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, '/').split('/');
  if (parts.some((p) => p === '__MACOSX')) return true;
  const base = parts[parts.length - 1] ?? '';
  return base.startsWith('._') || base === '.DS_Store';
}
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

export function extractReadableText(absPath: string, filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  try {
    if (TEXT_EXTENSIONS.has(ext) || ext === '') {
      const buf = fs.readFileSync(absPath);
      if (looksLikeBinary(buf)) {
        // empty extension often means binary; still try utf-8 if mostly text
        if (ext !== '') return buf.toString('utf-8');
        return null;
      }
      return buf.toString('utf-8');
    }

    if (ext === '.docx') {
      return extractDocxText(absPath);
    }
    if (ext === '.xlsx' || ext === '.xlsm') {
      return extractXlsxText(absPath);
    }

    // Sniff unknown types: if mostly printable UTF-8, include full content
    const buf = fs.readFileSync(absPath);
    if (!looksLikeBinary(buf) && buf.length > 0) {
      return buf.toString('utf-8');
    }
  } catch {
    return null;
  }
  return null;
}

function looksLikeBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) return true;
  let weird = 0;
  for (const byte of sample) {
    // Allow common whitespace / printable ASCII / high UTF-8
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32) weird += 1;
  }
  return weird / Math.max(sample.length, 1) > 0.05;
}

function stripXmlTags(xml: string): string {
  return xml
    .replace(/<w:tab[^/]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractDocxText(absPath: string): string | null {
  try {
    const zip = new AdmZip(absPath);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) return null;
    return stripXmlTags(entry.getData().toString('utf-8'));
  } catch {
    return null;
  }
}

function extractXlsxText(absPath: string): string | null {
  try {
    const zip = new AdmZip(absPath);
    const parts: string[] = [];
    const shared = zip.getEntry('xl/sharedStrings.xml');
    if (shared) parts.push(stripXmlTags(shared.getData().toString('utf-8')));
    for (const entry of zip.getEntries()) {
      const name = entry.entryName.replace(/\\/g, '/');
      if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) {
        parts.push(stripXmlTags(entry.getData().toString('utf-8')));
      }
    }
    const text = parts.join('\n\n').trim();
    return text || null;
  } catch {
    return null;
  }
}

export interface EvidenceImportResult {
  sessionId: string;
  filesStored: number;
  pagesCreated: number;
  networkCallsCreated: number;
  importedFromExport: boolean;
  importedKnowledgeBase: boolean;
  uploadedEvidenceFiles: string[];
  knowledgeBaseDiagnostics?: Record<string, unknown>;
}

export interface UploadedFileInput {
  originalName: string;
  tempPath: string;
  size: number;
  mimetype: string;
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.+/g, '.');
  return base.slice(0, 200) || 'file';
}

function isZipFilename(name: string): boolean {
  return name.toLowerCase().endsWith('.zip');
}

function isTextLikeFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || ext === '' || ext === '.docx' || ext === '.xlsx' || ext === '.xlsm';
}

function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function readTextContent(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

function copyDirContents(src: string, dest: string): void {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else if (entry.isFile()) {
      ensureDir(path.dirname(destPath));
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function findSessionExportRoot(searchRoot: string, maxDepth = 4): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: searchRoot, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const pagesDir = path.join(current.dir, 'pages');
    const apiDir = path.join(current.dir, 'api');
    const uploadedDir = path.join(current.dir, 'uploaded-evidence');
    if (
      fs.existsSync(pagesDir)
      || fs.existsSync(apiDir)
      || fs.existsSync(uploadedDir)
      || fs.existsSync(path.join(current.dir, 'har'))
      || fs.existsSync(path.join(current.dir, 'screenshots'))
    ) {
      return current.dir;
    }
    if (current.depth >= maxDepth) continue;
    for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return null;
}

function mergeExportTreeIntoSession(exportRoot: string, sessionDir: string): void {
  const knownDirs = ['screenshots', 'html', 'pages', 'api', 'har', 'analysis', 'uploaded-evidence'];
  for (const name of knownDirs) {
    const src = path.join(exportRoot, name);
    if (!fs.existsSync(src)) continue;
    copyDirContents(src, path.join(sessionDir, name));
  }
  for (const entry of fs.readdirSync(exportRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(exportRoot, entry.name), path.join(sessionDir, entry.name));
  }
}

function buildUploadedExtractedData(args: {
  filename: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  contentPreview?: string | null;
}): Record<string, unknown> {
  const fullText = args.contentPreview ?? '';
  const previewText = fullText.slice(0, UPLOAD_VISIBLE_TEXT_MAX);
  return {
    url: `upload://${args.relativePath}`,
    title: args.filename,
    pageType: 'unknown',
    headings: [],
    visibleText: previewText,
    paragraphs: previewText ? [previewText] : [],
    breadcrumbs: ['Uploaded Evidence'],
    allClickables: [],
    forms: [],
    tables: [],
    navigation: {
      sidebar: [],
      topbar: [],
      breadcrumbs: ['Uploaded Evidence'],
      tabs: [],
      dropdowns: [],
      buttons: [],
    },
    modals: [],
    searchBoxes: [],
    cards: [],
    charts: [],
    alerts: [],
    pagination: [],
    storage: { localStorage: [], sessionStorage: [] },
    techStack: { frameworks: [], uiLibraries: [], stateManagement: [], apiClients: [] },
    uploadedEvidence: {
      filename: args.filename,
      relativePath: args.relativePath,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      isUserProvided: true,
      treatedAsPrimaryEvidence: true,
      fullTextIncluded: Boolean(fullText),
      characterCount: fullText.length,
      previewTruncated: fullText.length > UPLOAD_VISIBLE_TEXT_MAX,
    },
  };
}

async function createPageFromUploadedFile(args: {
  sessionId: string;
  projectSlug: string;
  absPath: string;
  relativePath: string;
  mimeType?: string;
}): Promise<boolean> {
  const filename = path.basename(args.relativePath);
  const stat = fs.statSync(args.absPath);
  const contentPreview = extractReadableText(args.absPath, filename);
  const extractedData = buildUploadedExtractedData({
    filename,
    relativePath: args.relativePath.replace(/\\/g, '/'),
    mimeType: args.mimeType ?? 'application/octet-stream',
    sizeBytes: stat.size,
    contentPreview,
  });

  let screenshotPath: string | null = null;
  if (isImageFile(filename)) {
    screenshotPath = path.relative(config.outputDir, args.absPath).replace(/\\/g, '/');
  }

  await prisma.pageCapture.create({
    data: {
      crawlSessionId: args.sessionId,
      url: `upload://${args.relativePath.replace(/\\/g, '/')}`,
      title: filename,
      depth: 0,
      visibleText: contentPreview
        ? contentPreview.slice(0, UPLOAD_VISIBLE_TEXT_MAX)
        : `[Uploaded binary file: ${filename}, ${stat.size} bytes — original preserved on disk for analysis/OCR]`,
      extractedData: JSON.stringify(extractedData),
      screenshotPath,
      fullScreenshotPath: screenshotPath,
    },
  });
  return true;
}

async function hydratePagesFromExport(projectSlug: string, sessionId: string): Promise<number> {
  const pagesDir = getPagesDir(projectSlug, sessionId);
  if (!fs.existsSync(pagesDir)) return 0;

  let created = 0;
  for (const name of fs.readdirSync(pagesDir).filter((f) => f.endsWith('.json'))) {
    const abs = path.join(pagesDir, name);
    const pageData = readJson<Record<string, unknown>>(abs);
    if (!pageData) continue;

    const url = typeof pageData['url'] === 'string' ? pageData['url'] : `file://${name}`;
    const title = typeof pageData['title'] === 'string' ? pageData['title'] : name;
    const visibleText = typeof pageData['visibleText'] === 'string'
      ? pageData['visibleText']
      : '';

    const existing = await prisma.pageCapture.findFirst({
      where: { crawlSessionId: sessionId, url },
    });
    if (existing) continue;

    await prisma.pageCapture.create({
      data: {
        crawlSessionId: sessionId,
        url,
        title,
        depth: 0,
        visibleText: visibleText.slice(0, 20_000),
        extractedData: JSON.stringify(pageData),
        breadcrumbs: JSON.stringify(Array.isArray(pageData['breadcrumbs']) ? pageData['breadcrumbs'] : []),
      },
    });
    created += 1;
  }
  return created;
}

async function hydrateNetworkFromExport(projectSlug: string, sessionId: string): Promise<number> {
  const apiDir = getApiDir(projectSlug, sessionId);
  if (!fs.existsSync(apiDir)) return 0;

  let created = 0;
  for (const name of fs.readdirSync(apiDir).filter((f) => f.endsWith('.json'))) {
    const calls = readJson<Array<Record<string, unknown>>>(path.join(apiDir, name));
    if (!Array.isArray(calls)) continue;

    for (const call of calls) {
      const url = typeof call['url'] === 'string' ? call['url'] : null;
      if (!url) continue;
      const method = typeof call['method'] === 'string' ? call['method'] : 'GET';

      const dup = await prisma.networkCall.findFirst({
        where: { crawlSessionId: sessionId, url, method },
      });
      if (dup) continue;

      await prisma.networkCall.create({
        data: {
          crawlSessionId: sessionId,
          method,
          url,
          queryParams: JSON.stringify(call['queryParams'] ?? null),
          requestPayload: typeof call['requestPayload'] === 'string'
            ? call['requestPayload']
            : JSON.stringify(call['requestPayload'] ?? null),
          requestContentType: typeof call['requestContentType'] === 'string' ? call['requestContentType'] : null,
          responseStatus: typeof call['responseStatus'] === 'number' ? call['responseStatus'] : null,
          responseBody: typeof call['responseBody'] === 'string'
            ? call['responseBody']
            : JSON.stringify(call['responseBody'] ?? null),
          responseContentType: typeof call['responseContentType'] === 'string' ? call['responseContentType'] : null,
          responseSchemaKeys: typeof call['responseSchemaKeys'] === 'string'
            ? call['responseSchemaKeys']
            : JSON.stringify(call['responseSchemaKeys'] ?? null),
          requestHeaders: typeof call['requestHeaders'] === 'string'
            ? call['requestHeaders']
            : JSON.stringify(call['requestHeaders'] ?? null),
          responseHeaders: typeof call['responseHeaders'] === 'string'
            ? call['responseHeaders']
            : JSON.stringify(call['responseHeaders'] ?? null),
          timingMs: typeof call['timingMs'] === 'number' ? call['timingMs'] : null,
          resourceType: typeof call['resourceType'] === 'string' ? call['resourceType'] : null,
          isGraphQL: Boolean(call['isGraphQL']),
          graphQLOperationName: typeof call['graphQLOperationName'] === 'string'
            ? call['graphQLOperationName']
            : null,
        },
      });
      created += 1;
    }
  }
  return created;
}

async function indexKnowledgeBaseAsPages(args: {
  projectSlug: string;
  sessionId: string;
}): Promise<{ pagesCreated: number; diagnostics: Record<string, unknown> }> {
  const kbDir = getKnowledgeBaseDir(args.projectSlug, args.sessionId);
  const repo = new KnowledgeBaseRepository(kbDir);
  await repo.initialize();
  const diagnostics = repo.getDiagnostics();
  let pagesCreated = 0;

  for await (const record of repo.streamKnowledge()) {
    const url = `kb://${record.id}`;
    const existing = await prisma.pageCapture.findFirst({
      where: { crawlSessionId: args.sessionId, url },
    });
    if (existing) continue;

    const extractedData = {
      url,
      title: record.title,
      pageType: 'unknown',
      headings: (record.heading_path ?? []).map((h, i) => ({ level: i + 1, text: h })),
      visibleText: record.text,
      paragraphs: [record.text],
      breadcrumbs: record.heading_path ?? [],
      allClickables: [],
      forms: [],
      tables: [],
      navigation: {
        sidebar: [],
        topbar: [],
        breadcrumbs: record.heading_path ?? [],
        tabs: [],
        dropdowns: [],
        buttons: [],
      },
      modals: [],
      searchBoxes: [],
      cards: [],
      charts: [],
      alerts: [],
      pagination: [],
      storage: { localStorage: [], sessionStorage: [] },
      techStack: { frameworks: [], uiLibraries: [], stateManagement: [], apiClients: [] },
      knowledgeBaseRecord: record,
      uploadedEvidence: {
        filename: record.source_file,
        relativePath: `knowledge-base/structured/knowledge.jsonl#${record.id}`,
        isUserProvided: true,
        isKnowledgeBaseEvidence: true,
        treatedAsPrimaryEvidence: true,
      },
    };

    await prisma.pageCapture.create({
      data: {
        crawlSessionId: args.sessionId,
        url,
        title: record.title,
        depth: 0,
        visibleText: record.text,
        extractedData: JSON.stringify(extractedData),
        breadcrumbs: JSON.stringify(record.heading_path ?? []),
      },
    });
    pagesCreated += 1;
  }

  writeJson(path.join(kbDir, '_reader-diagnostics.json'), {
    ...diagnostics,
    generatedAt: new Date().toISOString(),
  });

  return {
    pagesCreated,
    diagnostics: {
      schemaVersion: diagnostics.schemaVersion,
      validationStatus: diagnostics.validationStatus,
      counts: diagnostics.counts,
      errors: diagnostics.errors.length,
      warnings: diagnostics.warnings.length,
      resolvedVideoReferences: diagnostics.resolvedVideoReferences,
      unresolvedVideoReferences: diagnostics.unresolvedVideoReferences,
      humanReport: diagnostics.humanReport,
    },
  };
}

async function indexUploadedEvidenceDir(args: {
  sessionId: string;
  projectSlug: string;
}): Promise<number> {
  const uploadedDir = getUploadedEvidenceDir(args.projectSlug, args.sessionId);
  if (!fs.existsSync(uploadedDir)) return 0;

  let created = 0;
  const walk = async (dir: string, relPrefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (isAppleDoubleJunk(rel)) continue;
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === '_structure-inventory.json') continue;

      const url = `upload://uploaded-evidence/${rel.replace(/\\/g, '/')}`;
      const existing = await prisma.pageCapture.findFirst({
        where: { crawlSessionId: args.sessionId, url },
      });
      if (existing) continue;

      const ok = await createPageFromUploadedFile({
        sessionId: args.sessionId,
        projectSlug: args.projectSlug,
        absPath: abs,
        relativePath: `uploaded-evidence/${rel.replace(/\\/g, '/')}`,
      });
      if (ok) created += 1;
    }
  };
  await walk(uploadedDir, '');
  return created;
}

function writeUploadedStructureInventory(projectSlug: string, sessionId: string): void {
  const uploadedDir = getUploadedEvidenceDir(projectSlug, sessionId);
  if (!fs.existsSync(uploadedDir)) return;

  const files: Array<{ path: string; sizeBytes: number; readableText: boolean }> = [];
  const walk = (dir: string, relPrefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (isAppleDoubleJunk(rel)) continue;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(abs);
      files.push({
        path: rel.replace(/\\/g, '/'),
        sizeBytes: stat.size,
        readableText: Boolean(extractReadableText(abs, entry.name)),
      });
    }
  };
  walk(uploadedDir, '');

  writeJson(path.join(uploadedDir, '_structure-inventory.json'), {
    generatedAt: new Date().toISOString(),
    note: 'Complete inventory of uploaded evidence of any structure — all files preserved for analysis context.',
    totalFiles: files.length,
    files,
  });
}

function extractZipSafely(zipPath: string, destDir: string): number {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  let fileCount = 0;

  ensureDir(destDir);
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const entryName = entry.entryName.replace(/\\/g, '/');
    if (isAppleDoubleJunk(entryName)) continue;
    if (entryName.includes('..') || path.isAbsolute(entryName)) {
      throw new Error(`Unsafe zip entry path: ${entryName}`);
    }
    const target = path.join(destDir, entryName);
    const resolved = path.resolve(target);
    const resolvedDest = path.resolve(destDir);
    if (resolved !== resolvedDest && !resolved.startsWith(resolvedDest + path.sep)) {
      throw new Error(`Zip entry escapes destination: ${entryName}`);
    }
    ensureDir(path.dirname(target));
    zip.extractEntryTo(entry, destDir, true, true);
    fileCount += 1;
  }
  return fileCount;
}

async function storeRegularFile(args: {
  projectSlug: string;
  sessionId: string;
  file: UploadedFileInput;
}): Promise<string> {
  const uploadedDir = getUploadedEvidenceDir(args.projectSlug, args.sessionId);
  let filename = sanitizeFilename(args.file.originalName);
  let dest = path.join(uploadedDir, filename);
  let counter = 1;
  while (fs.existsSync(dest)) {
    const ext = path.extname(filename);
    const stem = path.basename(filename, ext);
    filename = `${stem}-${counter}${ext}`;
    dest = path.join(uploadedDir, filename);
    counter += 1;
  }
  fs.copyFileSync(args.file.tempPath, dest);
  return `uploaded-evidence/${filename}`;
}

export async function processEvidenceImport(args: {
  projectId: string;
  projectSlug: string;
  sessionId: string;
  files: UploadedFileInput[];
}): Promise<EvidenceImportResult> {
  const sessionDir = getSessionOutputDir(args.projectSlug, args.sessionId);
  ensureDir(sessionDir);
  ensureDir(getPagesDir(args.projectSlug, args.sessionId));
  ensureDir(getApiDir(args.projectSlug, args.sessionId));
  ensureDir(getHarDir(args.projectSlug, args.sessionId));
  ensureDir(getHtmlDir(args.projectSlug, args.sessionId));
  ensureDir(getScreenshotsDir(args.projectSlug, args.sessionId));
  ensureDir(getUploadedEvidenceDir(args.projectSlug, args.sessionId));

  const uploadedEvidenceFiles: string[] = [];
  let importedFromExport = false;
  let importedKnowledgeBase = false;
  let knowledgeBaseDiagnostics: Record<string, unknown> | undefined;
  const tempExtractRoots: string[] = [];

  try {
    for (const file of args.files) {
      if (isZipFilename(file.originalName)) {
        const extractRoot = path.join(sessionDir, '_zip-import', sanitizeFilename(file.originalName).replace(/\.zip$/i, ''));
        ensureDir(extractRoot);
        tempExtractRoots.push(extractRoot);
        extractZipSafely(file.tempPath, extractRoot);
        uploadedEvidenceFiles.push(`zip:${file.originalName}`);

        // Always preserve the complete archive tree — any folder layout is kept as additional evidence.
        copyDirContents(extractRoot, getUploadedEvidenceDir(args.projectSlug, args.sessionId));

        const kbRoot = detectKnowledgeBaseRoot(extractRoot);
        if (kbRoot) {
          const kbDest = getKnowledgeBaseDir(args.projectSlug, args.sessionId);
          copyDirContents(kbRoot, kbDest);
          importedKnowledgeBase = true;
          logger.info(`[EvidenceImport] Detected structured knowledge-base package → ${kbDest}`);
        }

        const exportRoot = findSessionExportRoot(extractRoot);
        // Avoid treating a KB tree as a crawl export (KB may contain nested folders)
        const isKbAlsoExport = Boolean(kbRoot && exportRoot && (
          exportRoot === kbRoot || exportRoot.startsWith(kbRoot + path.sep)
        ));
        if (exportRoot && !isKbAlsoExport) {
          mergeExportTreeIntoSession(exportRoot, sessionDir);
          importedFromExport = true;
        }
      } else {
        // Loose manifest-containing folders aren't uploaded as dirs via multipart;
        // single files still go to uploaded-evidence. If someone uploads manifest.json
        // alone it remains arbitrary evidence.
        const rel = await storeRegularFile({
          projectSlug: args.projectSlug,
          sessionId: args.sessionId,
          file,
        });
        uploadedEvidenceFiles.push(rel);
      }
    }

    // Also detect KB if user unzipped contents already landed under uploaded-evidence
    if (!importedKnowledgeBase) {
      const uploadedDir = getUploadedEvidenceDir(args.projectSlug, args.sessionId);
      const kbInUploaded = detectKnowledgeBaseRoot(uploadedDir);
      if (kbInUploaded) {
        const kbDest = getKnowledgeBaseDir(args.projectSlug, args.sessionId);
        copyDirContents(kbInUploaded, kbDest);
        importedKnowledgeBase = true;
      }
    }

    let pagesCreated = await hydratePagesFromExport(args.projectSlug, args.sessionId);
    const networkCallsCreated = await hydrateNetworkFromExport(args.projectSlug, args.sessionId);

    if (importedKnowledgeBase) {
      const kbPages = await indexKnowledgeBaseAsPages({
        projectSlug: args.projectSlug,
        sessionId: args.sessionId,
      });
      pagesCreated += kbPages.pagesCreated;
      knowledgeBaseDiagnostics = kbPages.diagnostics;
    }

    pagesCreated += await indexUploadedEvidenceDir({
      sessionId: args.sessionId,
      projectSlug: args.projectSlug,
    });

    writeUploadedStructureInventory(args.projectSlug, args.sessionId);

    const pagesCount = await prisma.pageCapture.count({ where: { crawlSessionId: args.sessionId } });
    const summary = {
      filesUploaded: args.files.length,
      filesStored: uploadedEvidenceFiles.length,
      pagesIndexed: pagesCount,
      networkCallsIndexed: networkCallsCreated,
      importedFromExport,
      importedKnowledgeBase,
      knowledgeBaseDiagnostics,
      uploadedEvidenceFiles,
      treatedAsPrimaryEvidence: true,
    };

    writeJson(path.join(sessionDir, 'upload-manifest.json'), {
      ...summary,
      importedAt: new Date().toISOString(),
    });

    await prisma.crawlSession.update({
      where: { id: args.sessionId },
      data: {
        status: 'completed',
        sourceType: 'upload',
        uploadSummary: JSON.stringify(summary),
        pagesCount,
        finishedAt: new Date(),
        startedAt: new Date(),
      },
    });

    logger.info(
      `[EvidenceImport] Session ${args.sessionId}: ${pagesCount} pages, ${networkCallsCreated} network calls, export=${importedFromExport}, kb=${importedKnowledgeBase}`,
    );

    return {
      sessionId: args.sessionId,
      filesStored: uploadedEvidenceFiles.length,
      pagesCreated,
      networkCallsCreated,
      importedFromExport,
      importedKnowledgeBase,
      uploadedEvidenceFiles,
      knowledgeBaseDiagnostics,
    };
  } finally {
    for (const dir of tempExtractRoots) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    for (const file of args.files) {
      try {
        fs.unlinkSync(file.tempPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

export function loadUploadedEvidenceForAnalysis(
  projectSlug: string,
  sourceSessionIds: string[],
): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const sessionId of sourceSessionIds) {
    const uploadedDir = getUploadedEvidenceDir(projectSlug, sessionId);
    if (fs.existsSync(uploadedDir)) {
      const walk = (dir: string, relPrefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
          const abs = path.join(dir, entry.name);
          if (isAppleDoubleJunk(rel)) continue;
          if (entry.isDirectory()) {
            walk(abs, rel);
            continue;
          }
          if (!entry.isFile()) continue;
          if (entry.name === '_structure-inventory.json') continue;
          const stat = fs.statSync(abs);
          const content = extractReadableText(abs, entry.name);
          results.push({
            sessionId,
            relativePath: `uploaded-evidence/${rel.replace(/\\/g, '/')}`,
            filename: entry.name,
            sizeBytes: stat.size,
            isUserProvidedEvidence: true,
            content: content ?? null,
            contentIncludedInAnalysis: Boolean(content),
            characterCount: content?.length ?? 0,
          });
        }
      };
      walk(uploadedDir, '');
    }

    const kbDir = path.join(config.outputDir, projectSlug, sessionId, 'knowledge-base');
    if (fs.existsSync(path.join(kbDir, 'manifest.json'))) {
      try {
        const repo = new KnowledgeBaseRepository(kbDir);
        // Sync init path for report packaging — initialize is async but we block here
        // via deasync-free pattern: callers of this function are async contexts in report.ts
        // so we expose an async variant below for those call sites.
        results.push({
          sessionId,
          relativePath: 'knowledge-base/manifest.json',
          filename: 'manifest.json',
          isUserProvidedEvidence: true,
          isKnowledgeBaseEvidence: true,
          content: fs.readFileSync(path.join(kbDir, 'manifest.json'), 'utf-8'),
          contentIncludedInAnalysis: true,
          note: 'Full structured KB is loaded via loadKnowledgeBaseEvidenceForAnalysis()',
        });
      } catch {
        // ignore; async loader handles structured content
      }
    }
  }
  return results;
}

export async function loadKnowledgeBaseEvidenceForAnalysis(
  projectSlug: string,
  sourceSessionIds: string[],
): Promise<Array<Record<string, unknown>>> {
  const packages: Array<Record<string, unknown>> = [];
  for (const sessionId of sourceSessionIds) {
    const kbDir = path.join(config.outputDir, projectSlug, sessionId, 'knowledge-base');
    if (!fs.existsSync(path.join(kbDir, 'manifest.json'))) continue;
    try {
      const repo = new KnowledgeBaseRepository(kbDir);
      await repo.initialize();
      const diagnostics = repo.getDiagnostics();
      const documents = await repo.toEvidenceDocuments();
      const chunks: unknown[] = [];
      for await (const chunk of repo.streamChunks()) {
        chunks.push(chunk);
      }
      packages.push({
        sessionId,
        kind: 'knowledge_base_package',
        isUserProvidedEvidence: true,
        isKnowledgeBaseEvidence: true,
        schemaVersion: diagnostics.schemaVersion,
        validationStatus: diagnostics.validationStatus,
        counts: diagnostics.counts,
        warnings: diagnostics.warnings,
        errors: diagnostics.errors,
        unresolvedVideoReferences: diagnostics.unresolvedVideoReferences,
        resolvedVideoReferences: diagnostics.resolvedVideoReferences,
        records: documents,
        chunks,
        canonicalMarkdown: await repo.readCanonicalMarkdown(false).catch(() => null),
        humanDiagnostics: diagnostics.humanReport,
      });
    } catch (err) {
      packages.push({
        sessionId,
        kind: 'knowledge_base_package',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return packages;
}
