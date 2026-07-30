/**
 * ============================================================================
 * Hexical AI
 * Severity Engine
 * ----------------------------------------------------------------------------
 * Centralized severity calculation for structural AST changes.
 *
 * Used by:
 *  • ASTDiffViewer
 *  • DiffNodeCard
 *  • Export
 *  • AI summaries
 *  • Future SARIF generation
 * ============================================================================
 */

import { ASTDiffNode } from "@/lib/hexical-types";

/* -------------------------------------------------------------------------- */
/*                                   TYPES                                    */
/* -------------------------------------------------------------------------- */

export type SeverityLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export interface SeverityResult {
  level: SeverityLevel;
  score: number;
  confidence: number;
  reasons: string[];
  badge: string;
  color: string;
  iconColor: string;
}

/* -------------------------------------------------------------------------- */
/*                             VISUAL METADATA                                */
/* -------------------------------------------------------------------------- */

export const SEVERITY_META: Record<
  SeverityLevel,
  Omit<SeverityResult, "score" | "confidence" | "reasons">
> = {
  CRITICAL: {
    level: "CRITICAL",
    badge: "Critical Risk",
    color: "bg-red-600/20 border-red-500/40 text-red-400",
    iconColor: "text-red-500",
  },
  HIGH: {
    level: "HIGH",
    badge: "High Risk",
    color: "bg-orange-500/20 border-orange-500/40 text-orange-400",
    iconColor: "text-orange-500",
  },
  MEDIUM: {
    level: "MEDIUM",
    badge: "Medium Risk",
    color: "bg-yellow-500/20 border-yellow-500/40 text-yellow-300",
    iconColor: "text-yellow-400",
  },
  LOW: {
    level: "LOW",
    badge: "Low Risk",
    color: "bg-blue-500/20 border-blue-500/40 text-blue-300",
    iconColor: "text-blue-400",
  },
  INFO: {
    level: "INFO",
    badge: "Informational",
    color: "bg-zinc-500/20 border-zinc-500/40 text-zinc-300",
    iconColor: "text-zinc-400",
  },
};

/* -------------------------------------------------------------------------- */
/*                              SCORE CONSTANTS                               */
/* -------------------------------------------------------------------------- */

/**
 * These are Maps rather than plain object literals on purpose.
 *
 * `node.operation` / `node.nodeType` are free-form strings that ultimately
 * come from parsed/diffed source — not something this file fully controls.
 * A plain object literal like `{ INSERT: 20, ... }` inherits from
 * `Object.prototype`, so `OBJ["__proto__"]` doesn't return `undefined` — it
 * returns the actual `Object.prototype` object. `?? 0` only guards against
 * `null`/`undefined`, so if `node.nodeType` were ever the string
 * `"__proto__"` (or `"toString"`, `"constructor"`, `"valueOf"`, etc. — from
 * malformed input, or a JSON.parse'd diff file bypassing the type system),
 * `score += NODE_SCORE[node.nodeType]` would add an *object* to a number.
 * JS coerces that via ToPrimitive/toString into the literal string
 * "[object Object]", silently turning `score` into a string for the rest of
 * the function — every later comparison (`score >= 90`, etc.) then compares
 * a string against a number, which either NaNs out or does the wrong thing,
 * and the node's real severity is quietly lost.
 * Map.get() has no prototype chain to fall into, so this class of bug can't
 * happen regardless of what string comes in.
 */
const OPERATION_SCORE = new Map<string, number>([
  ["INSERT", 20],
  ["UPDATE", 35],
  ["MOVE", 10],
  ["DELETE", 45],
]);

const NODE_SCORE = new Map<string, number>([
  ["Program", 40],
  ["FunctionDeclaration", 25],
  ["FunctionExpression", 25],
  ["ArrowFunctionExpression", 20],
  ["ClassDeclaration", 30],
  ["IfStatement", 18],
  ["SwitchStatement", 18],
  ["WhileStatement", 15],
  ["ForStatement", 15],
  ["TryStatement", 22],
  ["CatchClause", 20],
  ["ImportDeclaration", 10],
  ["ExportNamedDeclaration", 15],
  ["VariableDeclaration", 5],
  ["ReturnStatement", 8],
  ["CallExpression", 12],
  ["MemberExpression", 6],
  ["BinaryExpression", 4],
  ["Literal", 1],
]);

/* -------------------------------------------------------------------------- */
/*                             PATH RISK WEIGHTS                              */
/* -------------------------------------------------------------------------- */

const HIGH_RISK_PATH_KEYWORDS = [
  "auth",
  "security",
  "login",
  "jwt",
  "token",
  "permission",
  "middleware",
  "crypto",
  "admin",
];

const CRITICAL_KEYWORDS = [
  "password",
  "jwt",
  "token",
  "secret",
  "apikey",
  "privatekey",
  "rsa",
  "aes",
  "authorization",
];

const MAX_PAYLOAD_SCAN_LENGTH = 20_000;

/**
 * Splits a path into lowercase tokens, treating non-alphanumeric characters
 * AND camelCase/PascalCase transitions as boundaries.
 *
 * Previously, path matching used `path.includes("/auth/")` (slashes
 * included). That avoids matching "authors" mid-word, but it also means a
 * file *named* "auth.ts" or "authMiddleware.ts" — not nested in an "auth/"
 * folder — never matched at all, a real detection gap. Tokenizing instead
 * catches both "src/auth/handler.ts" and "authMiddleware.ts" (→ tokens
 * "auth", "middleware") via a whole-token match, without over-matching
 * partial words like "authors".
 */
function tokenizePath(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map(t => t.toLowerCase())
  );
}

/**
 * Splits free-form content (serialized snapshot payloads) into lowercase
 * tokens on non-alphanumeric boundaries only — deliberately NOT splitting
 * camelCase here. CRITICAL_KEYWORDS includes compound keywords written as
 * one word ("apikey", "privatekey") to match camelCase identifiers like
 * `apiKey`/`privateKey` as they'd appear, lowercased, in serialized JSON
 * ("apikey"). Splitting camelCase first would break "apiKey" into two
 * separate tokens ("api", "key") and the keyword would never match again.
 *
 * Whole-token matching (vs. the previous plain `.includes()`) closes real
 * false positives from short crypto abbreviations: "aes" matches inside
 * "based", "increase", "release", "aesthetic"; "rsa" matches inside
 * "reversal" (contains the substring "rsa"). Token matching only fires on
 * an exact word.
 */
function tokenizeContent(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/**
 * JSON.stringify with cycle tolerance, BigInt support, and a hard length
 * cap — used only to build a scannable text blob for keyword matching, not
 * for faithful serialization. Native JSON.stringify throws outright on
 * circular references and on BigInt values; either one showing up in a
 * before/after snapshot would previously crash severity calculation for
 * that node entirely (and, transitively, whatever batch it was part of).
 */
function safeScanText(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, v) => {
        if (typeof v === "bigint") return `${v.toString()}n`;
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        return v;
      }) ?? ""
    );
  } catch {
    return "";
  }
}

/* -------------------------------------------------------------------------- */
/*                          MAIN SEVERITY CALCULATOR                          */
/* -------------------------------------------------------------------------- */

export function calculateSeverity(node: ASTDiffNode): SeverityResult {
  if (!node || typeof node !== "object") {
    throw new TypeError("calculateSeverity requires a valid AST diff node.");
  }

  let score = 0;
  const reasons: string[] = [];

  score += OPERATION_SCORE.get(node.operation) ?? 0;
  score += NODE_SCORE.get(node.nodeType) ?? 0;

  const path = (node.path ?? "").toLowerCase();
  const pathTokens = tokenizePath(path);

  for (const keyword of HIGH_RISK_PATH_KEYWORDS) {
    if (pathTokens.has(keyword)) {
      score += 25;
      reasons.push(`Touches sensitive path (${keyword})`);
    }
  }

  const payload = (
    safeScanText(node.beforeSnapshot ?? "") + safeScanText(node.afterSnapshot ?? "")
  ).slice(0, MAX_PAYLOAD_SCAN_LENGTH);

  const contentTokens = tokenizeContent(payload);

  for (const keyword of CRITICAL_KEYWORDS) {
    if (contentTokens.has(keyword)) {
      score += 20;
      reasons.push(`Contains "${keyword}"`);
    }
  }

  switch (node.operation) {
    case "DELETE":
      reasons.push("Logic removal detected");
      break;
    case "UPDATE":
      reasons.push("Existing logic modified");
      break;
    case "INSERT":
      reasons.push("New execution path");
      break;
    case "MOVE":
      // Previously had no case at all: MOVE contributed to `score` via
      // OPERATION_SCORE but never got a matching reason, so the UI would
      // show a MOVE-driven score bump with nothing explaining it.
      reasons.push("Code relocated");
      break;
  }

  const level =
    score >= 90
      ? "CRITICAL"
      : score >= 65
      ? "HIGH"
      : score >= 40
      ? "MEDIUM"
      : score >= 20
      ? "LOW"
      : "INFO";

  // NOTE: the original floor was 60, meaning a change with score 0 (no
  // signals at all) was still reported as "60% confident" — the same
  // confidence as a change scoring 39. That's not a meaningful confidence
  // value, it's a fixed floor dressed up as one, which matters for a tool
  // whose job is to be trusted on risk assessment. Floor lowered to 20 so
  // low/no-signal changes are visibly less confident than well-evidenced
  // ones. If the UI was deliberately designed around a 60% floor, adjust
  // MIN_CONFIDENCE back — this is a product call, not just a bug fix.
  const MIN_CONFIDENCE = 20;
  const MAX_CONFIDENCE = 99;
  const confidence = Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, Math.round(score * 0.9)));

  return {
    ...SEVERITY_META[level],
    score,
    confidence,
    reasons,
  };
}

/* -------------------------------------------------------------------------- */
/*                           SORTING UTILITIES                                */
/* -------------------------------------------------------------------------- */

function createSafeRecord<T extends Record<string, number>>(obj: T): T {
  // Same Object.create(null) reasoning as OPERATION_SCORE/NODE_SCORE above,
  // applied here for defense-in-depth: `compareSeverity` and the functions
  // built on it are exported public API that accept caller-constructed
  // SeverityResult-shaped objects, not just ones this module produced
  // itself, so `.level` isn't fully guaranteed to be one of the 5 literals
  // at runtime.
  return Object.assign(Object.create(null), obj);
}

const ORDER: Record<SeverityLevel, number> = createSafeRecord({
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1,
});

export function compareSeverity(a: SeverityResult, b: SeverityResult): number {
  return (ORDER[b.level] ?? 0) - (ORDER[a.level] ?? 0);
}

export function sortBySeverity<T extends { severity: SeverityResult }>(items: T[]): T[] {
  return [...items].sort((a, b) => compareSeverity(a.severity, b.severity));
}

/* -------------------------------------------------------------------------- */
/*                            SUMMARY UTILITIES                               */
/* -------------------------------------------------------------------------- */

export function summarizeSeverity(results: SeverityResult[]) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let highest: SeverityResult | null = null;

  // Single pass computing every count, rather than five separate
  // `.filter().length` passes over the same array.
  for (const r of results) {
    switch (r.level) {
      case "CRITICAL":
        counts.critical++;
        break;
      case "HIGH":
        counts.high++;
        break;
      case "MEDIUM":
        counts.medium++;
        break;
      case "LOW":
        counts.low++;
        break;
      case "INFO":
        counts.info++;
        break;
    }
    if (!highest || compareSeverity(r, highest) < 0) {
      highest = r;
    }
  }

  return { ...counts, highest };
}