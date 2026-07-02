import { useState, useMemo } from 'react';
import { Code, AlertTriangle, ShieldCheck, ChevronRight, Cpu } from 'lucide-react';

// --- TYPES & CONSTANTS ---
export type AccentTheme = 'cyan' | 'emerald' | 'rose' | 'violet' | 'amber';

const THEME_MAP: Record<AccentTheme, { border: string, text: string, bg: string, accent: string }> = {
  cyan: { border: 'border-cyan-500/20', text: 'text-cyan-400', bg: 'bg-cyan-500/10', accent: 'cyan' },
  emerald: { border: 'border-emerald-500/20', text: 'text-emerald-400', bg: 'bg-emerald-500/10', accent: 'emerald' },
  rose: { border: 'border-rose-500/20', text: 'text-rose-400', bg: 'bg-rose-500/10', accent: 'rose' },
  violet: { border: 'border-violet-500/20', text: 'text-violet-400', bg: 'bg-violet-500/10', accent: 'violet' },
  amber: { border: 'border-amber-500/20', text: 'text-amber-400', bg: 'bg-amber-500/10', accent: 'amber' }
};

interface SecurityRule {
  id: string;
  regex: RegExp;
  title: string;
  description: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
}

// The "Brain" of the local AST Scanner
const SECURITY_RULES: SecurityRule[] = [
  {
    id: 'sqli',
    regex: /(?:SELECT|INSERT|UPDATE|DELETE).*?\+.*?(?:req|query|input|var)/i,
    title: 'SQL Injection (SQLi)',
    description: 'String concatenation detected in database query construction. Use parameterized queries or ORMs.',
    severity: 'CRITICAL'
  },
  {
    id: 'xss',
    regex: /(?:innerHTML|document\.write|eval)\s*\(\s*(?:req|input|var|document\.cookie)/i,
    title: 'Cross-Site Scripting (XSS)',
    description: 'Unsanitized input flowing into a DOM execution sink. Encode data before rendering.',
    severity: 'HIGH'
  },
  {
    id: 'hardcoded_secret',
    regex: /(?:password|secret|api[_-]?key|token|auth)\s*(?::|=)\s*['"][a-zA-Z0-9_\-]{10,}['"]/i,
    title: 'Hardcoded Credential',
    description: 'Cryptographic secret or credential found in plaintext. Move to environment variables or a secrets manager.',
    severity: 'CRITICAL'
  },
  {
    id: 'cmd_injection',
    regex: /(?:exec|spawn|system|popen)\s*\(\s*.*?\+.*?\)/i,
    title: 'Command Injection',
    description: 'Dynamic variables passed directly to an OS shell execution function. Sanitize inputs strictly.',
    severity: 'CRITICAL'
  },
  {
    id: 'timing_leak',
    regex: /(?:linearSearch|==\s*secret|!=\s*secret)/i,
    title: 'Timing Side-Channel',
    description: 'Early loop breaks or standard equality checks on secure arrays leak state bounds via execution time.',
    severity: 'MEDIUM'
  }
];

// Lightweight Zero-Dependency Syntax Highlighter
const highlightSyntax = (line: string) => {
  let highlighted = line;
  // Strings
  highlighted = highlighted.replace(/(["'`].*?["'`])/g, '<span class="text-emerald-300">$1</span>');
  // Keywords
  highlighted = highlighted.replace(/\b(public|private|static|class|void|int|string|boolean|const|let|var|function|return|if|else|for|while)\b/gi, '<span class="text-rose-400 font-semibold">$1</span>');
  // Comments
  highlighted = highlighted.replace(/(\/\/.*$)/g, '<span class="text-zinc-500 italic">$1</span>');
  return <span dangerouslySetInnerHTML={{ __html: highlighted }} />;
};

export const ASTVisualizer = ({ theme, codePayload }: { theme: AccentTheme, codePayload: string }) => {
  const [activeIssueIndex, setActiveIssueIndex] = useState<number | null>(null);

  // 1. Process Payload & Fallback
  const defaultCode = `public class SecureEngine {\n    // Hexical Local Sandbox\n    // Enter code in the Core Chat to analyze its AST trace.\n    public static void main(String[] args) {\n        System.out.println("Awaiting vectors...");\n    }\n}`;
  const targetCode = codePayload && codePayload.trim() ? codePayload : defaultCode;
  const codeLines = targetCode.split('\n');

  // 2. Run Heuristic Scan (Memoized for performance)
  const foundVulnerabilities = useMemo(() => {
    const findings: { lineIndex: number; rule: SecurityRule; lineContent: string }[] = [];
    codeLines.forEach((line, index) => {
      SECURITY_RULES.forEach(rule => {
        if (rule.regex.test(line)) {
          findings.push({ lineIndex: index, rule, lineContent: line });
        }
      });
    });
    return findings;
  }, [codeLines]);

  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col font-sans bg-[#0a0a0c]">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Code className={`size-6 ${THEME_MAP[theme].text}`} />
          <h2 className="text-2xl font-medium text-white tracking-tight">AST & Code Trace</h2>
        </div>
        <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-1.5 rounded-lg">
          <Cpu className="size-3.5 text-zinc-400" />
          <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-400 font-bold">Local Heuristics: Active</span>
        </div>
      </div>
      
      <div className="flex-1 bg-[#111116] border border-white/10 rounded-2xl flex flex-col lg:flex-row overflow-hidden shadow-inner">
        
        {/* LEFT PANEL: Interactive Code Viewer */}
        <div className="flex flex-1 overflow-hidden min-w-0 bg-[#050505] relative">
          {/* Dynamic Line Numbers */}
          <div className="w-12 bg-black border-r border-white/5 flex flex-col items-center py-4 text-xs font-mono text-zinc-700 select-none shrink-0">
            {codeLines.map((_, idx) => (
              <span key={idx} className="h-6 flex items-center">{idx + 1}</span>
            ))}
          </div>
          
          {/* Syntax Highlighted Code Grid */}
          <div className="flex-1 py-4 overflow-y-auto font-mono text-[13px] leading-6 whitespace-pre overflow-x-auto scrollbar-thin scrollbar-thumb-white/10">
            {codeLines.map((line, idx) => {
              const isFlagged = foundVulnerabilities.some(v => v.lineIndex === idx);
              const isActive = activeIssueIndex !== null && foundVulnerabilities[activeIssueIndex]?.lineIndex === idx;
              
              return (
                <div 
                  key={idx} 
                  className={`h-6 min-w-full px-4 transition-colors duration-200 cursor-default
                    ${isActive ? 'bg-amber-500/20 border-l-2 border-amber-500 -ml-[2px]' : 
                      isFlagged ? 'bg-amber-500/5 hover:bg-amber-500/10 border-l-2 border-amber-500/30 -ml-[2px]' : 'text-zinc-300'}
                  `}
                >
                  {line.trim() === '' ? ' ' : highlightSyntax(line)}
                </div>
              );
            })}
          </div>
        </div>
        
        {/* RIGHT PANEL: Diagnostics Dashboard */}
        <div className="w-full lg:w-80 bg-black border-t lg:border-t-0 lg:border-l border-white/5 flex flex-col shrink-0">
          <div className="p-4 border-b border-white/5 bg-white/[0.02]">
            <h3 className="text-xs uppercase tracking-widest font-bold text-zinc-500">Diagnostic Results</h3>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-thumb-white/10">
            {foundVulnerabilities.length > 0 ? (
              foundVulnerabilities.map((vuln, idx) => {
                const isActive = activeIssueIndex === idx;
                const isCrit = vuln.rule.severity === 'CRITICAL';
                
                return (
                  <button
                    key={idx}
                    onClick={() => setActiveIssueIndex(isActive ? null : idx)}
                    className={`w-full text-left p-3 rounded-xl border transition-all duration-300 ${
                      isActive 
                        ? `bg-${isCrit ? 'rose' : 'amber'}-500/10 border-${isCrit ? 'rose' : 'amber'}-500/50 shadow-lg` 
                        : 'bg-white/[0.02] border-white/5 hover:border-white/20'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className={`text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 ${isCrit ? 'text-rose-400' : 'text-amber-400'}`}>
                        <AlertTriangle size={12} /> {vuln.rule.severity}
                      </div>
                      <span className="text-[9px] font-mono text-zinc-500 px-1.5 py-0.5 bg-black rounded border border-white/5">
                        Line {vuln.lineIndex + 1}
                      </span>
                    </div>
                    <div className="text-white font-medium text-sm mb-1">{vuln.rule.title}</div>
                    {isActive && (
                      <div className="text-xs text-zinc-400 mt-2 leading-relaxed animate-fade-in">
                        {vuln.rule.description}
                      </div>
                    )}
                    {!isActive && (
                      <div className="mt-2 flex justify-end text-zinc-600">
                        <ChevronRight size={14} />
                      </div>
                    )}
                  </button>
                );
              })
            ) : (
              /* The "Clean" Empty State */
              <div className="flex flex-col items-center justify-center h-full text-center p-6 space-y-4">
                <div className="relative">
                  <div className={`absolute inset-0 bg-${THEME_MAP[theme].accent}-500 blur-[30px] opacity-20 rounded-full`} />
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
  );
};