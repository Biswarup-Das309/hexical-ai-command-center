import { 
  ASTDiffResult, 
  ASTDiffNode, 
  ScanRecord, 
  DiffOperationType,
  Finding
} from './hexical-types';

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ GENERIC TYPES & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

export interface DiffEngineConfig {
  ignoredKeys?: string[];
}

interface StackFrame {
  path: string;
  oldNode: unknown;
  newNode: unknown;
}

const DEFAULT_CONFIG: DiffEngineConfig = {
  // Broadened to ignore noisy compiler metadata and comments
  ignoredKeys: ['loc', 'range', 'position', 'start', 'end', 'comments', 'raw', 'extra', 'parent', 'leadingComments', 'trailingComments'],
};

// Bulletproof, globally-safe high-resolution timer
const now = (() => {
  if (typeof globalThis !== 'undefined' && globalThis.performance && typeof globalThis.performance.now === 'function') {
    return () => globalThis.performance.now();
  }
  return () => Date.now();
})();

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ CORE DIFF ENGINE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * HEXICAL SEMANTIC AST DIFF ENGINE
 * Evaluates structural and value-based mutations across execution graphs safely.
 */
export function calculateASTDiff(
  previousScan: ScanRecord,
  currentScan: ScanRecord,
  config: DiffEngineConfig = DEFAULT_CONFIG
): ASTDiffResult & { metrics: { nodesVisited: number; executionTimeMs: number; added: number; removed: number; modified: number; moveOperations: number } } {
  
  const startTime = now();
  let nodesVisited = 0;

  const addedCandidates: ASTDiffNode[] = [];
  const removedCandidates: ASTDiffNode[] = [];
  const modifiedNodes: ASTDiffNode[] = [];

  // 1. FAST PATH: Cryptographic Hash Verification (Assumes SHA-256 or BLAKE3 collisions are impossible)
  const oldHash = previousScan.astContext.syntaxTreeHash;
  const newHash = currentScan.astContext.syntaxTreeHash;
  if (oldHash && oldHash === newHash) {
    return buildResult(previousScan, currentScan, [], [], [], 0, 0, 0);
  }

  // 2. ITERATIVE TRAVERSAL
  const stack: StackFrame[] = [
    { path: 'root', oldNode: previousScan.astContext, newNode: currentScan.astContext }
  ];

  const visitedPairs = new WeakMap<Record<string, unknown>, WeakSet<Record<string, unknown>>>();
  
  // Optimization: Instantiate ignored Set once, outside the high-frequency loop
  const ignoredKeysSet = new Set(config.ignoredKeys ?? []);

  while (stack.length > 0) {
    const { path, oldNode, newNode } = stack.pop()!;
    nodesVisited++;

    if (oldNode === undefined && newNode !== undefined) {
      addedCandidates.push(createNode(path, newNode, 'INSERT', undefined, newNode));
      continue;
    }
    if (oldNode !== undefined && newNode === undefined) {
      removedCandidates.push(createNode(path, oldNode, 'DELETE', oldNode, undefined));
      continue;
    }

    const oldIsObj = isObject(oldNode);
    const newIsObj = isObject(newNode);

    if (!oldIsObj || !newIsObj) {
      if (oldNode !== newNode) {
        modifiedNodes.push(createNode(path, 'Primitive', 'UPDATE', oldNode, newNode));
      }
      continue;
    }

    // Pair-based Cycle Detection for DAG safety
    let newSet = visitedPairs.get(oldNode);
    if (newSet && newSet.has(newNode)) continue;
    if (!newSet) {
      newSet = new WeakSet<Record<string, unknown>>();
      visitedPairs.set(oldNode, newSet);
    }
    newSet.add(newNode);

    if (oldNode.type && newNode.type && oldNode.type !== newNode.type) {
      modifiedNodes.push(createNode(path, String(newNode.type), 'UPDATE', oldNode, newNode));
      continue;
    }

    if (hasPrimitiveMutation(oldNode, newNode, ignoredKeysSet)) {
      modifiedNodes.push(createNode(path, String(newNode.type || 'Object'), 'UPDATE', oldNode, newNode));
      continue;
    }

    const allKeys = new Set([...Object.keys(oldNode), ...Object.keys(newNode)]);
    
    for (const key of allKeys) {
      if (ignoredKeysSet.has(key) || key === 'type') continue;

      const oldChild = oldNode[key];
      const newChild = newNode[key];

      if (Array.isArray(oldChild) || Array.isArray(newChild)) {
        const oldArr = Array.isArray(oldChild) ? oldChild : [];
        const newArr = Array.isArray(newChild) ? newChild : [];
        alignArraysLCS(oldArr, newArr, `${path}.${key}`, stack);
      } else if (isObject(oldChild) || isObject(newChild)) {
        stack.push({ path: `${path}.${key}`, oldNode: oldChild, newNode: newChild });
      }
    }
  }

  // 3. POST-PROCESSING: Move detection
  const { addedNodes, removedNodes, movedNodes } = resolveMoveOperations(addedCandidates, removedCandidates);
  modifiedNodes.push(...movedNodes);

  const executionTimeMs = now() - startTime;
  
  return buildResult(
    previousScan,
    currentScan,
    addedNodes,
    removedNodes,
    modifiedNodes,
    nodesVisited,
    executionTimeMs,
    movedNodes.length
  );
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ ALGORITHMIC UTILITIES (LCS, Move Detection)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Longest Common Subsequence (LCS) Array Alignment.
 * Intelligently aligns reordered/shifted sibling nodes instead of blindly comparing by index.
 */
function alignArraysLCS(oldArr: unknown[], newArr: unknown[], basePath: string, stack: StackFrame[]) {
  // Performance Guard: Fallback to index-by-index for massive arrays to prevent O(N^2) CPU block
  if (oldArr.length === 0 || newArr.length === 0 || oldArr.length > 100 || newArr.length > 100) {
    const maxLen = Math.max(oldArr.length, newArr.length);
    for (let i = 0; i < maxLen; i++) {
      stack.push({ path: `${basePath}[${i}]`, oldNode: oldArr[i], newNode: newArr[i] });
    }
    return;
  }

  const dp = Array(oldArr.length + 1).fill(0).map(() => Array(newArr.length + 1).fill(0));
  const sigOld = oldArr.map(getStructuralSignature);
  const sigNew = newArr.map(getStructuralSignature);

  // Build DP Table
  for (let i = 1; i <= oldArr.length; i++) {
    for (let j = 1; j <= newArr.length; j++) {
      if (sigOld[i - 1] === sigNew[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack alignment
  let i = oldArr.length;
  let j = newArr.length;
  const alignedOld: unknown[] = [];
  const alignedNew: unknown[] = [];

  while (i > 0 && j > 0) {
    if (sigOld[i - 1] === sigNew[j - 1]) {
      alignedOld.unshift(oldArr[i - 1]);
      alignedNew.unshift(newArr[j - 1]);
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      alignedOld.unshift(oldArr[i - 1]);
      alignedNew.unshift(undefined);
      i--;
    } else {
      alignedOld.unshift(undefined);
      alignedNew.unshift(newArr[j - 1]);
      j--;
    }
  }
  while (i > 0) { alignedOld.unshift(oldArr[i - 1]); alignedNew.unshift(undefined); i--; }
  while (j > 0) { alignedOld.unshift(undefined); alignedNew.unshift(newArr[j - 1]); j--; }

  for (let k = 0; k < alignedOld.length; k++) {
    stack.push({ path: `${basePath}[${k}]`, oldNode: alignedOld[k], newNode: alignedNew[k] });
  }
}

function resolveMoveOperations(added: ASTDiffNode[], removed: ASTDiffNode[]) {
  const finalAdded: ASTDiffNode[] = [];
  const finalRemoved: ASTDiffNode[] = [];
  const movedNodes: ASTDiffNode[] = [];

  const removedMap = new Map<string, ASTDiffNode[]>();
  for (const rm of removed) {
    const sig = getStructuralSignature(rm.beforeSnapshot);
    if (!removedMap.has(sig)) removedMap.set(sig, []);
    removedMap.get(sig)!.push(rm);
  }

  for (const add of added) {
    const sig = getStructuralSignature(add.afterSnapshot);
    const candidates = removedMap.get(sig);

    if (candidates && candidates.length > 0) {
      const matchedRemove = candidates.shift()!;
      movedNodes.push({
        path: add.path,
        nodeType: add.nodeType,
        operation: 'MOVE',
        beforeSnapshot: matchedRemove.beforeSnapshot,
        afterSnapshot: add.afterSnapshot
      });
    } else {
      finalAdded.push(add);
    }
  }

  for (const candidates of removedMap.values()) finalRemoved.push(...candidates);
  return { addedNodes: finalAdded, removedNodes: finalRemoved, movedNodes };
}

function hasPrimitiveMutation(oldAst: Record<string, unknown>, newAst: Record<string, unknown>, ignoredKeysSet: Set<string>): boolean {
  const allKeys = new Set([...Object.keys(oldAst), ...Object.keys(newAst)]);
  
  for (const key of allKeys) {
    if (ignoredKeysSet.has(key) || key === 'type') continue;
    const oldVal = oldAst[key];
    const newVal = newAst[key];
    if (!isObject(oldVal) && !isObject(newVal) && oldVal !== newVal) return true;
  }
  return false;
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ TYPE GUARDS & SIGNATURE FACTORIES
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createNode(path: string, nodeOrType: unknown, operation: DiffOperationType, before: unknown, after: unknown): ASTDiffNode {
  const nodeType = isObject(nodeOrType) ? String(nodeOrType.type || 'unknown') : String(nodeOrType);
  return { path, nodeType, operation, beforeSnapshot: before, afterSnapshot: after };
}

function getStructuralSignature(node: unknown): string {
  if (!isObject(node)) return String(node);
  
  const keys = Object.keys(node);
  const childCount = keys.filter(k => isObject(node[k]) || Array.isArray(node[k])).length;

  return [
    node.type || '?',
    node.name || '',
    node.operator || '',
    node.value || '',
    node.identifier || '',
    node.kind || '',
    isObject(node.callee) ? String(node.callee.name) : '',
    isObject(node.property) ? String(node.property.name) : '',
    node.async ? 'async' : '',
    node.generator ? 'gen' : '',
    keys.length, // Total property count
    childCount   // Nested node count
  ].join(':');
}

function getFindingSignature(f: Finding): string {
  return `${f.id}:${f.risk || 'UNKNOWN'}:${f.likelihood || 'UNKNOWN'}:${f.boxConfidence ?? 0}`;
}

function checkFindingsDelta(oldFindings: Finding[], newFindings: Finding[]): boolean {
  if (oldFindings.length !== newFindings.length) return true;
  const oldSignatures = new Set(oldFindings.map(getFindingSignature));
  return newFindings.some(f => !oldSignatures.has(getFindingSignature(f)));
}

function buildResult(
  prev: ScanRecord, curr: ScanRecord, added: ASTDiffNode[], removed: ASTDiffNode[],
  modified: ASTDiffNode[], nodesVisited: number, executionTimeMs: number, moveOps: number
) {
  const deltaCount = added.length + removed.length + modified.length;
  
  return {
    previousScanId: prev.id,
    currentScanId: curr.id,
    addedNodes: added,
    removedNodes: removed,
    modifiedNodes: modified,
    structuralDeltaCount: deltaCount,
    riskChanged: prev.overallRisk !== curr.overallRisk,
    findingsChanged: checkFindingsDelta(prev.findingsList, curr.findingsList),
    hasChanges: deltaCount > 0,
    metrics: {
      nodesVisited,
      executionTimeMs,
      added: added.length,
      removed: removed.length,
      modified: modified.length - moveOps,
      moveOperations: moveOps
    }
  };
}
