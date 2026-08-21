import type {
  GraphEdge,
  GraphNode,
  GraphTraversalResult,
  TraversalOptions,
} from './types';

export function buildEdgeIndexes(edges: GraphEdge[]): {
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
} {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const out = outgoing.get(edge.from) ?? [];
    out.push(edge);
    outgoing.set(edge.from, out);
    const inn = incoming.get(edge.to) ?? [];
    inn.push(edge);
    incoming.set(edge.to, inn);
  }
  return { outgoing, incoming };
}

export function traverseGraph(args: {
  startId: string;
  nodesById: Map<string, GraphNode>;
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
  options: TraversalOptions;
}): GraphTraversalResult {
  const maxDepth = args.options.maxDepth ?? 2;
  const limit = args.options.limit ?? 100;
  const direction = args.options.direction ?? 'outgoing';
  const allow = args.options.relationships?.length
    ? new Set(args.options.relationships)
    : null;

  const visitedNodes = new Set<string>();
  const visitedEdges = new Set<string>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const paths: string[][] = [];

  const queue: Array<{ id: string; depth: number; path: string[] }> = [
    { id: args.startId, depth: 0, path: [args.startId] },
  ];
  visitedNodes.add(args.startId);
  const startNode = args.nodesById.get(args.startId);
  if (startNode) nodes.push(startNode);

  while (queue.length > 0 && nodes.length < limit) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const candidates: GraphEdge[] = [];
    if (direction === 'outgoing' || direction === 'both') {
      candidates.push(...(args.outgoing.get(current.id) ?? []));
    }
    if (direction === 'incoming' || direction === 'both') {
      candidates.push(...(args.incoming.get(current.id) ?? []));
    }

    for (const edge of candidates) {
      if (allow && !allow.has(edge.relationship)) continue;
      const edgeKey = `${edge.from}|${edge.relationship}|${edge.to}|${edge.id ?? ''}`;
      if (visitedEdges.has(edgeKey)) continue;
      visitedEdges.add(edgeKey);
      edges.push(edge);

      const nextId = edge.from === current.id ? edge.to : edge.from;
      if (visitedNodes.has(nextId)) continue;
      visitedNodes.add(nextId);
      const node = args.nodesById.get(nextId);
      if (node) nodes.push(node);
      const nextPath = [...current.path, nextId];
      paths.push(nextPath);
      queue.push({ id: nextId, depth: current.depth + 1, path: nextPath });
      if (nodes.length >= limit) break;
    }
  }

  return { startId: args.startId, nodes, edges, paths };
}
