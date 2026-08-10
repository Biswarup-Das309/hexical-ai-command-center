'use client'

import { Play, Square } from 'lucide-react'

interface SwarmSimulatorControlProps {
  isSimulating: boolean
  onStart: () => void
  onStop: () => void
}

export default function SwarmSimulatorControl({ isSimulating, onStart, onStop }: SwarmSimulatorControlProps) {
  return (
    <div className="flex items-center justify-between gap-4 border border-white/5 bg-black/20 rounded-xl p-4">
      <div>
        <h4 className="text-xs font-bold text-white uppercase tracking-widest">Simulation Engine</h4>
        <p className="text-[10px] text-white/40 mt-1">Stress-test local topology animations and vector rendering.</p>
      </div>

      <button
        type="button"
        onClick={isSimulating ? onStop : onStart}
        aria-pressed={isSimulating}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-xs font-bold uppercase tracking-widest transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
          isSimulating
            ? 'border-red-500/50 bg-red-950/30 text-red-400 hover:bg-red-950/50'
            : 'border-emerald-500/50 bg-emerald-950/30 text-emerald-400 hover:bg-emerald-950/50'
        }`}
      >
        {isSimulating ? <Square size={14} /> : <Play size={14} />}
        {isSimulating ? 'Executing Swarm...' : 'Run Simulation'}
      </button>
    </div>
  )
}
