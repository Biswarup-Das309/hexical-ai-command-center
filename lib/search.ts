/**
 * ============================================================================
 * Hexical AI
 * search.ts
 * ----------------------------------------------------------------------------
 * High-performance search/index engine for AST diff nodes.
 *
 * Goals
 * - O(1) query preprocessing
 * - Lazy payload indexing (no JSON serialization during initial load)
 * - Weighted scoring
 * - Tokenized search
 * - Future AI metadata support
 * ============================================================================
 */

import { ASTDiffNode } from "@/lib/hexical-types";

export interface IndexedNode {
  node: ASTDiffNode;
  tokens: Set<string>;
  searchable: string;
  /**
   * Precomputed once at index-build time so searchIndex() never has to
   * re-lowercase path/nodeType per term, per query, per node — previously
   * these were recomputed inside the innermost loop, which quietly defeated
   * the "O(1) query preprocessing" goal above.
   */
  pathLower: string;
  nodeTypeLower: string;
}

export interface SearchResult {
  node: ASTDiffNode;
  score: number;
}

export interface SearchOptions {
  /** Cap on number of results returned, applied after scoring/sorting. */
  maxResults?: number;
}

const TOKEN_SPLIT = /[^a-zA-Z0-9_]+/;

/**
 * Bounds on a single search call. A search box is user-facing input; without
 * these, a very long or highly fragmented query turns the O(index * terms)
 * scoring loop into an easy way to make every search call expensive.
 */
const MAX_QUERY_LENGTH = 500;
const MAX_TERMS = 32;

export function buildSearchIndex(nodes: ASTDiffNode[]): IndexedNode[] {
  if (!Array.isArray(nodes)) {
    throw new TypeError("buildSearchIndex expects an array of AST diff nodes.");
  }

  return nodes.map(node => {
    // Defensive fallbacks: if a node ever comes through with a missing
    // path/nodeType (malformed diff, upstream bug), we index it as empty
    // rather than throwing and dropping the whole index build.
    const path = node.path ?? "";
    const nodeType = node.nodeType ?? "";
    const operation = node.operation ?? "";

    const pathLower = path.toLowerCase();
    const nodeTypeLower = nodeType.toLowerCase();

    const searchable = [path, nodeType, operation]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return {
      node,
      searchable,
      pathLower,
      nodeTypeLower,
      tokens: new Set(searchable.split(TOKEN_SPLIT).filter(Boolean)),
    };
  });
}

export function searchIndex(
  index: IndexedNode[],
  query: string,
  options: SearchOptions = {}
): SearchResult[] {
  const applyLimit = (results: SearchResult[]): SearchResult[] =>
    typeof options.maxResults === "number" && options.maxResults >= 0
      ? results.slice(0, options.maxResults)
      : results;

  const q = (query ?? "")
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .toLowerCase();

  if (!q) {
    return applyLimit(index.map(i => ({ node: i.node, score: 0 })));
  }

  // Dedupe terms: repeating a term in the query ("foo foo foo") shouldn't
  // let a caller inflate a node's score, and it avoids redundant scoring
  // work per duplicate. Also cap the term count as a second line of
  // defense against pathologically fragmented queries.
  const terms = [...new Set(q.split(TOKEN_SPLIT).filter(Boolean))].slice(0, MAX_TERMS);

  if (terms.length === 0) {
    return [];
  }

  const results: SearchResult[] = [];

  for (const item of index) {
    let score = 0;

    for (const term of terms) {
      if (item.searchable.includes(term)) score += 5;
      if (item.tokens.has(term)) score += 20;
      if (item.pathLower.startsWith(term)) score += 40;
      if (item.nodeTypeLower === term) score += 50;
    }

    if (score > 0) {
      results.push({ node: item.node, score });
    }
  }

  results.sort((a, b) => b.score - a.score);

  return applyLimit(results);
}

/**
 * Optional payload search.
 *
 * Call ONLY after user explicitly enables deep search
 * or expands results.
 */
export function payloadContains(
  node: ASTDiffNode,
  term: string,
  stringify: (v: unknown) => string
): boolean {
  const q = (term ?? "").trim().toLowerCase();

  // Guard against the empty-term case: `"anything".includes("")` is always
  // true, so without this check, an accidentally empty deep-search term
  // (cleared input box, upstream bug passing "") would report every single
  // node as a match instead of none.
  if (!q) {
    return false;
  }

  const matches = (value: unknown): boolean => {
    try {
      return stringify(value ?? "").toLowerCase().includes(q);
    } catch {
      // A malformed/circular payload or a throwing stringify implementation
      // shouldn't take down the whole search flow over one bad node.
      return false;
    }
  };

  return matches(node.beforeSnapshot) || matches(node.afterSnapshot);
}