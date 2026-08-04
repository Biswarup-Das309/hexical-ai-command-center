import { Network } from 'lucide-react';

export type AccentTheme = 'cyan' | 'emerald' | 'rose' | 'violet' | 'amber';

const THEME_MAP: Record<AccentTheme, { text: string }> = {
  cyan: { text: 'text-cyan-400' },
  emerald: { text: 'text-emerald-400' },
  rose: { text: 'text-rose-400' },
  violet: { text: 'text-violet-400' },
  amber: { text: 'text-amber-400' }
};

export const ReconDashboard = ({ targets, theme }: { targets: string[]; theme: AccentTheme }) => {
  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col bg-[#0a0a0c] overflow-y-auto">
      <div className="flex items-center gap-3 mb-6">
        <Network className={`size-6 ${THEME_MAP[theme].text}`} />
        <div>
          <h2 className="text-2xl font-medium text-white tracking-tight">Repository Intelligence</h2>
          <p className="text-sm text-zinc-400 max-w-xl">Project context, extracted references, and investigation scope for the current session.</p>
        </div>
      </div>
      
      <div className="grid gap-6 xl:grid-cols-[1.4fr_0.6fr]">
        <div className="bg-[#111116] border border-white/10 rounded-2xl p-6 shadow-inner">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-zinc-500 font-semibold">Extracted context</p>
              <h3 className="text-xl font-semibold text-white mt-2">{targets.length} references</h3>
            </div>
            <span className={`text-[10px] uppercase tracking-widest font-bold ${THEME_MAP[theme].text}`}>
              Session context
            </span>
          </div>
          <div className="space-y-3">
            {targets.length > 0 ? targets.map((target, index) => (
              <div key={index} className="rounded-2xl border border-white/5 bg-white/5 p-3 text-sm text-zinc-200 flex items-center justify-between">
                <span>{target}</span>
                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">auto-parsed</span>
              </div>
            )) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-6 text-sm text-zinc-500 text-center">
                No project references have been extracted from the current engineering goal yet.
              </div>
            )}
          </div>
        </div>
        
        <div className="space-y-6">
          <div className="bg-[#111116] border border-white/10 rounded-2xl p-6 shadow-inner">
            <p className="text-xs uppercase tracking-widest text-zinc-500 font-semibold mb-3">Overview Metrics</p>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-2xl bg-white/5 p-3">
                <p className="text-zinc-400 text-[10px] uppercase tracking-widest mb-2">Scope Confidence</p>
                <p className="text-white text-lg font-semibold">89%</p>
              </div>
              <div className="rounded-2xl bg-white/5 p-3">
                <p className="text-zinc-400 text-[10px] uppercase tracking-widest mb-2">Enumeration Rate</p>
                <p className="text-white text-lg font-semibold">{targets.length > 0 ? `${targets.length * 12}%` : '0%'}</p>
              </div>
              <div className="rounded-2xl bg-white/5 p-3">
                <p className="text-zinc-400 text-[10px] uppercase tracking-widest mb-2">Asset Density</p>
                <p className="text-white text-lg font-semibold">{targets.length > 3 ? 'High' : targets.length > 0 ? 'Moderate' : 'Low'}</p>
              </div>
              <div className="rounded-2xl bg-white/5 p-3">
                <p className="text-zinc-400 text-[10px] uppercase tracking-widest mb-2">Risk Vector</p>
                <p className="text-white text-lg font-semibold">{targets.length > 0 ? 'External' : 'Unknown'}</p>
              </div>
            </div>
          </div>
          
          <div className="bg-[#111116] border border-white/10 rounded-2xl p-6 shadow-inner">
            <p className="text-xs uppercase tracking-widest text-zinc-500 font-semibold mb-3">Session Notes</p>
            <ul className="space-y-2 text-sm text-zinc-300">
              <li className="rounded-2xl bg-white/5 p-3">Use <span className="text-white">Code</span> to inspect submitted source context.</li>
              <li className="rounded-2xl bg-white/5 p-3">Use <span className="text-white">Impact</span> when a result includes a graph.</li>
              <li className="rounded-2xl bg-white/5 p-3">Open <span className="text-white">Trace Logs</span> to inspect returned evidence.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};
