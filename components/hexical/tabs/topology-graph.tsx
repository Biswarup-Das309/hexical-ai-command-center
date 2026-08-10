'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  MiniMap,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Workflow, Globe, GitMerge, Bug, Target, Shield, X, Download } from 'lucide-react'

// ELITE FIX 1: Decoupled Type to prevent broken imports across your file tree
export type AccentTheme = 'cyan' | 'emerald' | 'rose' | 'violet' | 'amber'

// --- 1. THE CUSTOM "THREAT NODE" COMPONENT ---
const ThreatNode = ({ data }: { data: any }) => {
  const isEntry = data.type === 'entry'
  const isVuln = data.type === 'vuln'
  const isPivot = data.type === 'pivot'

  const config = isEntry
    ? {
        icon: Globe,
        color: 'text-blue-400',
        bg: 'bg-blue-500/10',
        border: 'border-blue-500/30',
        glow: 'shadow-blue-900/20',
      }
    : isVuln
    ? {
        icon: Bug,
        color: 'text-rose-400',
        bg: 'bg-rose-500/10',
        border: 'border-rose-500/30',
        glow: 'shadow-rose-900/20',
      }
    : isPivot
    ? {
        icon: GitMerge,
        color: 'text-amber-400',
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/30',
        glow: 'shadow-amber-900/20',
      }
    : {
        icon: Target,
        color: 'text-emerald-400',
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/30',
        glow: 'shadow-emerald-900/20',
      }

  const Icon = config.icon

  return (
    <div
      className={`relative px-4 py-3 rounded-xl border backdrop-blur-md shadow-xl transition-all duration-300 hover:scale-105 min-w-[160px] ${config.bg} ${config.border} ${config.glow}`}
    >
      {!isEntry && (
        <Handle type="target" position={Position.Left} className="!bg-zinc-500 !w-2 !h-4 !rounded-sm !border-none" />
      )}

      <div className="flex flex-col items-center justify-center gap-2">
        <div className={`p-2 rounded-lg bg-black/40 border border-white/5 ${config.color}`}>
          <Icon size={18} />
        </div>
        <div className="text-center">
          <div className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-0.5">{data.type}</div>
          <div className="text-xs font-mono font-bold text-white leading-tight">{data.label}</div>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className={`!w-2 !h-4 !rounded-sm !border-none ${isVuln ? '!bg-rose-500 animate-pulse' : '!bg-zinc-500'}`}
      />
    </div>
  )
}

const nodeTypes = { threatNode: ThreatNode }

// --- 2. THE MAIN TOPOLOGY COMPONENT ---
export const AttackGraphVisualizer = ({ graph, theme }: { graph: any; theme: AccentTheme }) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selectedNode, setSelectedNode] = useState<any | null>(null)

  const lastGraphDataSignature = useRef<string>('')

  useEffect(() => {
    if (!graph || !graph.nodes || graph.nodes.length === 0) return

    const currentSignature = JSON.stringify({ nodes: graph.nodes, edges: graph.edges })
    if (lastGraphDataSignature.current === currentSignature) return
    lastGraphDataSignature.current = currentSignature

    const formattedNodes = graph.nodes.map((n: any) => ({
      id: n.id,
      type: 'threatNode',
      position: { x: n.x, y: n.y },
      data: {
        label: n.label,
        type: n.type,
        mitigation:
          n.type === 'vuln'
            ? 'Implement strict input sanitization and parameterized queries.'
            : n.type === 'entry'
            ? 'Review WAF rules and rate-limiting policies at the gateway.'
            : 'Enforce Zero-Trust RBAC network segmentation.',
      },
    }))

    const formattedEdges = graph.edges.map((e: any, i: number) => ({
      id: `e${i}-${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: true,
      style: { stroke: 'rgba(255,255,255,0.4)', strokeWidth: 2 },
      labelStyle: { fill: 'rgba(255,255,255,0.9)', fontWeight: 'bold', fontSize: 10, fontFamily: 'monospace' },
      labelBgStyle: { fill: '#111116', fillOpacity: 0.9, rx: 4, ry: 4 },
      labelBgPadding: [8, 4],
      markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(255,255,255,0.4)' },
    }))

    setNodes(formattedNodes)
    setEdges(formattedEdges)
  }, [graph, setNodes, setEdges])

  const onNodeClick = useCallback((event: any, node: any) => {
    setSelectedNode(node)
  }, [])

  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    return (
      <div className="w-full h-full min-h-[500px] flex-1 p-6 flex flex-col bg-[#0a0a0c]">
        <div className="flex items-center gap-3 mb-6">
          <Workflow className="size-6 text-zinc-500" />
          <h2 className="text-2xl font-medium text-white tracking-tight">Change Impact Map</h2>
        </div>
        <div className="flex-1 border border-dashed border-white/10 rounded-2xl bg-[#111116]/50 flex flex-col items-center justify-center text-center shadow-inner min-h-[400px]">
          <Workflow className="size-12 text-zinc-700 opacity-50 mb-4" />
          <h3 className="text-zinc-300 font-mono text-sm uppercase tracking-widest font-bold mb-2">
            Awaiting Architecture Data
          </h3>
          <p className="text-zinc-500 font-mono text-xs max-w-sm leading-relaxed">
            Run an investigation that returns project-relationship data to populate this impact map.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full h-full min-h-[500px] flex-1 p-4 md:p-6 flex flex-col bg-[#0a0a0c] relative">
      <div className="flex items-center justify-between mb-6 shrink-0 z-10">
        <div className="flex items-center gap-3">
          <Workflow className="size-6 text-emerald-400" />
          <h2 className="text-2xl font-sans font-medium text-white tracking-tight">Change Impact Map</h2>
        </div>
        <div className="flex gap-2">
          <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded border border-emerald-500/20 flex items-center gap-2">
            <div className="size-2 bg-emerald-500 rounded-full animate-pulse"></div> Returned analysis
          </span>
          <button className="text-[10px] font-mono font-bold uppercase tracking-widest text-zinc-400 bg-white/5 hover:bg-white/10 hover:text-white px-3 py-1.5 rounded border border-white/10 transition-all flex items-center gap-2">
            <Download size={12} /> Export
          </button>
        </div>
      </div>

      {/* ELITE FIX 2: Absolute constraint wrapper ensures the Canvas is forced to render dimensions */}
      <div className="w-full relative flex-1 min-h-[450px] border border-white/10 rounded-2xl bg-[#111116] overflow-hidden shadow-inner">
        {/* Anchored rigidly to all 4 corners of the relative parent */}
        <div className="absolute inset-0">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            fitView
            minZoom={0.2}
            maxZoom={1.5}
            attributionPosition="bottom-right"
          >
            <Background color="#fff" gap={24} size={1} style={{ opacity: 0.02 }} />
            <Controls className="!bg-black/80 !border-white/10 !fill-white !rounded-lg overflow-hidden shadow-2xl" />
            <MiniMap
              className="!bg-black/80 !border-white/10 !rounded-lg shadow-2xl"
              maskColor="rgba(255,255,255,0.1)"
              nodeColor={(n) => (n.data.type === 'vuln' ? '#f43f5e' : '#3b82f6')}
            />
          </ReactFlow>
        </div>

        <div
          className={`absolute top-4 right-4 bottom-4 w-72 bg-black/90 backdrop-blur-xl border border-white/10 rounded-xl shadow-[0_0_50px_rgba(0,0,0,0.5)] transition-transform duration-300 flex flex-col overflow-hidden z-20 ${
            selectedNode ? 'translate-x-0' : 'translate-x-[120%]'
          }`}
        >
          {selectedNode && (
            <>
              <div className="p-4 border-b border-white/10 flex justify-between items-center bg-white/[0.02]">
                <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Node Inspector</h3>
                <button
                  onClick={() => setSelectedNode(null)}
                  className="text-zinc-500 hover:text-white transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="p-5 flex-1 overflow-y-auto">
                <div className="mb-6">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Entity Name</div>
                  <div className="text-lg font-mono text-white font-bold break-words">{selectedNode.data.label}</div>
                </div>

                <div className="mb-6">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-2">
                    Classification
                  </div>
                  <span
                    className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider border ${
                      selectedNode.data.type === 'vuln'
                        ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                        : 'bg-blue-500/10 text-blue-400 border-blue-500/30'
                    }`}
                  >
                    {selectedNode.data.type}
                  </span>
                </div>

                <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                  <div className="text-[10px] text-emerald-400 uppercase tracking-widest font-bold mb-2 flex items-center gap-1.5">
                    <Shield size={12} /> Recommended Action
                  </div>
                  <p className="text-xs text-zinc-300 leading-relaxed font-sans">{selectedNode.data.mitigation}</p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
