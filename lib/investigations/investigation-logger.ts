export interface InvestigationLogFields {
  readonly requestId: string
  readonly investigationId?: string | null
  readonly sessionId?: string | null
  readonly userId?: string | null
  readonly [key: string]: unknown
}

export interface InvestigationLogger {
  readonly info: (event: string, fields: InvestigationLogFields) => void
  readonly warn: (event: string, fields: InvestigationLogFields) => void
  readonly error: (event: string, fields: InvestigationLogFields) => void
}

export const NOOP_INVESTIGATION_LOGGER: InvestigationLogger = { info: () => {}, warn: () => {}, error: () => {} }

interface ConsoleSink {
  readonly log: (line: string) => void
  readonly warn: (line: string) => void
  readonly error: (line: string) => void
}

function emit(
  sink: ConsoleSink,
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: InvestigationLogFields,
): void {
  const line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields })
  if (level === 'error') sink.error(line)
  else if (level === 'warn') sink.warn(line)
  else sink.log(line)
}

/** Every log line carries requestId + investigationId + sessionId + userId so a single
 *  session-attach failure in production can be grepped end-to-end across the session
 *  route, the store, and TTY lifecycle logs from one correlation id. */
export function createInvestigationLogger(sink: ConsoleSink = console): InvestigationLogger {
  return {
    info: (event, fields) => emit(sink, 'info', event, fields),
    warn: (event, fields) => emit(sink, 'warn', event, fields),
    error: (event, fields) => emit(sink, 'error', event, fields),
  }
}

export function newRequestId(request?: Request): string {
  const supplied = request?.headers.get('x-request-id') ?? request?.headers.get('x-correlation-id')
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID()
}
