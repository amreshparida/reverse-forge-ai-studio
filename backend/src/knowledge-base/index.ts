export { resolveKnowledgeBaseRoot, defaultFixtureKbRoot } from './config';
export type { KnowledgeBaseConfig } from './config';
export * from './types';
export {
  KnowledgeBaseRepository,
  detectKnowledgeBaseRoot,
} from './repository';
export { streamJsonlLines, loadJsonlArray, JsonlParseError, writeJsonlSync } from './jsonl';
export { resolveUnderRoot, resolveAssetPath, PathSafetyError, walkFiles } from './path-safety';
export { lexicalSearchChunks, matchesFilters } from './retrieval';
export { traverseGraph, buildEdgeIndexes } from './graph';
