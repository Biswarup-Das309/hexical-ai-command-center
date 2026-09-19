import type { ImpactItem, RepositoryEdge, RepositoryGraph, RepositoryImpactReport } from './types'

function edgesFrom(graph: RepositoryGraph, source: string, relation?: RepositoryEdge['relation']): RepositoryEdge[] {
  return graph.edges.filter((edge) => edge.source === source && (!relation || edge.relation === relation))
}

function edgesTo(graph: RepositoryGraph, target: string, relation?: RepositoryEdge['relation']): RepositoryEdge[] {
  return graph.edges.filter((edge) => edge.target === target && (!relation || edge.relation === relation))
}

function nodeForPath(graph: RepositoryGraph, path: string) {
  return graph.nodes.find((node) => node.path === path && ['file', 'test', 'configuration'].includes(node.kind))
}

function pathForNode(graph: RepositoryGraph, id: string): string {
  return graph.nodes.find((node) => node.id === id)?.path ?? id
}

function item(
  edge: RepositoryEdge,
  graph: RepositoryGraph,
  category: ImpactItem['category'],
  direct: boolean,
): ImpactItem {
  return {
    item: pathForNode(graph, category === 'dependent' ? edge.source : edge.target),
    reason: edge.evidence.explanation,
    evidence: [edge.evidence],
    confidence: edge.confidence,
    direct,
    category,
  }
}

function transitiveDependents(graph: RepositoryGraph, targetId: string): RepositoryEdge[] {
  const visited = new Set<string>([targetId])
  const queue = [targetId]
  const found: RepositoryEdge[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const edge of edgesTo(graph, current, 'imports')) {
      if (visited.has(edge.source)) continue
      visited.add(edge.source)
      queue.push(edge.source)
      found.push(edge)
    }
  }
  return found
}

export function analyzeRepositoryImpact(graph: RepositoryGraph, target: string): RepositoryImpactReport {
  const node = graph.nodes.find((candidate) => candidate.id === target) ?? nodeForPath(graph, target)
  if (!node) {
    return {
      target,
      status: 'UNKNOWN',
      items: [],
      limitations: ['The requested path or symbol is not present in the submitted repository snapshot.'],
    }
  }

  const items: ImpactItem[] = []
  for (const edge of edgesFrom(graph, node.id, 'imports')) items.push(item(edge, graph, 'dependency', true))
  for (const edge of edgesTo(graph, node.id, 'imports')) items.push(item(edge, graph, 'dependent', true))
  for (const edge of transitiveDependents(graph, node.id)) {
    if (!items.some((candidate) => candidate.item === pathForNode(graph, edge.source)))
      items.push(item(edge, graph, 'dependent', false))
  }
  for (const edge of edgesTo(graph, node.id, 'tests')) items.push(item(edge, graph, 'test', true))

  const affectedPaths = new Set(items.map((candidate) => candidate.item).concat(node.path ? [node.path] : []))
  for (const candidate of graph.nodes) {
    if (candidate.kind === 'route' && candidate.path && affectedPaths.has(candidate.path)) {
      items.push({
        item: candidate.path,
        reason: 'Route node is directly represented by the affected path.',
        evidence: [],
        confidence: 'high',
        direct: true,
        category: 'route',
      })
    }
    if (candidate.kind === 'configuration' && candidate.path) {
      items.push({
        item: candidate.path,
        reason: 'Configuration is part of the submitted repository context and may affect the analyzed module.',
        evidence: [],
        confidence: 'low',
        direct: false,
        category: 'configuration',
      })
    }
  }

  if (
    node.metadata.securitySensitive === true ||
    [...affectedPaths].some((path) =>
      /(^|\/)(auth|security|middleware|session|permission|entitlement|billing|tty|runtime)(\/|\.|$)/i.test(path),
    )
  ) {
    items.push({
      item: node.path ?? node.id,
      reason: 'The target or an affected path matches a security/runtime-sensitive boundary.',
      evidence: [],
      confidence: 'medium',
      direct: true,
      category: 'security',
    })
  }
  if ([...affectedPaths].some((path) => /(^|\/)(tty|runtime|worker|tmux|execution)(\/|\.|$)/i.test(path))) {
    items.push({
      item: node.path ?? node.id,
      reason: 'The target or an affected path matches a runtime-sensitive boundary.',
      evidence: [],
      confidence: 'medium',
      direct: true,
      category: 'runtime',
    })
  }

  const deduped = [
    ...new Map(
      items.map((candidate) => [`${candidate.category}:${candidate.item}:${candidate.direct}`, candidate]),
    ).values(),
  ]
  return {
    target: node.path ?? node.id,
    status: graph.summary.unknownDependencyCount > 0 ? 'PARTIALLY_VERIFIED' : 'VERIFIED',
    items: deduped,
    limitations:
      graph.summary.unknownDependencyCount > 0
        ? ['Some relative imports were observed but could not be resolved from the submitted snapshot.']
        : [],
  }
}

export function queryRepositoryGraph(graph: RepositoryGraph) {
  const byPath = (path: string) => nodeForPath(graph, path)
  return {
    dependencies(path: string) {
      const node = byPath(path)
      return node ? edgesFrom(graph, node.id, 'imports').map((edge) => pathForNode(graph, edge.target)) : []
    },
    dependents(path: string) {
      const node = byPath(path)
      return node ? edgesTo(graph, node.id, 'imports').map((edge) => pathForNode(graph, edge.source)) : []
    },
    symbols(path: string) {
      const node = byPath(path)
      return node
        ? edgesFrom(graph, node.id, 'contains')
            .map((edge) => graph.nodes.find((candidate) => candidate.id === edge.target))
            .filter(Boolean)
        : []
    },
    callers(path: string) {
      const node = byPath(path)
      return node ? edgesTo(graph, node.id, 'imports').map((edge) => pathForNode(graph, edge.source)) : []
    },
    tests_for(path: string) {
      const node = byPath(path)
      return node ? edgesTo(graph, node.id, 'tests').map((edge) => pathForNode(graph, edge.source)) : []
    },
    routes_for(path: string) {
      return graph.nodes
        .filter((node) => node.kind === 'route' && node.path === path)
        .map((node) => node.path ?? node.id)
    },
    configuration_for() {
      return graph.nodes.filter((node) => node.kind === 'configuration').map((node) => node.path ?? node.id)
    },
  }
}
