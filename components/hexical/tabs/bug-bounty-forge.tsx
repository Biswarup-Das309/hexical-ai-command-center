import { FileText, GitBranch, CheckCircle2 } from 'lucide-react'
import { useState } from 'react'

export type AccentTheme = 'cyan' | 'emerald' | 'rose' | 'violet' | 'amber'

const THEME_MAP: Record<AccentTheme, { bg: string; text: string; accent: string }> = {
  cyan: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', accent: 'cyan' },
  emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', accent: 'emerald' },
  rose: { bg: 'bg-rose-500/10', text: 'text-rose-400', accent: 'rose' },
  violet: { bg: 'bg-violet-500/10', text: 'text-violet-400', accent: 'violet' },
  amber: { bg: 'bg-amber-500/10', text: 'text-amber-400', accent: 'amber' },
}

export const BugBountyForge = ({ theme, targets }: { theme: AccentTheme; targets: string[] }) => {
  const defaultTarget = targets.length > 0 ? targets[0] : 'project context'

  const hackerOneTemplate = `## Engineering change record\n**Project context:** ${defaultTarget}\n\n## Goal\nDescribe the intended outcome.\n\n## Investigation evidence\nList only evidence returned by the investigation or supplied project context.\n\n## Proposed plan\n1. Add the approved change steps.\n2. Identify the validation criteria.\n\n## Verification\nRecord tests, checks, and observed results.`
  const bugcrowdTemplate = `# Incident / remediation record\n**Project context:** ${defaultTarget}\n\n## Observed behavior\nDocument the reported behavior and affected area.\n\n## Root cause evidence\nLink code paths, logs, or analysis that supports the conclusion.\n\n## Remediation\nDescribe the approved change and rollback considerations.\n\n## Validation evidence\nRecord the exact checks that passed or failed.`

  const [activeFormat, setActiveFormat] = useState<'hackerone' | 'bugcrowd'>('hackerone')
  const [report, setReport] = useState(hackerOneTemplate)

  const switchFormat = (format: 'hackerone' | 'bugcrowd') => {
    setActiveFormat(format)
    setReport(format === 'hackerone' ? hackerOneTemplate : bugcrowdTemplate)
  }

  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col font-sans bg-[#0a0a0c]">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileText className={`size-6 ${THEME_MAP[theme].text}`} />
          <h2 className="text-2xl font-medium text-white tracking-tight">Evidence Draft</h2>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => switchFormat('hackerone')}
            className={`${
              activeFormat === 'hackerone'
                ? THEME_MAP[theme].bg + ' text-white border-' + THEME_MAP[theme].accent + '-500/50'
                : 'bg-[#111116] text-zinc-400'
            } border border-white/10 px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors`}
          >
            Change record
          </button>
          <button
            onClick={() => switchFormat('bugcrowd')}
            className={`${
              activeFormat === 'bugcrowd'
                ? THEME_MAP[theme].bg + ' text-white border-' + THEME_MAP[theme].accent + '-500/50'
                : 'bg-[#111116] text-zinc-400'
            } border border-white/10 px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors`}
          >
            Remediation record
          </button>
        </div>
      </div>

      <div className="flex-1 bg-[#111116] border border-white/10 rounded-2xl flex flex-col overflow-hidden shadow-inner">
        <div className="bg-zinc-950 border-b border-white/5 p-3 flex items-center gap-4 text-xs font-mono text-zinc-400">
          <span className="flex items-center gap-2">
            <GitBranch size={14} className={THEME_MAP[theme].text} />
            Context:
            <input
              type="text"
              defaultValue={defaultTarget}
              className="bg-transparent text-white outline-none border-b border-white/20 px-1 w-48 focus:border-white/50"
            />
          </span>
          <span className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-emerald-400" />
            Status:
            <select className="bg-transparent text-white outline-none border-b border-white/20">
              <option>Draft</option>
              <option>Reviewed</option>
              <option>Verified</option>
            </select>
          </span>
        </div>
        <textarea
          value={report}
          onChange={(e) => setReport(e.target.value)}
          className="flex-1 bg-transparent p-6 text-zinc-300 font-mono text-sm outline-none resize-none scrollbar-thin scrollbar-thumb-white/10"
          spellCheck="false"
        />
      </div>
    </div>
  )
}
