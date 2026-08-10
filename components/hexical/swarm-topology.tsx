'use client'

import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Terminal, Shield, Crosshair, Network, Sparkles, MessageSquare, Flame, CheckCircle2 } from 'lucide-react'
import React, { useEffect, useState } from 'react'
import type { AgentRoleType, DebateRound, ConsensusVote } from '@/lib/hexical/types'

interface SwarmTopologyProps {
  activeAgent?: AgentRoleType
  debateRounds?: DebateRound[]
  votes?: ConsensusVote[]
  isExecuting?: boolean
}

interface NodeConfig {
  id: AgentRoleType
  label: string
  icon: React.ComponentType<{ className?: string; size?: number }>
  colorClass: string
  glowClass: string
  x: number // Percent across container
  y: number // Percent down container
}

interface AgentPath {
  from: AgentRoleType
  to: AgentRoleType
  isDebateLine?: boolean
}

// Partial<Record<...>> instead of Record<string, ...>: gives real key-checking
// against AgentRoleType without forcing every possible role to have a node
// (new roles added to the type elsewhere won't break this file).
const AGENT_NODES: Partial<Record<AgentRoleType, NodeConfig>> = {
  coordinator: {
    id: 'coordinator',
    label: 'Coordinator',
    icon: Network,
    colorClass: 'border-cyan-500 text-cyan-400 bg-cyan-950/30',
    glowClass: 'shadow-[0_0_25px_rgba(6,182,212,0.3)]',
    x: 50,
    y: 50,
  },
  planner: {
    id: 'planner',
    label: 'Swarm Planner',
    icon: Sparkles,
    colorClass: 'border-purple-500 text-purple-400 bg-purple-950/30',
    glowClass: 'shadow-[0_0_25px_rgba(168,85,247,0.2)]',
    x: 50,
    y: 15,
  },
  red_team_exploit: {
    id: 'red_team_exploit',
    label: 'Adversarial Review',
    icon: Crosshair,
    colorClass: 'border-red-500 text-red-400 bg-red-950/30',
    glowClass: 'shadow-[0_0_25px_rgba(239,68,68,0.3)]',
    x: 15,
    y: 50,
  },
  blue_team_defense: {
    id: 'blue_team_defense',
    label: 'Safeguard Review',
    icon: Shield,
    colorClass: 'border-emerald-500 text-emerald-400 bg-emerald-950/30',
    glowClass: 'shadow-[0_0_25px_rgba(16,185,129,0.3)]',
    x: 85,
    y: 50,
  },
  consensus_engine: {
    id: 'consensus_engine',
    label: 'Consensus Engine',
    icon: Terminal,
    colorClass: 'border-amber-500 text-amber-400 bg-amber-950/30',
    glowClass: 'shadow-[0_0_25px_rgba(245,158,11,0.2)]',
    x: 50,
    y: 85,
  },
}

// Explicitly typed so TS won't complain when `isDebateLine` is read on entries
// that don't declare it (the bare-literal array previously did this).
const PATHS: AgentPath[] = [
  { from: 'planner', to: 'coordinator' },
  { from: 'red_team_exploit', to: 'coordinator' },
  { from: 'blue_team_defense', to: 'coordinator' },
  { from: 'consensus_engine', to: 'coordinator' },
  { from: 'red_team_exploit', to: 'blue_team_defense', isDebateLine: true },
]

function formatTimestamp(ms: number | undefined): string {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '--:--:--'
  try {
    return new Date(ms).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return '--:--:--'
  }
}

export default function SwarmTopology({
  activeAgent,
  debateRounds = [],
  votes = [],
  isExecuting = false,
}: SwarmTopologyProps) {
  const [selectedNode, setSelectedNode] = useState<AgentRoleType | null>(null)
  const [pulsePaths, setPulsePaths] = useState<Set<string>>(new Set())
  const prefersReducedMotion = useReducedMotion()

  // Pulse every edge touching the active agent (not just the first match),
  // and always clear state on cleanup so a stale pulse can't survive an
  // interrupted transition or an agent that drops out mid-cycle.
  useEffect(() => {
    if (!isExecuting || !activeAgent) {
      setPulsePaths(new Set())
      return
    }

    const matched = PATHS.filter((p) => p.from === activeAgent || p.to === activeAgent)
    if (matched.length === 0) return

    setPulsePaths(new Set(matched.map((p) => `${p.from}-${p.to}`)))
    const timer = setTimeout(() => setPulsePaths(new Set()), 1000)
    return () => clearTimeout(timer)
  }, [activeAgent, isExecuting])

  const nodeList = Object.values(AGENT_NODES).filter((n): n is NodeConfig => Boolean(n))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 w-full min-h-[500px] bg-[#0b0b0e] border border-white/5 rounded-2xl p-6 overflow-hidden">
      {/* ===================================================================
          LEFT/CENTER: THE ARCHITECTURAL NETWORK MESH GRAPH
          =================================================================== */}
      <div
        className="lg:col-span-2 relative min-h-[400px] border border-white/5 rounded-xl bg-black/40 flex items-center justify-center p-4"
        role="group"
        aria-label="Swarm agent topology graph"
      >
        {/* Decorative connection lines — the buttons below carry the real semantics */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">
          {PATHS.map((path) => {
            const fromNode = AGENT_NODES[path.from]
            const toNode = AGENT_NODES[path.to]
            if (!fromNode || !toNode) return null

            const pathKey = `${path.from}-${path.to}`
            const isPulseActive = pulsePaths.has(pathKey)
            const strokeColor = path.isDebateLine ? '#a855f7' : 'rgba(255,255,255,0.06)'
            const strokeDash = path.isDebateLine ? '4,4' : 'none'

            return (
              <g key={pathKey}>
                {/* Base structural network line */}
                <line
                  x1={`${fromNode.x}%`}
                  y1={`${fromNode.y}%`}
                  x2={`${toNode.x}%`}
                  y2={`${toNode.y}%`}
                  stroke={strokeColor}
                  strokeWidth={path.isDebateLine ? 2 : 1}
                  strokeDasharray={strokeDash}
                />

                {/* Overlay glow when this edge is carrying traffic */}
                {isPulseActive &&
                  (prefersReducedMotion ? (
                    // Static highlight instead of a looping animation for
                    // users who've asked the OS for reduced motion.
                    <line
                      x1={`${fromNode.x}%`}
                      y1={`${fromNode.y}%`}
                      x2={`${toNode.x}%`}
                      y2={`${toNode.y}%`}
                      stroke={path.isDebateLine ? '#a855f7' : '#22d3ee'}
                      strokeWidth={2.5}
                    />
                  ) : (
                    // Numeric strokeDashoffset animation — reliably
                    // interpolated by Framer Motion, unlike animating
                    // strokeDasharray strings directly.
                    <motion.line
                      x1={`${fromNode.x}%`}
                      y1={`${fromNode.y}%`}
                      x2={`${toNode.x}%`}
                      y2={`${toNode.y}%`}
                      stroke={path.isDebateLine ? '#a855f7' : '#22d3ee'}
                      strokeWidth={2}
                      strokeDasharray="8 6"
                      initial={{ strokeDashoffset: 0 }}
                      animate={{ strokeDashoffset: -56 }}
                      transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                    />
                  ))}
              </g>
            )
          })}
        </svg>

        {/* Nodes */}
        {nodeList.map((node) => {
          const NodeIcon = node.icon
          const isActive = activeAgent === node.id
          const isSelected = selectedNode === node.id

          return (
            <button
              key={node.id}
              type="button"
              onClick={() => setSelectedNode(isSelected ? null : node.id)}
              aria-pressed={isSelected}
              aria-label={`${node.label}${isActive ? ' — currently active' : ''}`}
              style={{ left: `${node.x}%`, top: `${node.y}%`, transform: 'translate(-50%, -50%)' }}
              className="absolute flex flex-col items-center gap-2 group z-20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 rounded-xl"
            >
              <div
                className={`w-14 h-14 rounded-xl border flex items-center justify-center transition-all duration-300 backdrop-blur-md ${
                  node.colorClass
                } ${isSelected ? 'scale-110 border-white ring-2 ring-white/10' : ''} ${
                  isActive
                    ? `${node.glowClass} scale-105 border-white ${prefersReducedMotion ? '' : 'animate-pulse'}`
                    : 'group-hover:border-white/20'
                }`}
              >
                <NodeIcon size={24} className={isActive ? 'scale-110' : ''} />
              </div>

              <span
                className={`text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-md transition-all ${
                  isActive
                    ? 'bg-white text-black font-extrabold shadow-md'
                    : 'text-muted-foreground bg-[#111116] border border-white/5'
                }`}
              >
                {node.label}
              </span>
            </button>
          )
        })}
      </div>

      {/* ===================================================================
          RIGHT: DEBATE STREAM LOGS
          =================================================================== */}
      <div className="border border-white/5 bg-black/20 rounded-xl p-4 flex flex-col max-h-[450px] overflow-hidden">
        <div className="flex items-center gap-2 pb-3 border-b border-white/5 mb-3 shrink-0">
          <MessageSquare size={16} className="text-amber-500" />
          <h4 className="text-xs font-bold text-white uppercase tracking-widest">Swarm Ledger Analytics</h4>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 scrollbar-thin pr-1" role="log" aria-live="polite">
          <AnimatePresence mode="popLayout">
            {selectedNode ? (
              <motion.div
                key="inspector"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-3 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white capitalize">{selectedNode.replace(/_/g, ' ')}</span>
                  <button
                    type="button"
                    onClick={() => setSelectedNode(null)}
                    className="text-[10px] text-muted-foreground hover:text-white underline"
                  >
                    Back to Feed
                  </button>
                </div>
                <div className="bg-[#111116] border border-white/5 rounded-lg p-3 text-muted-foreground space-y-2">
                  <p>
                    <strong>System Context:</strong> Engineering goal review and evidence synthesis.
                  </p>
                  <p>
                    <strong>Status:</strong>{' '}
                    {activeAgent === selectedNode ? '🔴 Streaming Token Matrix...' : '🟢 Awaiting Thread Invocation'}
                  </p>
                </div>
              </motion.div>
            ) : debateRounds.length === 0 ? (
              <motion.div
                key="empty"
                className="h-full flex flex-col items-center justify-center text-center py-12 text-muted-foreground"
              >
                <Flame size={24} className={`text-white/10 mb-2 ${prefersReducedMotion ? '' : 'animate-bounce'}`} />
                <p className="text-xs font-medium">No live swarm graph processes active.</p>
                <p className="text-[10px] text-white/40 max-w-[200px] mt-1">
                  Run an Engineering Swarm review to stream backend-reported agent evidence.
                </p>
              </motion.div>
            ) : (
              debateRounds.map((round, idx) => {
                const evidenceIds = round.evidenceASTNodeIds ?? []
                return (
                  <motion.div
                    key={`round-${round.roundNumber}-${round.timestampMs}-${idx}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-[#111116] border border-white/5 rounded-lg p-3 space-y-2 text-xs relative overflow-hidden"
                  >
                    <div className="flex items-center justify-between border-b border-white/[0.03] pb-1">
                      <span
                        className={`font-bold uppercase tracking-wider text-[10px] ${
                          round.proposingAgentRole === 'red_team_exploit' ? 'text-red-400' : 'text-emerald-400'
                        }`}
                      >
                        Round {round.roundNumber}:{' '}
                        {round.proposingAgentRole === 'red_team_exploit' ? 'Issue hypothesis' : 'Safeguard proposal'}
                      </span>
                      <span className="text-[9px] text-white/30">{formatTimestamp(round.timestampMs)}</span>
                    </div>
                    <p className="text-foreground/90 leading-relaxed font-sans">{round.argument}</p>
                    {evidenceIds.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {evidenceIds.map((nodeId) => (
                          <span
                            key={nodeId}
                            className="bg-white/5 border border-white/5 px-1.5 py-0.5 rounded text-[9px] font-mono text-cyan-400"
                          >
                            AST_Node::{nodeId.slice(0, 6)}
                          </span>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )
              })
            )}
          </AnimatePresence>
        </div>

        {votes.length > 0 && (
          <div className="mt-3 pt-3 border-t border-white/5 shrink-0 bg-black/40 p-2 rounded-lg">
            <div className="flex items-center gap-1.5 text-[10px] text-white font-bold tracking-widest uppercase mb-1.5">
              <CheckCircle2 size={12} className="text-amber-500" /> Consensus Status Matrix
            </div>
            <div className="flex gap-1">
              {votes.map((v, i) => (
                <div
                  key={`${v.role}-${i}`}
                  title={`${v.role}: ${v.vote}`}
                  className={`h-2 flex-1 rounded-sm transition-colors ${
                    v.vote === 'VULNERABLE'
                      ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'
                      : v.vote === 'SECURE'
                      ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
                      : 'bg-white/10'
                  }`}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
