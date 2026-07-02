import { useState } from 'react';
import { FileText, Crosshair, Bug } from 'lucide-react';

export type AccentTheme = 'cyan' | 'emerald' | 'rose' | 'violet' | 'amber';

const THEME_MAP: Record<AccentTheme, { bg: string, text: string, accent: string }> = {
  cyan: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', accent: 'cyan' },
  emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', accent: 'emerald' },
  rose: { bg: 'bg-rose-500/10', text: 'text-rose-400', accent: 'rose' },
  violet: { bg: 'bg-violet-500/10', text: 'text-violet-400', accent: 'violet' },
  amber: { bg: 'bg-amber-500/10', text: 'text-amber-400', accent: 'amber' }
};

export const BugBountyForge = ({ theme, targets }: { theme: AccentTheme, targets: string[] }) => {
  const defaultTarget = targets.length > 0 ? targets[0] : 'vulnerable-domain.com';
  
  const hackerOneTemplate = `## Summary\nAn unauthenticated Information Disclosure vulnerability was discovered in ${defaultTarget}.\n\n## Description\nDue to improper access controls on the REST API endpoint, sensitive metadata is exposed.\n\n## Steps To Reproduce\n1. Run \`curl -X GET https://${defaultTarget}/api/v1/metadata\`\n2. Observe the leaked tokens in the JSON-response.\n\n## Impact\nAttackers can leverage these tokens to pivot into the internal network.`;
  const bugcrowdTemplate = `# Vulnerability Details\n**Vulnerability Type:** Information Disclosure\n**Target:** ${defaultTarget}\n\n## Bug Description\nThe API fails to validate session tokens, allowing unauthenticated read access to internal configuration states.\n\n## Reproduction Steps\n- Navigate to \`https://${defaultTarget}/api/v1/metadata\` without a valid session token.\n- Note that the application returns HTTP 200 OK along with sensitive data.\n\n## Business Impact\nComplete compromise of downstream services utilizing leaked configuration secrets.`;

  const [activeFormat, setActiveFormat] = useState<'hackerone' | 'bugcrowd'>('hackerone');
  const [report, setReport] = useState(hackerOneTemplate);

  const switchFormat = (format: 'hackerone' | 'bugcrowd') => {
    setActiveFormat(format);
    setReport(format === 'hackerone' ? hackerOneTemplate : bugcrowdTemplate);
  }

  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col font-sans bg-[#0a0a0c]">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileText className={`size-6 ${THEME_MAP[theme].text}`} />
          <h2 className="text-2xl font-medium text-white tracking-tight">Bug Bounty Forge</h2>
        </div>
        <div className="flex gap-2">
           <button onClick={() => switchFormat('hackerone')} className={`${activeFormat === 'hackerone' ? THEME_MAP[theme].bg + ' text-white border-' + THEME_MAP[theme].accent + '-500/50' : 'bg-[#111116] text-zinc-400'} border border-white/10 px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors`}>
             HackerOne Format
           </button>
           <button onClick={() => switchFormat('bugcrowd')} className={`${activeFormat === 'bugcrowd' ? THEME_MAP[theme].bg + ' text-white border-' + THEME_MAP[theme].accent + '-500/50' : 'bg-[#111116] text-zinc-400'} border border-white/10 px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors`}>
             Bugcrowd Format
           </button>
        </div>
      </div>
      
      <div className="flex-1 bg-[#111116] border border-white/10 rounded-2xl flex flex-col overflow-hidden shadow-inner">
        <div className="bg-zinc-950 border-b border-white/5 p-3 flex items-center gap-4 text-xs font-mono text-zinc-400">
          <span className="flex items-center gap-2">
            <Crosshair size={14} className={THEME_MAP[theme].text}/> 
            Target: 
            <input type="text" defaultValue={defaultTarget} className="bg-transparent text-white outline-none border-b border-white/20 px-1 w-48 focus:border-white/50" />
          </span>
          <span className="flex items-center gap-2">
            <Bug size={14} className="text-rose-400"/> 
            Severity: 
            <select className="bg-transparent text-white outline-none border-b border-white/20">
              <option>Critical</option>
              <option>High</option>
              <option>Medium</option>
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
  );
};