'use client';

import React, { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { 
  ASTDiffResult, 
  ASTDiffNode 
} from '@/lib/hexical-types';
import { 
  Plus, 
  Minus, 
  RefreshCw, 
  ArrowRightLeft, 
  Activity, 
  Clock, 
  ShieldAlert, 
  ChevronDown, 
  ChevronRight,
  CheckCircle2,
  Maximize2,
  Minimize2,
  Search,
  Filter,
  Copy,
  Check,
  Download,
  ChevronsUpDown,
  ChevronsDownUp
} from 'lucide-react';

interface ASTDiffViewerProps {
  diff: ASTDiffResult & { 
    metrics?: { 
      nodesVisited: number; 
      executionTimeMs: number; 
      added?: number; 
      removed?: number; 
      modified?: number; 
      moveOperations?: number; 
    } 
  };
  className?: string;
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ CONSTANTS, UTILS & CIRCULAR-SAFE SERIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

type OperationType = 'INSERT' | 'DELETE' | 'UPDATE' | 'MOVE';

const THEME_MAP: Record<OperationType, { bg: string; border: string; text: string; Icon: React.ElementType }> = {
  INSERT: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400', Icon: Plus },
  DELETE: { bg: 'bg-rose-500/10', border: 'border-rose-500/30', text: 'text-rose-400', Icon: Minus },
  UPDATE: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400', Icon: RefreshCw },
  MOVE:   { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-400', Icon: ArrowRightLeft },
};

const MAX_PAYLOAD_CHARS = 800;
const SAFE_STRINGIFY_LIMIT = 50000;

// Prevent Next.js SSR warnings with useLayoutEffect
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Memory-safe JSON serialization with Circular Reference detection
const safeStringify = (data: unknown): string => {
  if (data === undefined) return 'undefined';
  const seen = new WeakSet();
  try {
    const str = JSON.stringify(data, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    }, 2);
    
    if (str.length > SAFE_STRINGIFY_LIMIT) {
      return str.slice(0, SAFE_STRINGIFY_LIMIT) + '\n\n... [PAYLOAD EXCEEDS SAFE RENDER LIMIT]';
    }
    return str;
  } catch (err) {
    return '[Unserializable Payload]';
  }
};

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ SUB-COMPONENT: DIFF NODE CARD (Memoized, Lazy & Layout-Synchronized)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

interface DiffNodeCardProps {
  node: ASTDiffNode;
  type: OperationType;
  measure: () => void;
  expandSignal: number;
  collapseSignal: number;
}

const DiffNodeCard = React.memo(({ node, type, measure, expandSignal, collapseSignal }: DiffNodeCardProps) => {
  const [expanded, setExpanded] = useState(false);
  const [showFullPayload, setShowFullPayload] = useState(false);
  const [copied, setCopied] = useState<'before'|'after'|null>(null);
  
  const theme = THEME_MAP[type];

  // Sync with global Expand/Collapse All buttons
  useEffect(() => { if (expandSignal > 0) setExpanded(true); }, [expandSignal]);
  useEffect(() => { if (collapseSignal > 0) setExpanded(false); }, [collapseSignal]);

  // Synchronously notify the virtualizer AFTER the DOM layout updates
  useIsomorphicLayoutEffect(() => {
    measure();
  }, [expanded, showFullPayload, measure]);

  const toggleExpand = useCallback(() => setExpanded(prev => !prev), []);
  const toggleTruncation = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowFullPayload(prev => !prev);
  }, []);

  const handleCopy = useCallback(async (text: string, copyType: 'before'|'after') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(copyType);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error("Clipboard API unavailable", err);
    }
  }, []);

  // LAZY EVALUATION: Only serialize if card is open
  const beforeStr = useMemo(() => expanded ? safeStringify(node.beforeSnapshot) : '', [expanded, node.beforeSnapshot]);
  const afterStr = useMemo(() => expanded ? safeStringify(node.afterSnapshot) : '', [expanded, node.afterSnapshot]);

  const renderPayload = useCallback((payload: string, label: string, colorClass: string, copyType: 'before'|'after') => {
    const isOversized = payload.length > MAX_PAYLOAD_CHARS;
    const displayStr = !isOversized || showFullPayload 
      ? payload 
      : payload.slice(0, MAX_PAYLOAD_CHARS) + '\n\n... [TRUNCATED - CLICK EXPAND TO VIEW FULL]';

    return (
      <div className="flex flex-col h-full min-w-0">
        <div className="text-xs text-zinc-500 mb-1 flex justify-between items-center uppercase tracking-wider">
          <span className="truncate pr-2">{label}</span>
          <div className="flex items-center gap-3 shrink-0">
            {isOversized && (
              <button 
                onClick={toggleTruncation}
                className="hover:text-zinc-300 flex items-center gap-1 transition-colors"
                aria-label={showFullPayload ? "Collapse payload" : "Expand full payload"}
              >
                {showFullPayload ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                <span className="text-[10px] hidden sm:inline">{showFullPayload ? 'COLLAPSE' : 'EXPAND'}</span>
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); handleCopy(payload, copyType); }}
              className="hover:text-zinc-300 flex items-center gap-1 transition-colors"
              title="Copy JSON"
            >
              {copied === copyType ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            </button>
          </div>
        </div>
        <pre className={`p-3 rounded-md bg-black/50 ${colorClass} overflow-x-auto custom-scrollbar text-xs flex-1 border border-white/5`}>
          {displayStr}
        </pre>
      </div>
    );
  }, [showFullPayload, copied, handleCopy, toggleTruncation]);

  return (
    <div className={`rounded-md border ${theme.border} ${theme.bg} overflow-hidden font-mono text-sm`}>
      <button 
        onClick={toggleExpand}
        aria-expanded={expanded}
        aria-label={`Toggle diff for ${node.nodeType} at ${node.path}`}
        className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition-colors text-left focus:outline-none focus:ring-1 focus:ring-zinc-600"
      >
        <div className="flex items-center gap-3 overflow-hidden pr-4">
          <div className={`p-1.5 rounded-md bg-black/40 ${theme.text} shrink-0`}>
            <theme.Icon size={16} />
          </div>
          <div className="truncate"> 
            <span className="font-bold text-zinc-200">{node.nodeType}</span>
            <span className="mx-2 text-zinc-600">@</span>
            <span className="text-zinc-400 truncate">{node.path}</span>
          </div>
        </div>
        <div className="text-zinc-500 shrink-0">
          {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </div>
      </button>

      {expanded && (
        <div className="p-3 bg-black/60 border-t border-white/5 grid grid-cols-1 xl:grid-cols-2 gap-4">
          {(type === 'DELETE' || type === 'UPDATE' || type === 'MOVE') && 
            renderPayload(beforeStr, 'Before Snapshot', 'text-rose-300/80', 'before')}
          {(type === 'INSERT' || type === 'UPDATE' || type === 'MOVE') && 
            renderPayload(afterStr, 'After Snapshot', 'text-emerald-300/80', 'after')}
        </div>
      )}
    </div>
  );
});
DiffNodeCard.displayName = 'DiffNodeCard';

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MAIN COMPONENT: HUD VIEWER (Fully Indexed & Virtualized)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

export function ASTDiffViewer({ diff, className = '' }: ASTDiffViewerProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilters, setActiveFilters] = useState<Set<OperationType>>(
    new Set(['INSERT', 'DELETE', 'UPDATE', 'MOVE'])
  );
  
  const [expandSignal, setExpandSignal] = useState(0);
  const [collapseSignal, setCollapseSignal] = useState(0);

  // Global Hotkeys for rapid SOC navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === '/' && document.activeElement !== searchInputRef.current) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // O(1) Pre-Computed Search Indexing for massive payloads
  const indexedNodes = useMemo(() => {
    const updates = diff.modifiedNodes.filter(n => n.operation === 'UPDATE');
    const moves = diff.modifiedNodes.filter(n => n.operation === 'MOVE');
    const nodes = [
      ...diff.addedNodes.map(n => ({ node: n, type: 'INSERT' as OperationType })),
      ...diff.removedNodes.map(n => ({ node: n, type: 'DELETE' as OperationType })),
      ...updates.map(n => ({ node: n, type: 'UPDATE' as OperationType })),
      ...moves.map(n => ({ node: n, type: 'MOVE' as OperationType }))
    ];
    return nodes.map(item => ({
      ...item,
      searchIndex: `${item.node.path.toLowerCase()} ${item.node.nodeType.toLowerCase()}`
    }));
  }, [diff]);

  const filteredNodes = useMemo(() => {
    const lowerSearch = searchTerm.toLowerCase();
    return indexedNodes.filter(item => {
      if (!activeFilters.has(item.type)) return false;
      if (lowerSearch && !item.searchIndex.includes(lowerSearch)) return false;
      return true;
    });
  }, [indexedNodes, searchTerm, activeFilters]);

  const virtualizer = useVirtualizer({
    count: filteredNodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 68, // Accurate baseline height calculation
    overscan: 5,
  });

  const handleMeasure = useCallback(() => {
    virtualizer.measure();
  }, [virtualizer]);

  const toggleFilter = useCallback((type: OperationType) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const handleExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(diff, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hexical-ast-diff-${diff.currentScanId || 'export'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [diff]);

  const metrics = diff.metrics || {
    nodesVisited: 0, executionTimeMs: 0,
    added: diff.addedNodes.length, removed: diff.removedNodes.length,
    modified: diff.modifiedNodes.filter(n => n.operation === 'UPDATE').length,
    moveOperations: diff.modifiedNodes.filter(n => n.operation === 'MOVE').length
  };

  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl flex flex-col ${className}`}>
      
      {/* 1. SOC TELEMETRY HEADER */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between p-4 border-b border-zinc-800 bg-zinc-900/50 gap-4 shrink-0">
        <div className="flex items-center gap-2 text-zinc-100 font-mono font-semibold tracking-tight shrink-0">
          <Activity className="text-emerald-500" size={18} />
          AST STRUCTURAL DELTA
        </div>
        
        <div className="flex flex-wrap items-center justify-end gap-3 text-xs font-mono text-zinc-400 w-full xl:w-auto">
          {/* Export Actions */}
          <button onClick={handleExport} className="flex items-center gap-1.5 bg-black/40 hover:bg-white/10 hover:text-zinc-200 px-2.5 py-1 rounded border border-zinc-800 transition-colors mr-2">
            <Download size={14} /> Export JSON
          </button>
          
          <div className="h-4 w-px bg-zinc-700 hidden md:block" />

          {/* Performance Telemetry */}
          <div className="flex items-center gap-1.5 bg-black/40 px-2.5 py-1 rounded border border-zinc-800">
            <Clock size={14} className="text-zinc-500" />
            {metrics.executionTimeMs.toFixed(2)}ms
          </div>
          <div className="flex items-center gap-1.5 bg-black/40 px-2.5 py-1 rounded border border-zinc-800">
            <Activity size={14} className="text-zinc-500" />
            {metrics.nodesVisited.toLocaleString()} nodes
          </div>
          
          {diff.riskChanged && (
            <div className="flex items-center gap-1.5 bg-rose-500/10 text-rose-400 px-2.5 py-1 rounded border border-rose-500/20 animate-pulse">
              <ShieldAlert size={14} />
              RISK SHIFT
            </div>
          )}
        </div>
      </div>

      {/* 2. SEARCH & FILTER TOOLBAR */}
      {diff.hasChanges && (
        <div className="flex flex-col lg:flex-row items-center justify-between gap-4 p-3 border-b border-zinc-800 bg-zinc-900/20 shrink-0">
          
          <div className="flex items-center gap-4 w-full lg:w-auto">
            <div className="relative flex-1 lg:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={14} />
              <input 
                ref={searchInputRef}
                type="text"
                placeholder="Search paths or types (Ctrl+F)"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-black/50 border border-zinc-800 rounded-md py-1.5 pl-9 pr-3 text-sm font-mono text-zinc-200 focus:outline-none focus:border-zinc-600 placeholder:text-zinc-600 transition-colors"
              />
            </div>
            
            <div className="flex items-center gap-2 font-mono text-xs overflow-x-auto custom-scrollbar shrink-0">
              <Filter size={14} className="text-zinc-500 mr-1" />
              {(['INSERT', 'DELETE', 'UPDATE', 'MOVE'] as OperationType[]).map(type => {
                const isActive = activeFilters.has(type);
                const theme = THEME_MAP[type];
                const count = type === 'INSERT' ? metrics.added : type === 'DELETE' ? metrics.removed : type === 'UPDATE' ? metrics.modified : metrics.moveOperations;
                return (
                  <button
                    key={type}
                    onClick={() => toggleFilter(type)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded border transition-colors ${
                      isActive ? `${theme.bg} ${theme.border} ${theme.text}` : 'bg-black/40 border-zinc-800 text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <theme.Icon size={12} /> {count}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2 w-full lg:w-auto justify-end">
            <button onClick={() => setExpandSignal(s => s + 1)} className="flex items-center gap-1 text-xs font-mono text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded bg-black/30 border border-zinc-800 transition-colors">
              <ChevronsUpDown size={14} /> Expand All
            </button>
            <button onClick={() => setCollapseSignal(s => s + 1)} className="flex items-center gap-1 text-xs font-mono text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded bg-black/30 border border-zinc-800 transition-colors">
              <ChevronsDownUp size={14} /> Collapse All
            </button>
          </div>
          
        </div>
      )}

      {/* 3. VIRTUALIZED VIEWPORT */}
      <div 
        ref={parentRef} 
        className="p-4 flex-1 overflow-y-auto custom-scrollbar" 
        style={{ minHeight: '300px', maxHeight: '70vh' }}
      >
        {!diff.hasChanges ? (
          <div className="flex flex-col items-center justify-center py-16 text-zinc-500 font-mono h-full">
            <CheckCircle2 size={48} className="mb-4 text-emerald-500/30" />
            <p className="text-lg text-emerald-400/80 tracking-widest">NO ANOMALIES DETECTED</p>
            <p className="text-xs mt-2 text-zinc-600">Execution graphs are structurally identical.</p>
          </div>
        ) : filteredNodes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-zinc-500 font-mono h-full">
            <p>No nodes match current filters.</p>
          </div>
        ) : (
          <div 
            style={{ 
              height: `${virtualizer.getTotalSize()}px`, 
              width: '100%', 
              position: 'relative' 
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = filteredNodes[virtualItem.index];
              const key = `${item.type}-${item.node.path}-${virtualItem.index}`;
              
              return (
                <div
                  key={key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                  className="pb-3"
                >
                  <DiffNodeCard 
                    node={item.node} 
                    type={item.type} 
                    measure={handleMeasure}
                    expandSignal={expandSignal}
                    collapseSignal={collapseSignal}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}