import { z } from 'zod';

/** Passthrough schemas: validate required fields, retain unknown keys. */

const stringArray = z.array(z.string()).default([]);
const extensibleArray = z.array(z.record(z.unknown())).default([]);
const extensibleObject = z.record(z.unknown()).default({});

export const ManifestSchema = z
  .object({
    schema_version: z.string(),
    primary_paths: z.record(z.string()).optional(),
    statistics: z.record(z.number()).optional(),
    source: z.record(z.unknown()).optional(),
    build: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const KnowledgeRecordSchema = z
  .object({
    id: z.string(),
    source_type: z.string(),
    content_type: z.string(),
    title: z.string(),
    text: z.string(),
    content_hash: z.string(),
    source_file: z.string(),
    source_path: z.string().nullable().optional(),
    heading_path: stringArray,
    document_section_id: z.string().nullable().optional(),
    video_id: z.string().nullable().optional(),
    bundle_name: z.string().nullable().optional(),
    video_refs: stringArray,
    images: stringArray,
    frames: stringArray,
    entities: stringArray,
    concepts: stringArray,
    topics: stringArray,
    provenance: extensibleArray,
    metadata: extensibleObject,
  })
  .passthrough();

export const KnowledgeChunkSchema = z
  .object({
    chunk_id: z.string(),
    source_id: z.string(),
    text: z.string(),
    source_type: z.string().optional(),
    content_type: z.string().optional(),
    video_id: z.string().nullable().optional(),
    document_section_id: z.string().nullable().optional(),
    heading_path: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
    concepts: z.array(z.string()).optional(),
    entities: z.array(z.string()).optional(),
  })
  .passthrough();

export const GraphNodeSchema = z
  .object({
    id: z.string(),
    label: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export const GraphEdgeSchema = z
  .object({
    id: z.string().optional(),
    from: z.string(),
    to: z.string(),
    relationship: z.string(),
  })
  .passthrough();

export const VideoIndexEntrySchema = z
  .object({
    video_id: z.string(),
    bundle_name: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough();

export const DocumentVideoLinkSchema = z
  .object({
    document_section_id: z.string(),
    video_id: z.string().nullable().optional(),
    bundle_name: z.string().nullable().optional(),
    resolved: z.boolean().optional(),
    reason: z.string().nullable().optional(),
  })
  .passthrough();

export const FrameIndexEntrySchema = z
  .object({
    video_id: z.string(),
    frame_key: z.string().optional(),
    path: z.string(),
  })
  .passthrough();

export const NamedIndexEntrySchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough();

export const ValidationReportSchema = z
  .object({
    status: z.string().optional(),
    warnings: z.array(z.unknown()).optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

export function parsePassthrough<T>(
  schema: z.ZodType<T>,
  value: unknown,
  context: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${context}: ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
}
