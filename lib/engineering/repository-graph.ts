import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { Json } from '@/lib/database.types'
import {
  REPOSITORY_MAX_EDGES,
  REPOSITORY_MAX_FILE_BYTES,
  REPOSITORY_MAX_FILES,
  REPOSITORY_MAX_NODES,
  REPOSITORY_MAX_TOTAL_BYTES,
  type RepositoryEdge,
  type RepositoryEdgeEvidence,
  type RepositoryFileInput,
  type RepositoryGraph,
  type RepositoryNode,
  type RepositorySnapshotInput,
  type SourceReference,
} from './types'

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  sql: 'sql',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
}

const CONFIG_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'vite.config.ts',
  'eslint.config.js',
  'eslint.config.mjs',
  'prettier.config.js',
  'prettier.config.cjs',
  '.env.example',
])

function jsonRecord(value: Record<string, unknown>): Readonly<Record<string, Json>> {
  return value as Readonly<Record<string, Json>>
}

export function normalizeRepositoryPath(rawPath: string): string | null {
  const normalized = rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null
  const parts = normalized.split('/')
  if (parts.some((part) => part === '..' || part === '')) return null
  return parts.join('/')
}

function languageForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_LANGUAGE[extension] ?? 'unknown'
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[^.]+$/i.test(path)
}

function isSecuritySensitive(path: string): boolean {
  return /(^|\/)(auth|security|middleware|session|permission|entitlement|billing|tty|runtime)(\/|\.|$)/i.test(path)
}

function redactedExcerpt(line: string): string {
  return line
    .replace(/(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*)(['"]).{4,}?\3/gi, '$1$2$3[redacted]$3')
    .slice(0, 240)
}

function source(path: string, line: number, excerpt: string): SourceReference {
  return { path, startLine: line, endLine: line, excerpt: redactedExcerpt(excerpt) }
}

function evidence(
  explanation: string,
  path: string,
  line: number,
  excerpt: string,
  certainty: RepositoryEdgeEvidence['certainty'] = 'OBSERVED',
): RepositoryEdgeEvidence {
  return { type: 'graph_relationship', certainty, source: source(path, line, excerpt), explanation }
}

function nodeId(kind: RepositoryNode['kind'], key: string): string {
  return `${kind}:${key}`
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 24)
}

function importCandidates(sourcePath: string, specifier: string): string[] {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return []
  const base = specifier.startsWith('@/') ? specifier.slice(2) : posix.join(posix.dirname(sourcePath), specifier)
  const clean = posix.normalize(base).replace(/^\.\//, '')
  return [
    clean,
    `${clean}.ts`,
    `${clean}.tsx`,
    `${clean}.js`,
    `${clean}.jsx`,
    `${clean}/index.ts`,
    `${clean}/index.tsx`,
    `${clean}/index.js`,
  ]
}

function resolveInternalImport(sourcePath: string, specifier: string, files: ReadonlySet<string>): string | null {
  for (const candidate of importCandidates(sourcePath, specifier)) if (files.has(candidate)) return candidate
  return null
}

function parseSecuritySignals(content: string): string[] {
  const signals: string[] = []
  if (/\beval\s*\(|new\s+Function\s*\(/.test(content)) signals.push('dynamic_code_execution')
  if (/\b(exec|spawn|system)\s*\(/.test(content)) signals.push('process_execution')
  if (/(password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}/i.test(content)) signals.push('credential_literal')
  if (/innerHTML\s*=|dangerouslySetInnerHTML/.test(content)) signals.push('html_injection_sink')
  return signals
}

function buildFileNode(file: RepositoryFileInput): { node: RepositoryNode; metadata: Record<string, Json> } {
  const path = file.path
  const language = languageForPath(path)
  const test = isTestPath(path)
  const config = CONFIG_NAMES.has(path.split('/').pop() ?? '')
  const signals = parseSecuritySignals(file.content)
  const metadata = {
    bytes: Buffer.byteLength(file.content, 'utf8'),
    digest: digest(file.content),
    isTest: test,
    isConfiguration: config,
    securitySensitive: isSecuritySensitive(path),
    securitySignals: signals,
  } as unknown as Record<string, Json>
  return {
    node: {
      id: nodeId(test ? 'test' : config ? 'configuration' : 'file', path),
      kind: test ? 'test' : config ? 'configuration' : 'file',
      key: path,
      name: path.split('/').pop() ?? path,
      path,
      language,
      metadata: jsonRecord(metadata),
    },
    metadata,
  }
}

function fileNodeId(path: string, files: ReadonlyMap<string, RepositoryNode>): string {
  const node = files.get(path)
  return node?.id ?? nodeId('file', path)
}

function addDirectoryNodes(path: string, nodes: Map<string, RepositoryNode>): void {
  const parts = path.split('/')
  let parent = ''
  for (let index = 0; index < parts.length - 1; index += 1) {
    parent = parent ? `${parent}/${parts[index]}` : parts[index]
    const id = nodeId('directory', parent)
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: 'directory',
        key: parent,
        name: parts[index],
        path: parent,
        metadata: {},
      })
    }
  }
}

function addEdge(edges: RepositoryEdge[], edge: Omit<RepositoryEdge, 'id'>): void {
  const id = `${edge.source}|${edge.relation}|${edge.target}`
  if (!edges.some((candidate) => candidate.id === id)) edges.push({ id, ...edge })
}

function parseSymbols(
  path: string,
  content: string,
  nodes: Map<string, RepositoryNode>,
  edges: RepositoryEdge[],
  fileNodes: ReadonlyMap<string, RepositoryNode>,
): number {
  let count = 0
  const lines = content.split(/\r?\n/)
  const symbolPatterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  ]
  for (let index = 0; index < lines.length; index += 1) {
    for (const symbolPattern of symbolPatterns) {
      for (const match of lines[index].matchAll(symbolPattern)) {
        const name = match[1]
        if (!name) continue
        const key = `${path}:${name}:${index + 1}`
        const id = nodeId('symbol', key)
        nodes.set(id, {
          id,
          kind: 'symbol',
          key,
          name,
          path,
          language: fileNodes.get(path)?.language,
          metadata: jsonRecord({ line: index + 1, exported: /^\s*export\b/.test(lines[index]) }),
        })
        const fileId = fileNodeId(path, fileNodes)
        addEdge(edges, {
          source: fileId,
          target: id,
          relation: 'contains',
          direct: true,
          confidence: 'high',
          evidence: evidence('Symbol declaration observed in source.', path, index + 1, lines[index]),
        })
        count += 1
      }
    }
  }
  return count
}

function parseImports(
  path: string,
  content: string,
  fileNodes: ReadonlyMap<string, RepositoryNode>,
  nodes: Map<string, RepositoryNode>,
  edges: RepositoryEdge[],
): { internal: number; external: number; unknown: number } {
  const counts = { internal: 0, external: 0, unknown: 0 }
  const lines = content.split(/\r?\n/)
  const importPatterns = [
    /from\s*(['"])([^'"]+)\1/g,
    /import\s*(?:\(\s*)?(['"])([^'"]+)\1/g,
    /require\s*\(\s*(['"])([^'"]+)\1/g,
  ]
  for (let index = 0; index < lines.length; index += 1) {
    for (const importPattern of importPatterns) {
      for (const match of lines[index].matchAll(importPattern)) {
        const specifier = match[2]
        if (!specifier) continue
        const targetPath = resolveInternalImport(path, specifier, new Set([...fileNodes.keys()]))
        let target: RepositoryNode
        let confidence: RepositoryEdge['confidence'] = 'high'
        if (targetPath) {
          target = fileNodes.get(targetPath)!
          counts.internal += 1
        } else if (!specifier.startsWith('.') && !specifier.startsWith('@/')) {
          const key = specifier
          const id = nodeId('external_dependency', key)
          target = nodes.get(id) ?? {
            id,
            kind: 'external_dependency',
            key,
            name: key,
            path: null,
            metadata: {},
          }
          nodes.set(id, target)
          confidence = 'medium'
          counts.external += 1
        } else {
          const key = `${path}:${specifier}:${index + 1}`
          const id = nodeId('unknown_dependency', key)
          target = {
            id,
            kind: 'unknown_dependency',
            key,
            name: specifier,
            path: null,
            metadata: jsonRecord({ specifier }),
          }
          nodes.set(id, target)
          confidence = 'unknown'
          counts.unknown += 1
        }
        addEdge(edges, {
          source: fileNodeId(path, fileNodes),
          target: target.id,
          relation: 'imports',
          direct: true,
          confidence,
          evidence: evidence(
            targetPath
              ? 'Internal import resolved against the submitted repository snapshot.'
              : 'Import observed but target was not resolved in the submitted snapshot.',
            path,
            index + 1,
            lines[index],
          ),
        })
      }
    }
  }
  return counts
}

function addTestEdges(path: string, fileNodes: ReadonlyMap<string, RepositoryNode>, edges: RepositoryEdge[]): void {
  if (!isTestPath(path)) return
  const normalized = path.replace(/\.(test|spec)(?=\.)/i, '').replace(/(^|\/)__tests__\//, '$1')
  const candidates = [normalized, normalized.replace(/^tests\//, ''), normalized.replace(/^test\//, '')]
  const target = candidates.find((candidate) => fileNodes.has(candidate))
  if (!target) return
  addEdge(edges, {
    source: fileNodeId(path, fileNodes),
    target: fileNodeId(target, fileNodes),
    relation: 'tests',
    direct: true,
    confidence: 'medium',
    evidence: {
      type: 'graph_relationship',
      certainty: 'DERIVED',
      explanation: 'Test relationship inferred from a conventional test filename.',
      source: { path },
    },
  })
}

export function buildRepositoryGraph(snapshot: RepositorySnapshotInput): RepositoryGraph {
  if (!snapshot.repositoryKey.trim()) throw new Error('A repository key is required.')
  if (snapshot.files.length === 0) throw new Error('At least one repository file is required.')
  if (snapshot.files.length > REPOSITORY_MAX_FILES)
    throw new Error(`Repository exceeds the ${REPOSITORY_MAX_FILES}-file limit.`)

  const files: RepositoryFileInput[] = []
  const seen = new Set<string>()
  let totalBytes = 0
  for (const input of snapshot.files) {
    const path = normalizeRepositoryPath(input.path)
    if (!path || seen.has(path)) continue
    const bytes = Buffer.byteLength(input.content, 'utf8')
    if (bytes > REPOSITORY_MAX_FILE_BYTES)
      throw new Error(`File exceeds the ${REPOSITORY_MAX_FILE_BYTES}-byte limit: ${path}`)
    totalBytes += bytes
    if (totalBytes > REPOSITORY_MAX_TOTAL_BYTES)
      throw new Error(`Repository exceeds the ${REPOSITORY_MAX_TOTAL_BYTES}-byte limit.`)
    seen.add(path)
    files.push({ path, content: input.content })
  }
  if (files.length === 0) throw new Error('No valid repository files were supplied.')

  const nodes = new Map<string, RepositoryNode>()
  const edges: RepositoryEdge[] = []
  const fileNodes = new Map<string, RepositoryNode>()
  const repositoryNode: RepositoryNode = {
    id: nodeId('repository', snapshot.repositoryKey),
    kind: 'repository',
    key: snapshot.repositoryKey,
    name: snapshot.repositoryKey,
    path: snapshot.root?.trim() || '/',
    metadata: jsonRecord({ fileCount: files.length }),
  }
  nodes.set(repositoryNode.id, repositoryNode)

  for (const file of files) {
    const { node } = buildFileNode(file)
    nodes.set(node.id, node)
    fileNodes.set(file.path, node)
    addDirectoryNodes(file.path, nodes)
    addEdge(edges, {
      source: repositoryNode.id,
      target: node.id,
      relation: 'contains',
      direct: true,
      confidence: 'high',
      evidence: {
        type: 'source_file',
        certainty: 'OBSERVED',
        source: { path: file.path },
        explanation: 'File was directly supplied in the repository snapshot.',
      },
    })
  }

  for (const file of files) {
    const parent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : null
    if (parent) {
      const directoryId = nodeId('directory', parent)
      addEdge(edges, {
        source: directoryId,
        target: fileNodeId(file.path, fileNodes),
        relation: 'contains',
        direct: true,
        confidence: 'high',
        evidence: {
          type: 'source_file',
          certainty: 'DERIVED',
          source: { path: file.path },
          explanation: 'Directory membership derived from the normalized path.',
        },
      })
    }
    parseSymbols(file.path, file.content, nodes, edges, fileNodes)
    parseImports(file.path, file.content, fileNodes, nodes, edges)
    addTestEdges(file.path, fileNodes, edges)

    if (/\/route\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.path) || /^pages\/api\//.test(file.path)) {
      const routeId = nodeId('route', file.path)
      nodes.set(routeId, {
        id: routeId,
        kind: 'route',
        key: file.path,
        name: file.path,
        path: file.path,
        language: fileNodes.get(file.path)?.language,
        metadata: jsonRecord({
          methods: [...file.content.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)/g)].map(
            (match) => match[1],
          ),
        }),
      })
      addEdge(edges, {
        source: fileNodeId(file.path, fileNodes),
        target: routeId,
        relation: 'routes_to',
        direct: true,
        confidence: 'high',
        evidence: evidence('API route convention observed in the submitted path.', file.path, 1, file.path),
      })
    }

    if (file.path.endsWith('package.json')) {
      try {
        const packageJson = JSON.parse(file.content) as Record<string, unknown>
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
          const dependencies = packageJson[section]
          if (typeof dependencies !== 'object' || dependencies === null) continue
          for (const name of Object.keys(dependencies as Record<string, unknown>)) {
            const packageId = nodeId('package', name)
            const packageNode = nodes.get(packageId) ?? {
              id: packageId,
              kind: 'package' as const,
              key: name,
              name,
              path: null,
              metadata: jsonRecord({ section }),
            }
            nodes.set(packageId, packageNode)
            addEdge(edges, {
              source: fileNodeId(file.path, fileNodes),
              target: packageId,
              relation: 'depends_on',
              direct: true,
              confidence: 'high',
              evidence: evidence(`Dependency declared in ${section}.`, file.path, 1, `${section}.${name}`),
            })
          }
        }
      } catch {
        // Invalid configuration is represented by the file node; ingestion remains safe.
      }
    }
  }

  if (nodes.size > REPOSITORY_MAX_NODES || edges.length > REPOSITORY_MAX_EDGES)
    throw new Error('Repository graph exceeds the configured graph limit.')

  const fileRecords = files.map((file) => ({
    path: file.path,
    language: languageForPath(file.path),
    bytes: Buffer.byteLength(file.content, 'utf8'),
    digest: digest(file.content),
    securitySignals: parseSecuritySignals(file.content),
  }))
  const summary: RepositoryGraph['summary'] = {
    fileCount: files.length,
    directoryCount: [...nodes.values()].filter((node) => node.kind === 'directory').length,
    symbolCount: [...nodes.values()].filter((node) => node.kind === 'symbol').length,
    routeCount: [...nodes.values()].filter((node) => node.kind === 'route').length,
    testCount: [...nodes.values()].filter((node) => node.kind === 'test').length,
    configurationCount: [...nodes.values()].filter((node) => node.kind === 'configuration').length,
    externalDependencyCount: [...nodes.values()].filter(
      (node) => node.kind === 'external_dependency' || node.kind === 'package',
    ).length,
    unknownDependencyCount: [...nodes.values()].filter((node) => node.kind === 'unknown_dependency').length,
    internalRelationshipCount: edges.filter((edge) => edge.relation === 'imports' && edge.confidence === 'high').length,
    securityBoundaryCount: fileRecords.filter((file) => isSecuritySensitive(file.path)).length,
    languages: [...new Set(fileRecords.map((file) => file.language))].sort(),
  }

  return {
    repositoryKey: snapshot.repositoryKey.trim().slice(0, 200),
    root: snapshot.root?.trim().slice(0, 500) || '/',
    generatedAt: new Date().toISOString(),
    files: fileRecords,
    nodes: [...nodes.values()],
    edges,
    summary,
    limitations: [
      'Static relationships are derived from submitted source text and path conventions; generated code and runtime reflection are not observed.',
      'Only the submitted file snapshot is analyzed; no remote repository checkout or package manager execution occurs during ingestion.',
    ],
  }
}
