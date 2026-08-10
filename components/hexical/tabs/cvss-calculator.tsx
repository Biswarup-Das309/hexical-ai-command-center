import { Hash, Copy, Check } from 'lucide-react'
import { useState, useMemo, useCallback } from 'react'

// --- TYPES ---
export type AccentTheme = 'cyan' | 'emerald' | 'rose' | 'violet' | 'amber'
type MetricValue = { id: string; label: string; weight: number; desc: string }
type CVSSMetrics = {
  AV: MetricValue[]
  AC: MetricValue[]
  PR: MetricValue[]
  UI: MetricValue[]
  S: MetricValue[]
  C: MetricValue[]
  I: MetricValue[]
  A: MetricValue[]
}

// --- CONSTANTS ---
const THEME_MAP: Record<AccentTheme, { border: string; text: string; bg: string }> = {
  cyan: { border: 'border-cyan-500/20', text: 'text-cyan-400', bg: 'bg-cyan-500/10' },
  emerald: { border: 'border-emerald-500/20', text: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  rose: { border: 'border-rose-500/20', text: 'text-rose-400', bg: 'bg-rose-500/10' },
  violet: { border: 'border-violet-500/20', text: 'text-violet-400', bg: 'bg-violet-500/10' },
  amber: { border: 'border-amber-500/20', text: 'text-amber-400', bg: 'bg-amber-500/10' },
}

const CVSS_DEF: CVSSMetrics = {
  AV: [
    { id: 'N', label: 'Network', weight: 0.85, desc: 'Exploitable remotely' },
    { id: 'A', label: 'Adjacent', weight: 0.62, desc: 'Local network only' },
    { id: 'L', label: 'Local', weight: 0.55, desc: 'Requires OS access' },
    { id: 'P', label: 'Physical', weight: 0.2, desc: 'Requires physical access' },
  ],
  AC: [
    { id: 'L', label: 'Low', weight: 0.77, desc: 'No special conditions' },
    { id: 'H', label: 'High', weight: 0.44, desc: 'Requires specific conditions' },
  ],
  PR: [
    { id: 'N', label: 'None', weight: 0.85, desc: 'No auth required' },
    { id: 'L', label: 'Low', weight: 0.62, desc: 'Basic user access' },
    { id: 'H', label: 'High', weight: 0.27, desc: 'Admin access required' },
  ],
  UI: [
    { id: 'N', label: 'None', weight: 0.85, desc: 'No user interaction' },
    { id: 'R', label: 'Required', weight: 0.62, desc: 'Requires victim action' },
  ],
  S: [
    { id: 'U', label: 'Unchanged', weight: 0.0, desc: 'Only impacts vulnerable component' },
    { id: 'C', label: 'Changed', weight: 0.0, desc: 'Impacts other components' },
  ],
  C: [
    { id: 'H', label: 'High', weight: 0.56, desc: 'Total info disclosure' },
    { id: 'L', label: 'Low', weight: 0.22, desc: 'Partial disclosure' },
    { id: 'N', label: 'None', weight: 0.0, desc: 'No loss' },
  ],
  I: [
    { id: 'H', label: 'High', weight: 0.56, desc: 'Total compromise' },
    { id: 'L', label: 'Low', weight: 0.22, desc: 'Partial modification' },
    { id: 'N', label: 'None', weight: 0.0, desc: 'No loss' },
  ],
  A: [
    { id: 'H', label: 'High', weight: 0.56, desc: 'Total DoS' },
    { id: 'L', label: 'Low', weight: 0.22, desc: 'Partial DoS' },
    { id: 'N', label: 'None', weight: 0.0, desc: 'No loss' },
  ],
}

export const CVSSCalculator = ({ theme }: { theme: AccentTheme }) => {
  const [vector, setVector] = useState<Record<string, string>>({
    AV: 'N',
    AC: 'L',
    PR: 'N',
    UI: 'N',
    S: 'U',
    C: 'H',
    I: 'H',
    A: 'H',
  })

  const [copied, setCopied] = useState(false)

  // Devil's Advocate Optimization: useMemo prevents recalculating on every render tick
  const score = useMemo(() => {
    const iss =
      1 -
      (1 - (CVSS_DEF.C.find((v) => v.id === vector.C)?.weight || 0)) *
        (1 - (CVSS_DEF.I.find((v) => v.id === vector.I)?.weight || 0)) *
        (1 - (CVSS_DEF.A.find((v) => v.id === vector.A)?.weight || 0))

    const impact = vector.S === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)

    let prWeight = CVSS_DEF.PR.find((v) => v.id === vector.PR)?.weight || 0
    if (vector.S === 'C' && vector.PR === 'L') prWeight = 0.68
    if (vector.S === 'C' && vector.PR === 'H') prWeight = 0.5

    const expl =
      8.22 *
      (CVSS_DEF.AV.find((v) => v.id === vector.AV)?.weight || 0) *
      (CVSS_DEF.AC.find((v) => v.id === vector.AC)?.weight || 0) *
      prWeight *
      (CVSS_DEF.UI.find((v) => v.id === vector.UI)?.weight || 0)

    if (impact <= 0) return 0.0

    const base = vector.S === 'U' ? Math.min(impact + expl, 10) : Math.min(1.08 * (impact + expl), 10)

    return Math.ceil(base * 10) / 10
  }, [vector])

  const severity =
    score === 0 ? 'NONE' : score < 4.0 ? 'LOW' : score < 7.0 ? 'MEDIUM' : score < 9.0 ? 'HIGH' : 'CRITICAL'

  const sevColor =
    severity === 'CRITICAL'
      ? 'text-rose-500'
      : severity === 'HIGH'
      ? 'text-amber-500'
      : severity === 'MEDIUM'
      ? 'text-yellow-400'
      : 'text-emerald-500'

  const vectorString = `CVSS:3.1/${Object.entries(vector)
    .map(([k, v]) => `${k}:${v}`)
    .join('/')}`

  // Devil's Advocate Optimization: Actual clipboard logic
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(vectorString)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [vectorString])

  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col font-sans bg-[#0a0a0c] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-4">
        <div className="flex items-center gap-3">
          <Hash className={`size-6 ${THEME_MAP[theme].text}`} />
          <h2 className="text-2xl font-medium text-white tracking-tight">CVSS 3.1 Calculator</h2>
        </div>

        <div
          className={`flex items-center gap-4 px-6 py-3 rounded-2xl border ${THEME_MAP[theme].border} bg-black/50 shadow-2xl`}
        >
          <div className="flex flex-col items-end">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">Base Score</span>
            <span className={`text-3xl font-bold font-mono ${sevColor}`}>{score.toFixed(1)}</span>
          </div>
          <div className={`h-10 w-px bg-white/10`}></div>
          <div
            className={`px-3 py-1 rounded text-xs font-bold tracking-widest ${sevColor} bg-white/5 border border-current`}
          >
            {severity}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        <div className="space-y-6">
          <h3 className="text-sm uppercase tracking-widest text-zinc-500 font-bold border-b border-white/5 pb-2">
            Exploitability Metrics
          </h3>
          {['AV', 'AC', 'PR', 'UI'].map((metric) => (
            <div key={metric} className="space-y-2">
              <label className="text-xs font-semibold text-zinc-300">
                {metric === 'AV'
                  ? 'Attack Vector'
                  : metric === 'AC'
                  ? 'Attack Complexity'
                  : metric === 'PR'
                  ? 'Privileges Required'
                  : 'User Interaction'}
              </label>
              <div className="flex flex-wrap gap-2">
                {CVSS_DEF[metric as keyof CVSSMetrics].map((val) => (
                  <button
                    key={val.id}
                    onClick={() => setVector((p) => ({ ...p, [metric]: val.id }))}
                    title={val.desc}
                    className={`flex-1 min-w-[80px] px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                      vector[metric] === val.id
                        ? `${THEME_MAP[theme].bg} ${THEME_MAP[theme].text} border ${THEME_MAP[theme].border}`
                        : 'bg-[#111116] text-zinc-500 border border-white/5 hover:bg-white/5 hover:text-zinc-300'
                    }`}
                  >
                    {val.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-6">
          <h3 className="text-sm uppercase tracking-widest text-zinc-500 font-bold border-b border-white/5 pb-2">
            Impact Metrics
          </h3>
          {['S', 'C', 'I', 'A'].map((metric) => (
            <div key={metric} className="space-y-2">
              <label className="text-xs font-semibold text-zinc-300">
                {metric === 'S'
                  ? 'Scope'
                  : metric === 'C'
                  ? 'Confidentiality'
                  : metric === 'I'
                  ? 'Integrity'
                  : 'Availability'}
              </label>
              <div className="flex flex-wrap gap-2">
                {CVSS_DEF[metric as keyof CVSSMetrics].map((val) => (
                  <button
                    key={val.id}
                    onClick={() => setVector((p) => ({ ...p, [metric]: val.id }))}
                    title={val.desc}
                    className={`flex-1 min-w-[80px] px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                      vector[metric] === val.id
                        ? `${THEME_MAP[theme].bg} ${THEME_MAP[theme].text} border ${THEME_MAP[theme].border}`
                        : 'bg-[#111116] text-zinc-500 border border-white/5 hover:bg-white/5 hover:text-zinc-300'
                    }`}
                  >
                    {val.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-8 p-4 rounded-xl bg-[#111116] border border-white/5 font-mono text-xs text-zinc-400 text-center flex items-center justify-between">
        <span>
          Vector String: <span className="text-white">{vectorString}</span>
        </span>
        <button
          onClick={handleCopy}
          className="px-3 py-1 bg-white/10 hover:bg-white/20 rounded text-white flex items-center gap-2 transition-all"
        >
          {copied ? (
            <>
              <Check size={12} className="text-emerald-400" /> Copied!
            </>
          ) : (
            <>
              <Copy size={12} /> Copy Vector
            </>
          )}
        </button>
      </div>
    </div>
  )
}
