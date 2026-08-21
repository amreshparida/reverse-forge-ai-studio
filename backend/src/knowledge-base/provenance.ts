import type {
  DiagnosticItem,
  KnowledgeBaseDiagnostics,
  KnowledgeBaseManifest,
} from './types';

export function buildDiagnostics(args: {
  manifest: KnowledgeBaseManifest | null;
  errors: DiagnosticItem[];
  warnings: DiagnosticItem[];
  info: DiagnosticItem[];
  counts: Record<string, number>;
  unresolvedVideoReferences: number;
  resolvedVideoReferences: number;
  validationStatusFromReport?: string;
}): KnowledgeBaseDiagnostics {
  const schemaVersion = args.manifest?.schema_version ?? null;
  const source = args.manifest?.source as Record<string, unknown> | undefined;
  const sourceDocumentSha256 =
    typeof source?.['sha256'] === 'string'
      ? source['sha256']
      : typeof source?.['document_sha256'] === 'string'
        ? (source['document_sha256'] as string)
        : null;

  const manifestStatistics = args.manifest?.statistics ?? {};
  const hasErrors = args.errors.length > 0;
  const reportStatus = (args.validationStatusFromReport ?? '').toUpperCase();
  const validationStatus: KnowledgeBaseDiagnostics['validationStatus'] = hasErrors
    ? 'FAIL'
    : reportStatus === 'PASS' || reportStatus === 'FAIL'
      ? (reportStatus as 'PASS' | 'FAIL')
      : args.warnings.length
        ? 'PASS'
        : 'PASS';

  const lines = [
    `KB schema version: ${schemaVersion ?? 'unknown'}`,
    `Source SHA-256: ${sourceDocumentSha256 ?? 'n/a'}`,
    ...Object.entries(args.counts).map(([k, v]) => `${k}: ${v}`),
    `Resolved video references: ${args.resolvedVideoReferences}`,
    `Unresolved video references: ${args.unresolvedVideoReferences}`,
    `Errors: ${args.errors.length}`,
    `Warnings: ${args.warnings.length}`,
    `Validation: ${validationStatus}`,
  ];
  if (args.errors.length) {
    lines.push('--- Errors ---');
    for (const e of args.errors) lines.push(`[${e.code}] ${e.message}`);
  }
  if (args.warnings.length) {
    lines.push('--- Warnings ---');
    for (const w of args.warnings) lines.push(`[${w.code}] ${w.message}`);
  }

  return {
    schemaVersion,
    sourceDocumentSha256,
    initialized: true,
    errors: args.errors,
    warnings: args.warnings,
    info: args.info,
    counts: args.counts,
    manifestStatistics,
    unresolvedVideoReferences: args.unresolvedVideoReferences,
    resolvedVideoReferences: args.resolvedVideoReferences,
    validationStatus,
    humanReport: lines.join('\n'),
  };
}

export function diag(
  level: DiagnosticItem['level'],
  code: string,
  message: string,
  path?: string,
): DiagnosticItem {
  return { level, code, message, path };
}
