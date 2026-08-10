import { normalizeGraphKey, stableGraphHash } from './evidence-graph-identity'
import type {
  EvidenceGraphEntityCandidate,
  EvidenceGraphEntityReference,
  EvidenceGraphExtraction,
  EvidenceGraphMetadata,
  EvidenceGraphRelationship,
  EvidenceGraphRelationshipCandidate,
} from './evidence-graph-types'

export interface DeterministicExtractionInput {
  readonly type: 'stdout' | 'stderr'
  readonly text: string
  readonly sequence: number
  readonly timestamp: string
}

interface ParserState {
  pending: string
  currentHost: EvidenceGraphEntityReference | null
  currentUrl: EvidenceGraphEntityReference | null
}

const NMAP_HOST = /^Nmap scan report for\s+(.+?)(?:\s+\(([^)]+)\))?$/i
const NMAP_PORT = /^(\d{1,5})\/(tcp|udp|sctp)\s+(open|filtered|closed)\s+(\S+)(?:\s+(.+))?$/i
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const IPV6 = /(?<![\w:])(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]{2,}(?![\w:])/gi
const URL_PATTERN = /https?:\/\/[^\s<>'"`\])}]+/gi
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const DOMAIN_PATTERN = /(?<![\w:/@.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?![\w.-])/gi
const CVE_PATTERN = /\bCVE-\d{4}-\d{4,7}\b/gi
const CREDENTIAL_PATTERN = /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*([^\s,'"`]+)/gi
const STATUS_PATTERN = /\b(?:HTTP\/\d(?:\.\d)?|status(?:\s+code)?)\s*[:=]?\s*(\d{3})\b/i
const TECHNOLOGY_HEADER_PATTERN = /^(server|x-powered-by|x-generator)\s*:\s*(.+)$/i

function emptyState(): ParserState {
  return { pending: '', currentHost: null, currentUrl: null }
}

function validIpv4(value: string): boolean {
  const parts = value.split('.').map(Number)
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
}

function trimPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/g, '').replace(/[\])}>]+$/g, '')
}

function safeUrl(value: string): string | null {
  const trimmed = trimPunctuation(value)
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function domain(value: string): string {
  return value.toLowerCase().replace(/^\.+|\.+$/g, '')
}

function addMetadata(base: EvidenceGraphMetadata | undefined, extra: EvidenceGraphMetadata): EvidenceGraphMetadata {
  return { ...(base ?? {}), ...extra }
}

export class DeterministicExtractionEngine {
  private readonly states = new Map<string, ParserState>()

  reset(executionId: string): void {
    this.states.set(executionId, emptyState())
  }

  extract(executionId: string, input: DeterministicExtractionInput): EvidenceGraphExtraction {
    const state = this.states.get(executionId) ?? emptyState()
    this.states.set(executionId, state)
    if (input.text.includes('\u0000')) {
      state.pending = ''
      return { entities: [], relationships: [] }
    }
    const entities = new Map<string, EvidenceGraphEntityCandidate>()
    const relationships = new Map<string, EvidenceGraphRelationshipCandidate>()
    const addEntity = (candidate: EvidenceGraphEntityCandidate): EvidenceGraphEntityReference => {
      const key = `${candidate.type}|${normalizeGraphKey(candidate.canonicalKey)}`
      if (!entities.has(key))
        entities.set(key, {
          ...candidate,
          canonicalKey: normalizeGraphKey(candidate.canonicalKey),
          metadata: candidate.metadata ?? {},
        })
      return { type: candidate.type, canonicalKey: normalizeGraphKey(candidate.canonicalKey) }
    }
    const link = (
      source: EvidenceGraphEntityReference,
      target: EvidenceGraphEntityReference,
      relationship: EvidenceGraphRelationship,
      confidence: number,
      metadata: EvidenceGraphMetadata = {},
      dedupeKey = `${source.type}:${source.canonicalKey}|${relationship}|${target.type}:${target.canonicalKey}`,
    ): void => {
      const sourceKey = `${source.type}|${normalizeGraphKey(source.canonicalKey)}`
      const targetKey = `${target.type}|${normalizeGraphKey(target.canonicalKey)}`
      const key = `${sourceKey}|${relationship}|${targetKey}|${normalizeGraphKey(dedupeKey)}`
      if (!relationships.has(key))
        relationships.set(key, {
          source: { type: source.type, canonicalKey: normalizeGraphKey(source.canonicalKey) },
          target: { type: target.type, canonicalKey: normalizeGraphKey(target.canonicalKey) },
          relationship,
          confidence: Math.max(0, Math.min(1, confidence)),
          metadata,
          dedupeKey,
        })
    }
    const addEntityAndLink = (
      candidate: EvidenceGraphEntityCandidate,
      confidence = 0.85,
    ): EvidenceGraphEntityReference => {
      const reference = addEntity(candidate)
      if (state.currentHost) link(state.currentHost, reference, 'RELATED_TO', confidence, { parser: 'generic' })
      if (state.currentUrl && candidate.type !== 'url')
        link(state.currentUrl, reference, candidate.type === 'technology' ? 'DETECTED' : 'RELATED_TO', confidence, {
          parser: 'generic',
        })
      return reference
    }
    const lines = `${state.pending}${input.text}`.split(/\r?\n/)
    state.pending = lines.pop() ?? ''
    for (const line of lines) this.parseLine(line.trim(), state, addEntity, addEntityAndLink, link)
    return { entities: [...entities.values()], relationships: [...relationships.values()] }
  }

  flush(executionId: string): EvidenceGraphExtraction {
    const state = this.states.get(executionId)
    if (!state || state.pending.length === 0) return { entities: [], relationships: [] }
    const pending = state.pending
    state.pending = ''
    return this.extract(executionId, {
      type: 'stdout',
      text: `${pending}\n`,
      sequence: Number.MAX_SAFE_INTEGER,
      timestamp: new Date(0).toISOString(),
    })
  }

  private parseLine(
    line: string,
    state: ParserState,
    addEntity: (candidate: EvidenceGraphEntityCandidate) => EvidenceGraphEntityReference,
    addEntityAndLink: (candidate: EvidenceGraphEntityCandidate, confidence?: number) => EvidenceGraphEntityReference,
    link: (
      source: EvidenceGraphEntityReference,
      target: EvidenceGraphEntityReference,
      relationship: EvidenceGraphRelationship,
      confidence: number,
      metadata?: EvidenceGraphMetadata,
      dedupeKey?: string,
    ) => void,
  ): void {
    if (!line) return

    const hostMatch = line.match(NMAP_HOST)
    if (hostMatch) {
      const hostValue = hostMatch[1]!.trim()
      const address = hostMatch[2]?.trim()
      const host = addEntity({
        type: 'host',
        canonicalKey: hostValue,
        label: hostValue,
        value: hostValue,
        metadata: { parser: 'nmap' },
      })
      state.currentHost = host
      if (address && validIpv4(address)) {
        const ip = addEntity({
          type: 'ip',
          canonicalKey: address,
          label: address,
          value: address,
          metadata: { version: 4, parser: 'nmap' },
        })
        link(host, ip, 'RESOLVES_TO', 0.99, { parser: 'nmap' })
      } else if (address && address.includes(':')) {
        const ip = addEntity({
          type: 'ip',
          canonicalKey: address.toLowerCase(),
          label: address,
          value: address,
          metadata: { version: 6, parser: 'nmap' },
        })
        link(host, ip, 'RESOLVES_TO', 0.99, { parser: 'nmap' })
      }
    }

    const portMatch = line.match(NMAP_PORT)
    if (portMatch && state.currentHost) {
      const port = portMatch[1]!
      const protocol = portMatch[2]!.toLowerCase()
      const serviceName = portMatch[4]!.toLowerCase()
      const versionInfo = portMatch[5]?.trim() ?? ''
      const portRef = addEntity({
        type: 'port',
        canonicalKey: `${protocol}/${port}`,
        label: `${port}/${protocol}`,
        value: port,
        metadata: {
          protocol,
          state: portMatch[3]!.toLowerCase(),
          parser: 'nmap',
          ...(versionInfo ? { version: versionInfo } : {}),
        },
      })
      const serviceRef = addEntity({
        type: 'service',
        canonicalKey: `${protocol}:${serviceName}`,
        label: serviceName,
        value: serviceName,
        metadata: { protocol, parser: 'nmap' },
      })
      link(state.currentHost, portRef, 'EXPOSES', 0.99, {
        protocol,
        state: portMatch[3]!.toLowerCase(),
        parser: 'nmap',
      })
      link(portRef, serviceRef, 'RUNS', 0.98, { protocol, parser: 'nmap' })
      if (versionInfo) {
        const technologyRef = addEntity({
          type: 'technology',
          canonicalKey: `${serviceName}:${versionInfo}`,
          label: versionInfo,
          value: versionInfo,
          metadata: { service: serviceName, parser: 'nmap' },
        })
        link(serviceRef, technologyRef, 'DETECTED', 0.9, { parser: 'nmap' })
      }
    }

    const urls = [...line.matchAll(URL_PATTERN)]
      .map((match) => safeUrl(match[0]!))
      .filter((value): value is string => value !== null)
    for (const value of urls) {
      state.currentUrl = addEntity({
        type: 'url',
        canonicalKey: value,
        label: value,
        value,
        metadata: { parser: 'generic' },
      })
    }

    const statusMatch = line.match(STATUS_PATTERN)
    if (statusMatch && state.currentUrl) {
      const status = Number(statusMatch[1])
      const evidence = addEntity({
        type: 'evidence',
        canonicalKey: `http-status:${state.currentUrl.canonicalKey}:${status}`,
        label: `HTTP ${status}`,
        value: null,
        metadata: { status, parser: 'http' },
      })
      link(state.currentUrl, evidence, 'EVIDENCE_FOR', 0.98, { status, parser: 'http' })
    }

    const titleMatch = line.match(/<title[^>]*>([^<]{1,200})<\/title>/i)
    if (titleMatch && state.currentUrl) {
      const title = titleMatch[1]!.trim()
      const evidence = addEntity({
        type: 'evidence',
        canonicalKey: `http-title:${state.currentUrl.canonicalKey}:${normalizeGraphKey(title)}`,
        label: `Title: ${title}`,
        value: title,
        metadata: { parser: 'http' },
      })
      link(state.currentUrl, evidence, 'EVIDENCE_FOR', 0.95, { parser: 'http' })
    }

    const technologyHeader = line.match(TECHNOLOGY_HEADER_PATTERN)
    if (technologyHeader && state.currentUrl) {
      const label = technologyHeader[2]!.trim().slice(0, 200)
      const technology = addEntity({
        type: 'technology',
        canonicalKey: label,
        label,
        value: label,
        metadata: { header: technologyHeader[1]!.toLowerCase(), parser: 'http' },
      })
      link(state.currentUrl, technology, 'DETECTED', 0.96, {
        header: technologyHeader[1]!.toLowerCase(),
        parser: 'http',
      })
    }

    const pathMatch =
      line.match(/(?:^|\s)(?:found|directory|dir)\s*[:=]?\s*(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,300})/i) ??
      line.match(/(?:^|\s)(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{2,300})(?:\s+\[?status\b|\s*$)/i)
    if (pathMatch) {
      const path = pathMatch[1]!
      const isFile = /\.[A-Za-z0-9]{1,8}$/.test(path)
      const file = addEntity({
        type: 'file',
        canonicalKey: path,
        label: path,
        value: path,
        metadata: { kind: isFile ? 'file' : 'directory', parser: 'directory-discovery' },
      })
      if (state.currentUrl) link(state.currentUrl, file, 'LINKS_TO', 0.9, { parser: 'directory-discovery' })
    }

    const screenshotMatch = line.match(/(?:screenshot|screencap)\s+(?:saved|written)\s*(?:to|:)\s*([^\s]{1,300})/i)
    if (screenshotMatch) {
      addEntityAndLink(
        {
          type: 'screenshot',
          canonicalKey: screenshotMatch[1]!,
          label: screenshotMatch[1]!,
          value: screenshotMatch[1]!,
          metadata: { parser: 'generic' },
        },
        0.9,
      )
    }

    const findingMatch = line.match(/\bfinding\s*[:=]\s*(.{1,200})$/i)
    if (findingMatch)
      addEntityAndLink(
        {
          type: 'finding',
          canonicalKey: findingMatch[1]!.trim(),
          label: findingMatch[1]!.trim(),
          value: findingMatch[1]!.trim(),
          metadata: { parser: 'generic' },
        },
        0.88,
      )

    for (const match of line.matchAll(CREDENTIAL_PATTERN)) {
      const kind = match[1]!.toLowerCase()
      const secret = match[2]!
      const credential = addEntity({
        type: 'credential',
        canonicalKey: `${kind}:${stableGraphHash(secret)}`,
        label: `redacted ${kind}`,
        value: null,
        metadata: { kind, redacted: true, parser: 'generic' },
      })
      if (state.currentUrl)
        link(state.currentUrl, credential, 'RELATED_TO', 0.85, { kind, redacted: true, parser: 'generic' })
    }

    for (const match of line.matchAll(CVE_PATTERN)) {
      const cve = match[0]!.toUpperCase()
      addEntityAndLink(
        { type: 'vulnerability', canonicalKey: cve, label: cve, value: cve, metadata: { parser: 'generic' } },
        0.98,
      )
    }

    const emails = [...line.matchAll(EMAIL_PATTERN)].map((match) => match[0]!.toLowerCase())
    for (const email of emails)
      addEntityAndLink(
        {
          type: 'domain',
          canonicalKey: email.split('@')[1]!,
          label: email.split('@')[1]!,
          value: email.split('@')[1]!,
          metadata: { emailDomain: true, parser: 'generic' },
        },
        0.86,
      )

    const urlValues = new Set(urls)
    for (const match of line.matchAll(IPV4)) {
      const value = match[0]!
      if (validIpv4(value))
        addEntityAndLink(
          { type: 'ip', canonicalKey: value, label: value, value, metadata: { version: 4, parser: 'generic' } },
          0.92,
        )
    }
    for (const match of line.matchAll(IPV6)) {
      const value = match[0]!.toLowerCase()
      if (value.includes(':'))
        addEntityAndLink(
          { type: 'ip', canonicalKey: value, label: value, value, metadata: { version: 6, parser: 'generic' } },
          0.92,
        )
    }
    for (const match of line.matchAll(DOMAIN_PATTERN)) {
      const value = domain(match[0]!)
      if (!value || [...urlValues].some((url) => url.includes(value))) continue
      addEntityAndLink(
        { type: 'domain', canonicalKey: value, label: value, value, metadata: { parser: 'generic' } },
        0.86,
      )
    }
  }
}
