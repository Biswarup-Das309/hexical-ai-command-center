/**
 * @file lib/hexical/util.ts
 * Stateless helpers with no Redis/Supabase/provider dependencies.
 */

import { createHash } from 'crypto';
import { OUTPUT_MAX_CHARS, REQUEST_MAX_AGE_MS } from './types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

export function sanitizeLabel(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  return raw.replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 50);
}

const OUTPUT_SCRUB_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-[a-zA-Z0-9\-_]{20,}/g, '[API_KEY_REDACTED]'],
  [/Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi, '[BEARER_REDACTED]'],
  [/eyJ[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_.+/]+=*/g, '[JWT_REDACTED]'],
  [/(ANTHROPIC|GROQ|OPENAI|SUPABASE|UPSTASH|GEMINI|DEEPSEEK|CLERK)_[A-Z_]+/g, '[ENV_VAR_REDACTED]'],
  [/process\.env\.[A-Z_]{3,}/g, '[ENV_REF_REDACTED]'],
  [/my\s+(system\s+)?prompt\s+(is|says|tells|instructs)/gi, '[META_REDACTED]'],
  [/your\s+(system\s+)?instructions?\s+(are|say|tell)/gi, '[META_REDACTED]'],
] as const;

export function sanitizeOutput(raw: string): string {
  let out = raw;
  for (const [pattern, replacement] of OUTPUT_SCRUB_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out.slice(0, OUTPUT_MAX_CHARS);
}

export function truncateToChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function extractConfidenceScore(text: string, fallback: number): number {
  const match = text.match(/\bconfidence\s*[:=-]\s*(\d{1,3})(?:\s*%)?/i);
  if (!match) return fallback;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, parsed));
}

export function monthKeyPart(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function dayKeyPart(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function secondsUntilNextMonth(now = new Date()): number {
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.ceil((nextMonth.getTime() - now.getTime()) / 1_000) + 86_400;
}

export function secondsUntilTomorrow(now = new Date()): number {
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.ceil((tomorrow.getTime() - now.getTime()) / 1_000) + 3_600;
}

export function isTimestampFresh(tsMs: number | undefined): boolean {
  if (tsMs === undefined) return true;
  const ageMs = Date.now() - tsMs;
  return ageMs >= 0 && ageMs <= REQUEST_MAX_AGE_MS;
}

export function firstClientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = headers.get('x-real-ip')?.trim();
  const candidate = forwarded || realIp || 'unknown';
  return candidate.replace(/[^a-zA-Z0-9:._-]/g, '').slice(0, 80) || 'unknown';
}

export function jsonHeaders(extra?: Record<string, string>): HeadersInit {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store, no-cache',
    ...extra,
  };
}

/** Normalizes a user-submitted hostname/URL for scope matching: strips
 *  protocol, path, query, port, and lowercases. Returns null if nothing
 *  hostname-shaped can be extracted. */
export function normalizeHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withScheme).hostname || null;
  } catch {
    return trimmed.replace(/^https?:\/\//, '').split(/[/:?#]/)[0] || null;
  }
}

/** Matches a normalized hostname against a scope pattern that may use a
 *  single leading wildcard label, e.g. "*.example.com" matches
 *  "api.example.com" and "example.com" itself. */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern) return false;
  if (!normalizedPattern.startsWith('*.')) return host === normalizedPattern;
  const suffix = normalizedPattern.slice(1); // ".example.com"
  return host === normalizedPattern.slice(2) || host.endsWith(suffix);
}

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body too large.');
    this.name = 'RequestBodyTooLargeError';
  }
}

/** Reads a request body while enforcing a hard byte cap *during* the read
 *  (not just via the Content-Length header, which a client can omit or
 *  lie about) — aborts the moment the true byte count crosses the limit. */
export async function readJsonBodyWithLimit(req: Request, maxBytes: number): Promise<unknown> {
  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyTooLargeError();
  }
  if (!req.body) return null;

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return JSON.parse(new TextDecoder().decode(buffer));
}