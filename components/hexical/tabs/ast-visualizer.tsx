import { Code, AlertTriangle, ShieldCheck, ChevronRight, Cpu } from 'lucide-react'
import { useState, useMemo, useRef, useEffect, type ReactNode } from 'react'

// --- TYPES & CONSTANTS ---
export type AccentTheme = 'cyan' | 'emerald' | 'rose' | 'violet' | 'amber'

// Full literal class strings only — Tailwind's build-time scanner finds
// classes by searching source text, not by executing this code. Any
// template-string interpolation like `bg-${x}-500` never appears as a
// literal token and gets dropped from the production CSS. Every value
// below must stay a complete, static string for that reason.
const THEME_MAP: Record<AccentTheme, { border: string; text: string; bg: string; glow: string }> = {
  cyan: { border: 'border-cyan-500/20', text: 'text-cyan-400', bg: 'bg-cyan-500/10', glow: 'bg-cyan-500' },
  emerald: {
    border: 'border-emerald-500/20',
    text: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    glow: 'bg-emerald-500',
  },
  rose: { border: 'border-rose-500/20', text: 'text-rose-400', bg: 'bg-rose-500/10', glow: 'bg-rose-500' },
  violet: { border: 'border-violet-500/20', text: 'text-violet-400', bg: 'bg-violet-500/10', glow: 'bg-violet-500' },
  amber: { border: 'border-amber-500/20', text: 'text-amber-400', bg: 'bg-amber-500/10', glow: 'bg-amber-500' },
}

interface SecurityRule {
  id: string
  regex: RegExp
  title: string
  description: string
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM'
}

// The "Brain" of the local AST Scanner
const SECURITY_RULES: SecurityRule[] = [
  {
    id: 'sqli',
    regex: /(?:SELECT|INSERT|UPDATE|DELETE).*?\+.*?(?:req|query|input|var)/i,
    title: 'SQL Injection (SQLi)',
    description: 'String concatenation detected in database query construction. Use parameterized queries or ORMs.',
    severity: 'CRITICAL',
  },
  {
    id: 'xss',
    regex: /(?:innerHTML|document\.write|eval)\s*\(\s*(?:req|input|var|document\.cookie)/i,
    title: 'Cross-Site Scripting (XSS)',
    description: 'Unsanitized input flowing into a DOM execution sink. Encode data before rendering.',
    severity: 'HIGH',
  },
  {
    id: 'hardcoded_secret',
    regex: /(?:password|secret|api[_-]?key|token|auth)\s*(?::|=)\s*['"][a-zA-Z0-9_\-]{10,}['"]/i,
    title: 'Hardcoded Credential',
    description:
      'Cryptographic secret or credential found in plaintext. Move to environment variables or a secrets manager.',
    severity: 'CRITICAL',
  },
  {
    id: 'cmd_injection',
    regex: /(?:exec|spawn|system|popen)\s*\(\s*.*?\+.*?\)/i,
    title: 'Command Injection',
    description: 'Dynamic variables passed directly to an OS shell execution function. Sanitize inputs strictly.',
    severity: 'CRITICAL',
  },
  {
    id: 'timing_leak',
    regex: /(?:linearSearch|==\s*secret|!=\s*secret)/i,
    title: 'Timing Side-Channel',
    description: 'Early loop breaks or standard equality checks on secure arrays leak state bounds via execution time.',
    severity: 'MEDIUM',
  },
]

// Matches, in priority order at each position: a line comment, a quoted
// string (each quote type matched to itself — the previous version's
// [\'"`].*?[\'"`] could open with " and close with `), or a language
// keyword. Whichever alternative starts earliest in the line wins.
const TOKEN_SOURCE =
  String.raw`(\/\/.*$)|("[^"]*"|'[^']*'|` +
  '`[^`]*`' +
  String.raw`)|\b(public|private|static|class|void|int|string|boolean|const|let|var|function|return|if|else|for|while)\b`

/**
 * Zero-dependency syntax highlighter. Returns React nodes built from
 * `line.slice(...)` substrings — never raw HTML — so there is no
 * injection surface even when `line` is attacker-controlled input,
 * which for a code-analysis tool it always should be assumed to be.
 */
function highlightSyntax(line: string): ReactNode[] {
  if (line.trim() === '') return [' ']

  const regex = new RegExp(TOKEN_SOURCE, 'gi')
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let key = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(line)) !== null) {
    const [full, comment, str, keyword] = match

    if (match.index > lastIndex) {
      nodes.push(<span key={key++}>{line.slice(lastIndex, match.index)}</span>)
    }

    if (comment) {
      nodes.push(
        <span key={key++} className="text-zinc-500 italic">
          {comment}
        </span>,
      )
    } else if (str) {
      nodes.push(
        <span key={key++} className="text-emerald-300">
          {str}
        </span>,
      )
    } else if (keyword) {
      nodes.push(
        <span key={key++} className="text-rose-400 font-semibold">
          {keyword}
        </span>,
      )
    }

    lastIndex = match.index + full.length
    if (full.length === 0) regex.lastIndex += 1 // guard against zero-length match loops
  }

  if (lastIndex < line.length) {
    nodes.push(<span key={key++}>{line.slice(lastIndex)}</span>)
  }

  return nodes
}

const DEFAULT_CODE = `public class SecureEngine {
    // Hexical Local Sandbox
    // Enter code in the Core Chat to analyze its AST trace.
    public static void main(String[] args) {
        System.out.println("Awaiting vectors...");
    }
}`

export const ASTVisualizer = ({ theme, codePayload }: { theme: AccentTheme; codePayload: string }) => {
  const [activeIssueIndex, setActiveIssueIndex] = useState<number | null>(null)
  const lineRefs = useRef<Array<HTMLDivElement | null>>([])

  const targetCode = codePayload && codePayload.trim() ? codePayload : DEFAULT_CODE

  // Stable array reference across renders unless the code itself changes —
  // this is what actually makes the scan below cheap on re-render, not
  // just the useMemo wrapper by itself.
  const codeLines = useMemo(() => targetCode.split('\n'), [targetCode])

  const highlightedLines = useMemo(() => codeLines.map(highlightSyntax), [codeLines])

  const foundVulnerabilities = useMemo(() => {
    const findings: { lineIndex: number; rule: SecurityRule; lineContent: string }[] = []
    codeLines.forEach((line, index) => {
      SECURITY_RULES.forEach((rule) => {
        if (rule.regex.test(line)) {
          findings.push({ lineIndex: index, rule, lineContent: line })
        }
      })
    })
    return findings
  }, [codeLines])

  // lineIndex -> finding indices, so each rendered line does an O(1) map
  // lookup instead of scanning every finding on every line on every render.
  const findingsByLine = useMemo(() => {
    const map = new Map<number, number[]>()
    foundVulnerabilities.forEach((v, findingIdx) => {
      const existing = map.get(v.lineIndex)
      if (existing) existing.push(findingIdx)
      else map.set(v.lineIndex, [findingIdx])
    })
    return map
  }, [foundVulnerabilities])

  // Reset selection when a new payload arrives so a stale index from the
  // previous scan can't linger.
  useEffect(() => {
    setActiveIssueIndex(null)
  }, [codePayload])

  // Selecting a diagnostic scrolls the code panel to the offending line.
  useEffect(() => {
    if (activeIssueIndex === null) return
    const target = foundVulnerabilities[activeIssueIndex]
    if (!target) return
    lineRefs.current[target.lineIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeIssueIndex, foundVulnerabilities])

  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col font-sans bg-[#0a0a0c]">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Code className={`size-6 ${THEME_MAP[theme].text}`} />
          <h2 className="text-2xl font-medium text-white tracking-tight">AST & Code Trace</h2>
        </div>
        <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-1.5 rounded-lg">
          <Cpu className="size-3.5 text-zinc-400" />
          <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-400 font-bold">
            Local Heuristics: Active
          </span>
        </div>
      </div>

      <div className="flex-1 bg-[#111116] border border-white/10 rounded-2xl flex flex-col lg:flex-row overflow-hidden shadow-inner">
        {/* LEFT PANEL: Interactive Code Viewer */}
        <div className="flex flex-1 overflow-hidden min-w-0 bg-[#050505] relative">
          {/* Dynamic Line Numbers */}
          <div className="w-12 bg-black border-r border-white/5 flex flex-col items-center py-4 text-xs font-mono text-zinc-700 select-none shrink-0">
            {codeLines.map((_, idx) => (
              <span key={idx} className="h-6 flex items-center">
                {idx + 1}
              </span>
            ))}
          </div>

          {/* Syntax Highlighted Code Grid */}
          <div
            className="flex-1 py-4 overflow-y-auto font-mono text-[13px] leading-6 whitespace-pre overflow-x-auto"
            tabIndex={0}
            aria-label="Source code"
          >
            {codeLines.map((line, idx) => {
              const flaggedFindingIndexes = findingsByLine.get(idx)
              const isFlagged = flaggedFindingIndexes !== undefined
              const isActive = activeIssueIndex !== null && flaggedFindingIndexes?.includes(activeIssueIndex)

              return (
                <div
                  key={idx}
                  ref={(el) => {
                    lineRefs.current[idx] = el
                  }}
                  className={`h-6 min-w-full px-4 transition-colors duration-200 cursor-default
                    ${
                      isActive
                        ? 'bg-amber-500/20 border-l-2 border-amber-500 -ml-[2px]'
                        : isFlagged
                        ? 'bg-amber-500/5 hover:bg-amber-500/10 border-l-2 border-amber-500/30 -ml-[2px]'
                        : 'text-zinc-300'
                    }
                  `}
                >
                  {highlightedLines[idx]}
                </div>
              )
            })}
          </div>
        </div>

        {/* RIGHT PANEL: Diagnostics Dashboard */}
        <div className="w-full lg:w-80 bg-black border-t lg:border-t-0 lg:border-l border-white/5 flex flex-col shrink-0">
          <div className="p-4 border-b border-white/5 bg-white/[0.02]">
            <h3 className="text-xs uppercase tracking-widest font-bold text-zinc-500">Diagnostic Results</h3>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {foundVulnerabilities.length > 0 ? (
              foundVulnerabilities.map((vuln, idx) => {
                const isActive = activeIssueIndex === idx
                const isCrit = vuln.rule.severity === 'CRITICAL'

                return (
                  <button
                    key={idx}
                    onClick={() => setActiveIssueIndex(isActive ? null : idx)}
                    aria-expanded={isActive}
                    className={`w-full text-left p-3 rounded-xl border transition-all duration-300 ${
                      isActive
                        ? isCrit
                          ? 'bg-rose-500/10 border-rose-500/50 shadow-lg'
                          : 'bg-amber-500/10 border-amber-500/50 shadow-lg'
                        : 'bg-white/[0.02] border-white/5 hover:border-white/20'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div
                        className={`text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 ${
                          isCrit ? 'text-rose-400' : 'text-amber-400'
                        }`}
                      >
                        <AlertTriangle size={12} /> {vuln.rule.severity}
                      </div>
                      <span className="text-[9px] font-mono text-zinc-500 px-1.5 py-0.5 bg-black rounded border border-white/5">
                        Line {vuln.lineIndex + 1}
                      </span>
                    </div>
                    <div className="text-white font-medium text-sm mb-1">{vuln.rule.title}</div>
                    {isActive && (
                      <div className="text-xs text-zinc-400 mt-2 leading-relaxed animate-rise">
                        {vuln.rule.description}
                      </div>
                    )}
                    {!isActive && (
                      <div className="mt-2 flex justify-end text-zinc-600">
                        <ChevronRight size={14} />
                      </div>
                    )}
                  </button>
                )
              })
            ) : (
              /* The "Clean" Empty State */
              <div className="flex flex-col items-center justify-center h-full text-center p-6 space-y-4">
                <div className="relative">
                  <div className={`absolute inset-0 ${THEME_MAP[theme].glow} blur-[30px] opacity-20 rounded-full`} />
                  <ShieldCheck className={`size-12 relative z-10 ${THEME_MAP[theme].text}`} />
                </div>
                <div>
                  <h4 className="text-white font-medium text-sm mb-1">No Syntax Anomalies</h4>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    The heuristic scanner did not detect any structural vulnerabilities in the current scope.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
