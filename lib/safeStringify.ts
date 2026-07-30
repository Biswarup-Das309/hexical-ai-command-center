/**
 * ============================================================================
 * Hexical AI
 * Safe JSON Serializer
 * ----------------------------------------------------------------------------
 * Features
 *
 * ✓ Circular reference detection (without false-positives on shared,
 *   non-circular references)
 * ✓ WeakMap serialization cache, keyed by object identity + option set
 * ✓ Max recursion depth
 * ✓ Max payload length
 * ✓ Max array / Set / Map / object-key length (bounded without fully
 *   materializing huge collections)
 * ✓ Running size budget to bail out of pathological inputs before they're
 *   fully built, not just after
 * ✓ Handles:
 *      Date
 *      Error (stack redacted by default — opt in explicitly)
 *      BigInt
 *      Set
 *      Map
 *      Function
 *      Symbol
 * ✓ Pretty printing
 * ✓ Cache reuse (opt-in — see note on mutability below)
 * ✓ Prototype-pollution-safe object handling
 * ============================================================================
 */

export interface SafeStringifyOptions {
  indent?: number;

  maxDepth?: number;

  maxArrayLength?: number;

  /** Cap for Set entries, Map entries, and object keys. */
  maxCollectionSize?: number;

  maxStringLength?: number;

  maxOutputLength?: number;

  /**
   * Cache serialized output per (object identity + option set).
   * Off by default: the cache key is the object reference, not its
   * contents, so a mutable object that changes between calls would
   * otherwise silently return stale output. Only enable this for inputs
   * you know are effectively immutable (e.g. frozen config objects).
   */
  useCache?: boolean;

  /**
   * Include Error.stack in serialized output. Off by default — stack
   * traces can leak internal file paths and structure if this output
   * ever reaches logs/clients outside your trust boundary.
   */
  includeErrorStack?: boolean;
}

interface NormalizedOptions {
  indent: number;
  maxDepth: number;
  maxArrayLength: number;
  maxCollectionSize: number;
  maxStringLength: number;
  maxOutputLength: number;
  useCache: boolean;
  includeErrorStack: boolean;
}

const DEFAULT_OPTIONS: NormalizedOptions = {
  indent: 2,
  maxDepth: 15,
  maxArrayLength: 500,
  maxCollectionSize: 500,
  maxStringLength: 10000,
  maxOutputLength: 50000,
  useCache: false,
  includeErrorStack: false,
};

/**
 * How far over maxOutputLength we let the *pre-stringify* normalized
 * structure grow before bailing out entirely. JSON.stringify adds
 * structural overhead (quotes, braces, commas, indentation) on top of raw
 * content length, so this needs some headroom — but it still bounds
 * work on pathological inputs (e.g. 500 strings x 10,000 chars each)
 * instead of only truncating the final string after it's fully built.
 */
const BUDGET_MULTIPLIER = 4;

function nonNegativeIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function sanitizeOptions(options: SafeStringifyOptions): NormalizedOptions {
  return {
    indent: nonNegativeIntOr(options.indent, DEFAULT_OPTIONS.indent),
    maxDepth: nonNegativeIntOr(options.maxDepth, DEFAULT_OPTIONS.maxDepth),
    maxArrayLength: nonNegativeIntOr(options.maxArrayLength, DEFAULT_OPTIONS.maxArrayLength),
    maxCollectionSize: nonNegativeIntOr(
      options.maxCollectionSize,
      DEFAULT_OPTIONS.maxCollectionSize
    ),
    maxStringLength: nonNegativeIntOr(options.maxStringLength, DEFAULT_OPTIONS.maxStringLength),
    maxOutputLength: nonNegativeIntOr(options.maxOutputLength, DEFAULT_OPTIONS.maxOutputLength),
    useCache: options.useCache ?? DEFAULT_OPTIONS.useCache,
    includeErrorStack: options.includeErrorStack ?? DEFAULT_OPTIONS.includeErrorStack,
  };
}

/**
 * Cache survives across calls, keyed by object identity (WeakMap, so it
 * never leaks memory) and, within that, by a signature of the options used
 * — otherwise two calls with different limits on the same object would
 * incorrectly share output. `let` (not `const`) so clearSerializationCache
 * can actually replace it — see the note on that function below.
 */
let serializationCache = new WeakMap<object, Map<string, string>>();

function optionsSignature(options: NormalizedOptions): string {
  return [
    options.indent,
    options.maxDepth,
    options.maxArrayLength,
    options.maxCollectionSize,
    options.maxStringLength,
    options.maxOutputLength,
    options.includeErrorStack ? 1 : 0,
  ].join("|");
}

function getCached(value: object, signature: string): string | undefined {
  return serializationCache.get(value)?.get(signature);
}

function setCached(value: object, signature: string, output: string): void {
  let inner = serializationCache.get(value);
  if (!inner) {
    inner = new Map();
    serializationCache.set(value, inner);
  }
  inner.set(signature, output);
}

export function safeStringify(value: unknown, options: SafeStringifyOptions = {}): string {
  const opts = sanitizeOptions(options);

  if (value === undefined) return "undefined";
  if (value === null) return "null";

  const isCacheableObject = opts.useCache && typeof value === "object";
  const signature = isCacheableObject ? optionsSignature(opts) : "";

  if (isCacheableObject) {
    const cached = getCached(value as object, signature);
    if (cached !== undefined) {
      return cached;
    }
  }

  const seen = new WeakSet<object>();
  const budget = { used: 0 };

  try {
    // Every value — primitive or object — goes through normalize() so
    // BigInt/Symbol/Function get the same formatting at the top level as
    // when nested. (Previously, JSON.stringify(fn) / JSON.stringify(symbol)
    // return `undefined`, and that `undefined` was returned directly from
    // a function typed to return `string` — a real bug for callers.)
    const normalized = normalize(value, seen, 0, opts, budget);
    const output = JSON.stringify(normalized, null, opts.indent);

    const truncated =
      output.length > opts.maxOutputLength
        ? output.slice(0, opts.maxOutputLength) + "\n\n... [OUTPUT TRUNCATED]"
        : output;

    if (isCacheableObject) {
      setCached(value as object, signature, truncated);
    }

    return truncated;
  } catch (err) {
    return `[Serialization Failed: ${err instanceof Error ? err.message : "Unknown Error"}]`;
  }
}

function trackString(str: string, budget: { used: number }): string {
  budget.used += str.length;
  return str;
}

function normalize(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  options: NormalizedOptions,
  budget: { used: number }
): unknown {
  if (budget.used > options.maxOutputLength * BUDGET_MULTIPLIER) {
    return "[Truncated: output size budget exceeded]";
  }

  if (depth > options.maxDepth) {
    return "[Max Depth Reached]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  switch (typeof value) {
    case "bigint":
      return trackString(value.toString() + "n", budget);

    case "symbol":
      return trackString(value.toString(), budget);

    case "function":
      return trackString(`[Function ${value.name || "anonymous"}]`, budget);

    case "string": {
      if (value.length > options.maxStringLength) {
        return trackString(value.slice(0, options.maxStringLength) + "... [TRUNCATED]", budget);
      }
      return trackString(value, budget);
    }

    case "number":
    case "boolean":
      budget.used += 8;
      return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  try {
    if (value instanceof Date) {
      return trackString(value.toISOString(), budget);
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        ...(options.includeErrorStack ? { stack: value.stack } : {}),
      };
    }

    if (value instanceof Set) {
      const out: unknown[] = [];
      let i = 0;
      for (const item of value) {
        if (i >= options.maxCollectionSize) break;
        out.push(normalize(item, seen, depth + 1, options, budget));
        i++;
        if (budget.used > options.maxOutputLength * BUDGET_MULTIPLIER) break;
      }
      if (value.size > options.maxCollectionSize) {
        out.push(`... ${value.size - options.maxCollectionSize} more items`);
      }
      return { type: "Set", values: out };
    }

    if (value instanceof Map) {
      const out: unknown[] = [];
      let i = 0;
      for (const [k, v] of value) {
        if (i >= options.maxCollectionSize) break;
        out.push([
          normalize(k, seen, depth + 1, options, budget),
          normalize(v, seen, depth + 1, options, budget),
        ]);
        i++;
        if (budget.used > options.maxOutputLength * BUDGET_MULTIPLIER) break;
      }
      if (value.size > options.maxCollectionSize) {
        out.push([`... ${value.size - options.maxCollectionSize} more entries`, undefined]);
      }
      return { type: "Map", entries: out };
    }

    if (Array.isArray(value)) {
      // value.length is O(1); we never materialize more than the cap.
      const limit = Math.min(value.length, options.maxArrayLength);
      const out: unknown[] = [];

      for (let i = 0; i < limit; i++) {
        out.push(normalize(value[i], seen, depth + 1, options, budget));
        if (budget.used > options.maxOutputLength * BUDGET_MULTIPLIER) break;
      }

      if (value.length > options.maxArrayLength) {
        out.push(`... ${value.length - limit} more items`);
      }

      return out;
    }

    // Plain object. Built with a null prototype so an untrusted `__proto__`
    // (or `constructor`/`prototype`) *own key* on the input can't reassign
    // this result object's prototype via the inherited __proto__ setter —
    // `result[key] = ...` on a normal `{}` literal would otherwise trigger
    // exactly that. Object.create(null) has no such setter to trigger.
    const result: Record<string, unknown> = Object.create(null);
    const keys = Object.keys(value);
    const limit = Math.min(keys.length, options.maxCollectionSize);

    for (let i = 0; i < limit; i++) {
      const key = keys[i];
      result[key] = normalize(
        (value as Record<string, unknown>)[key],
        seen,
        depth + 1,
        options,
        budget
      );
      if (budget.used > options.maxOutputLength * BUDGET_MULTIPLIER) break;
    }

    if (keys.length > options.maxCollectionSize) {
      result["...more"] = `${keys.length - limit} more keys omitted`;
    }

    return result;
  } finally {
    // Remove on the way back out (post-order), so only genuine ancestors
    // in the current recursion path count as circular. Previously `seen`
    // entries were never removed, so two *sibling* references to the same
    // shared-but-non-circular object (e.g. `{ a: shared, b: shared }`)
    // were incorrectly both reported as "[Circular]" after the first.
    seen.delete(value);
  }
}

/**
 * Clears cached serializations.
 *
 * A WeakMap can't be iterated or emptied in place, so this replaces the
 * module-level cache with a fresh WeakMap — the old one becomes
 * unreachable and is garbage collected. (Previously this function was a
 * documented no-op that silently did nothing when called.)
 */
export function clearSerializationCache(): void {
  serializationCache = new WeakMap();
}