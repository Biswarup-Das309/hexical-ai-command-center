import { useState, useEffect, useRef } from 'react';
import { TerminalSquare } from 'lucide-react';

export type AccentTheme = 'cyan' | 'emerald' | 'rose' | 'violet' | 'amber';

const THEME_MAP: Record<AccentTheme, { text: string }> = {
  cyan: { text: 'text-cyan-400' },
  emerald: { text: 'text-emerald-400' },
  rose: { text: 'text-rose-400' },
  violet: { text: 'text-violet-400' },
  amber: { text: 'text-amber-400' }
};

function generateTimestamp(): string { 
  return new Date().toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 2 });
}

export const AdvancedTerminal = ({ logs, theme, onCommand, unavailableReason = 'No investigation selected' }: { logs: string[], theme: AccentTheme, onCommand: (cmd: string) => void, unavailableReason?: string }) => {
  const endRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  
  useEffect(() => { 
    endRef.current?.scrollIntoView({ behavior: 'smooth' }); 
  }, [logs]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && input.trim()) { 
      onCommand(input); 
      setInput(''); 
    }
  }

  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col bg-[#0a0a0c]">
       <div className="flex items-center justify-between mb-6">
         <div className="flex items-center gap-3">
           <TerminalSquare className={`size-6 ${THEME_MAP[theme].text}`} />
           <h2 className="text-2xl font-sans font-medium text-white tracking-tight">Execution Sandbox</h2>
         </div>
         <span className="bg-amber-500/10 border border-amber-500/20 text-amber-400 px-3 py-1 rounded text-[10px] font-mono uppercase tracking-widest flex items-center gap-2">
           <div className="size-2 bg-amber-500 rounded-full"/>
           {unavailableReason}
         </span>
      </div>
      
      <div className="flex-1 bg-[#050505] border border-white/10 rounded-2xl overflow-hidden flex flex-col font-mono text-[13px] shadow-2xl">
        <div className="flex-1 p-5 overflow-y-auto space-y-1.5 scrollbar-thin scrollbar-thumb-white/10">
          {logs.map((log, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className={`shrink-0 ${THEME_MAP[theme].text} opacity-50`}>
                [{generateTimestamp()}]
              </span>
              <span className={
                log.includes('WARN') || log.includes('403') || log.includes('401') 
                  ? 'text-amber-400' 
                  : log.includes('ERR') || log.includes('CRITICAL') 
                    ? 'text-rose-400' 
                    : log.includes('SUCCESS') || log.includes('200 OK') 
                      ? 'text-emerald-400' 
                      : log.startsWith('$') 
                        ? 'text-white font-bold' 
                        : 'text-zinc-300 leading-relaxed break-all whitespace-pre-wrap'
              }>
                {log}
              </span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
        
        <div className="border-t border-white/10 bg-[#0a0a0c] p-3 flex items-center gap-3">
          <span className={`${THEME_MAP[theme].text} font-bold shrink-0`}>sandbox&gt;</span>
          <input 
            type="text" 
            value={input} 
            onChange={e=>setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled
            className="flex-1 bg-transparent outline-none text-white placeholder:text-zinc-700 w-full disabled:cursor-not-allowed disabled:opacity-60"
            placeholder="Select an investigation to enable commands"
            aria-label="Execution sandbox command"
          />
        </div>
      </div>
    </div>
  );
};
