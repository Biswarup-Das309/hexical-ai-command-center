/**
 * @file lib/hexical/telemetry.ts
 * Structured logs (JSON lines — pipe straight into any log drain / Vercel
 * log stream) plus an optional tracing span helper. If @opentelemetry/api is
 * installed and configured, spans get real trace/span IDs; if not, this
 * degrades to a plain timed log line. Either way call sites don't change.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    service: 'hexical-api',
    message,
    ...fields,
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Returns a bounded correlation ID suitable for structured server logs. */
export function requestCorrelationId(request: Request): string {
  const supplied = request.headers.get('x-request-id') ?? request.headers.get('x-correlation-id');
  return supplied && CORRELATION_ID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
}

interface MinimalSpan {
  setAttribute(key: string, value: string | number | boolean): unknown;
  recordException(err: unknown): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  end(): unknown;
}

interface MinimalTracer {
  startActiveSpan<T>(name: string, fn: (span: MinimalSpan) => Promise<T>): Promise<T>;
}

interface MinimalOtelApi {
  trace: {
    getTracer(name: string): MinimalTracer;
  };
}

let cachedOtel: MinimalOtelApi | null | undefined;

async function loadOtel(): Promise<MinimalOtelApi | null> {
  if (cachedOtel !== undefined) return cachedOtel;
  try {
    const importer = new Function('specifier', 'return import(specifier);') as (v: string) => Promise<MinimalOtelApi>;
    cachedOtel = await importer('@opentelemetry/api');
  } catch {
    cachedOtel = null;
  }
  return cachedOtel;
}

/** Runs `fn` inside a span named `name`. Falls back to a plain timed log
 *  line (with the same `attributes`) if @opentelemetry/api isn't present. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  const otel = await loadOtel();
  const startedAt = Date.now();

  if (!otel) {
    try {
      const result = await fn();
      log.debug(name, { ...attributes, durationMs: Date.now() - startedAt });
      return result;
    } catch (err) {
      log.error(name, { ...attributes, durationMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  const tracer = otel.trace.getTracer('hexical-api');
  return tracer.startActiveSpan(name, async span => {
    for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
   try {
  const result = await fn();

  span.setAttribute('durationMs', Date.now() - startedAt);

  span.setStatus({ code: 1 });

  return result;
} catch (err) {
  span.setAttribute('durationMs', Date.now() - startedAt);

  span.recordException(err);

  span.setStatus({
    code: 2,
    message: err instanceof Error ? err.message : String(err),
  });

  throw err;
}finally {
      span.end();
    }
  });
}
