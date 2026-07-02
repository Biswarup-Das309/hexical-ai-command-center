import { useState } from 'react';
import { Zap, Copy, ArrowRight } from 'lucide-react';

export type AccentTheme = 'cyan' | 'emerald' | 'rose' | 'violet' | 'amber';
type EncodingType = 'base64' | 'url' | 'hex' | 'rot13' | 'unicode';

const THEME_MAP: Record<AccentTheme, { border: string, text: string, bg: string }> = {
  cyan: { border: 'border-cyan-500/20', text: 'text-cyan-400', bg: 'bg-cyan-500/10' },
  emerald: { border: 'border-emerald-500/20', text: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  rose: { border: 'border-rose-500/20', text: 'text-rose-400', bg: 'bg-rose-500/10' },
  violet: { border: 'border-violet-500/20', text: 'text-violet-400', bg: 'bg-violet-500/10' },
  amber: { border: 'border-amber-500/20', text: 'text-amber-400', bg: 'bg-amber-500/10' }
};

function encodePayload(payload: string, type: EncodingType): string {
  try {
    switch (type) {
      case 'base64': return btoa(payload);
      case 'url': return encodeURIComponent(payload);
      case 'hex': return Array.from(payload).map(c => c.charCodeAt(0).toString(16)).join('');
      case 'rot13': return payload.replace(/[a-zA-Z]/g, c => {
        const code = c.charCodeAt(0); 
        const shifted = code + 13;
        return String.fromCharCode((c <= 'Z' ? 90 : 122) >= shifted ? shifted : shifted - 26);
      });
      case 'unicode': return Array.from(payload).map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
      default: return payload;
    }
  } catch (e) { 
    return "ENCODING_ERROR"; 
  }
}

export const PayloadMutator = ({ theme }: { theme: AccentTheme }) => {
  const [payload, setPayload] = useState('<script>alert(document.cookie)</script>');
  const [encType, setEncType] = useState<EncodingType>('url');
  
  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col font-sans bg-[#0a0a0c]">
      <div className="flex items-center gap-3 mb-6">
        <Zap className={`size-6 ${THEME_MAP[theme].text}`} />
        <h2 className="text-2xl font-medium text-white tracking-tight">Payload Mutator</h2>
      </div>
      
      <div className="flex flex-col gap-6 h-full">
        <div className="flex flex-col flex-1 gap-2">
          <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">Raw Vector Input</label>
          <textarea 
            value={payload} 
            onChange={e=>setPayload(e.target.value)} 
            className="flex-1 bg-[#111116] border border-white/10 rounded-xl p-4 text-zinc-300 font-mono text-sm resize-none outline-none focus:border-white/30" 
            spellCheck="false" 
          />
        </div>
        
        <div className="flex items-center gap-4 py-2 overflow-x-auto no-scrollbar">
          {(['url', 'base64', 'hex', 'unicode', 'rot13'] as EncodingType[]).map(type => (
            <button 
              key={type} 
              onClick={() => setEncType(type)} 
              className={`px-4 py-2 rounded-lg text-xs shrink-0 font-bold uppercase tracking-wider transition-all ${
                encType === type 
                  ? `${THEME_MAP[theme].bg} ${THEME_MAP[theme].text} border ${THEME_MAP[theme].border}` 
                  : 'bg-white/5 text-zinc-400 hover:text-white border border-transparent'
              }`}
            >
              {type}
            </button>
          ))}
          <ArrowRight className="text-zinc-600 ml-auto hidden md:block" />
        </div>

        <div className="flex flex-col flex-1 gap-2">
          <div className="flex items-center justify-between">
            <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">Mutated Output</label>
            <button className="text-xs text-zinc-400 hover:text-white flex items-center gap-1"><Copy size={12}/> Copy</button>
          </div>
          <div className="flex-1 bg-black border border-emerald-500/20 rounded-xl p-4 text-emerald-400 font-mono text-sm overflow-y-auto break-all shadow-inner">
            {encodePayload(payload, encType)}
          </div>
        </div>
      </div>
    </div>
  );
};