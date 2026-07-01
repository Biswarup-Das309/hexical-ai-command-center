'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { 
  Loader2, Terminal, ShieldAlert, Eye, Code, Crosshair, ChevronDown, Check, 
  FolderGit2, Command, Activity, Sparkles, X, Globe, CheckCircle, AlertTriangle, 
  Database, Settings, Download, Trash2, Cpu, Timer, ShieldCheck, FileJson, 
  ToggleRight, ToggleLeft, UserCircle, SlidersHorizontal, Lock, BookOpen,
  Ghost, Webhook, Key, TerminalSquare, Target, Fingerprint, Regex, FileCode2, Flame,
  Network, Server, Radio, ScanLine, LayoutDashboard, Zap, SearchCode,
  GitMerge, Shield, ShieldOff, CpuIcon, Hash, Layers, Bug, Workflow,
  FileText, Copy, ArrowRight, ServerCrash, Binary, RefreshCw, Layers as LayersIcon
} from 'lucide-react'
import { HexicalLogo } from '@/components/hexical/hexical-logo'
import { createSupabaseClient } from '@/lib/supabase' 
import { useGuestLimit } from '@/hooks/use-guest-limit'
import { inferRoute, type StreamMessage } from '@/lib/hexical-types'
import { ChatSidebar } from '@/components/hexical/chat-sidebar'
import { DataStream } from '@/components/hexical/data-stream'
import { CommandInput } from '@/components/hexical/command-input'
import { UpgradeModal } from '@/components/hexical/upgrade-modal'
import { useUser, useClerk, useSession } from '@clerk/nextjs'

// =============================================================================
// 1. EXTENDED TYPES & INTERFACES (NEXT-GEN ARCHITECTURE)
// =============================================================================
type ViewMode = 'chat' | 'recon' | 'payloads' | 'terminal' | 'graph' | 'cvss' | 'bounty' | 'ast';
type AccentTheme = 'cyan' | 'emerald' | 'rose' | 'violet' | 'amber';
type EncodingType = 'base64' | 'url' | 'hex' | 'rot13' | 'unicode';

interface TraceSource { 
  name: string; 
  verified: boolean; 
  type?: 'database' | 'web' | 'heuristic'; 
}

interface TraceMetrics { 
  latencyMs: number; 
  tokensUsed: number; 
  confidenceScore: number; 
}

interface ExtendedStreamMessage extends StreamMessage {
  sources?: TraceSource[]; 
  isVerifiedContent?: boolean; 
  metrics?: TraceMetrics;
  swarmConsensus?: SwarmEvaluation; 
  graphData?: AttackGraph;
}

interface SwarmEvaluation {
  redTeam: { confidence: number; logic: string; payloadSuggested: string };
  blueTeam: { mitigation: string; blockedBy: string[]; riskLevel: 'LOW' | 'MED' | 'HIGH' | 'CRITICAL' };
  architect: { route: string; architecturalFlaw: string };
  finalConsensus: boolean;
}

interface GraphNode { id: string; label: string; type: 'entry' | 'vuln' | 'pivot' | 'impact'; x: number; y: number; }
interface GraphEdge { source: string; target: string; label: string; }
interface AttackGraph { nodes: GraphNode[]; edges: GraphEdge[]; }

type MetricValue = { id: string; label: string; weight: number; desc: string };
type CVSSMetrics = { AV: MetricValue[]; AC: MetricValue[]; PR: MetricValue[]; UI: MetricValue[]; S: MetricValue[]; C: MetricValue[]; I: MetricValue[]; A: MetricValue[]; };

// =============================================================================
// 2. CONSTANTS, DICTIONARIES & CONFIGURATIONS
// =============================================================================
const DEFAULT_GUEST_NAME = 'Guest'
const DEFAULT_GUEST_EMAIL = 'guest@hexical.ai'

const PENDING_SESSION_ID = 'local_pending_session'

const createFreshChatState = (id: string) => ({
  id,
  title: 'New Context',
  pinned: false,
  messages: [{ 
    id: 'init', 
    role: 'hexical', 
    text: 'HEXICAL KERNEL ONLINE. SECURE PROTOCOLS ENGAGED. AWAITING TARGET VECTORS.', 
    ts: '00:00', 
    steps: [], 
    valid: true 
  }]
})

const THEME_MAP: Record<AccentTheme, { border: string, text: string, bg: string, glow: string, accent: string }> = {
  cyan: { border: 'border-cyan-500/20', text: 'text-cyan-400', bg: 'bg-cyan-500/10', glow: 'shadow-cyan-950/20', accent: 'cyan' },
  emerald: { border: 'border-emerald-500/20', text: 'text-emerald-400', bg: 'bg-emerald-500/10', glow: 'shadow-emerald-950/20', accent: 'emerald' },
  rose: { border: 'border-rose-500/20', text: 'text-rose-400', bg: 'bg-rose-500/10', glow: 'shadow-rose-950/20', accent: 'rose' },
  violet: { border: 'border-violet-500/20', text: 'text-violet-400', bg: 'bg-violet-500/10', glow: 'shadow-violet-950/20', accent: 'violet' },
  amber: { border: 'border-amber-500/20', text: 'text-amber-400', bg: 'bg-amber-500/10', glow: 'shadow-amber-950/20', accent: 'amber' }
}

const SECURITY_PROFILES = [
  { id: 'swarm', name: 'Swarm Intelligence', description: 'Multi-agent Red/Blue team consensus', icon: GitMerge, color: 'text-amber-400' },
  { id: 'recon', name: 'Recon Engine', description: 'Attack surface mapping & enumeration', icon: Network, color: 'text-emerald-400' },
  { id: 'bug-hunter', name: 'Exploit Architect', description: 'Weaponized PoC generation', icon: Crosshair, color: 'text-rose-400' },
  { id: 'defense', name: 'Defense Matrix', description: 'WAF rules & code patch generation', icon: Shield, color: 'text-cyan-400' }
]

const WORKSPACES = [
  { id: 'global', name: 'Global Namespace' }, 
  { id: 'cloud', name: 'Cloud Infrastructure (AWS/GCP)' }, 
  { id: 'web', name: 'Web Application (React/Next.js)' }, 
  { id: 'binary', name: 'Compiled Binary / Memory' },
  { id: 'appsec', name: 'AppSec (Java / C++)' }
]

const PROCESSING_PHASES = [
  "Spawning isolated WebContainer...", 
  "Injecting pre-flight heuristic hooks...",
  "Compiling AST & Control Flow Graphs...", 
  "Fuzzing input interpolations...",
  "Deploying Red Team Agent...", 
  "Deploying Blue Team Agent...",
  "Negotiating exploit feasibility...", 
  "Generating Attack SVG Maps..."
]

const CVSS_DEF: CVSSMetrics = {
  AV: [{ id: 'N', label: 'Network', weight: 0.85, desc: 'Exploitable remotely' }, { id: 'A', label: 'Adjacent', weight: 0.62, desc: 'Local network only' }, { id: 'L', label: 'Local', weight: 0.55, desc: 'Requires OS access' }, { id: 'P', label: 'Physical', weight: 0.2, desc: 'Requires physical access' }],
  AC: [{ id: 'L', label: 'Low', weight: 0.77, desc: 'No special conditions' }, { id: 'H', label: 'High', weight: 0.44, desc: 'Requires specific conditions' }],
  PR: [{ id: 'N', label: 'None', weight: 0.85, desc: 'No auth required' }, { id: 'L', label: 'Low', weight: 0.62, desc: 'Basic user access' }, { id: 'H', label: 'High', weight: 0.27, desc: 'Admin access required' }],
  UI: [{ id: 'N', label: 'None', weight: 0.85, desc: 'No user interaction' }, { id: 'R', label: 'Required', weight: 0.62, desc: 'Requires victim action' }],
  S:  [{ id: 'U', label: 'Unchanged', weight: 0.0, desc: 'Only impacts vulnerable component' }, { id: 'C', label: 'Changed', weight: 0.0, desc: 'Impacts other components' }],
  C:  [{ id: 'H', label: 'High', weight: 0.56, desc: 'Total info disclosure' }, { id: 'L', label: 'Low', weight: 0.22, desc: 'Partial disclosure' }, { id: 'N', label: 'None', weight: 0.0, desc: 'No loss' }],
  I:  [{ id: 'H', label: 'High', weight: 0.56, desc: 'Total compromise' }, { id: 'L', label: 'Low', weight: 0.22, desc: 'Partial modification' }, { id: 'N', label: 'None', weight: 0.0, desc: 'No loss' }],
  A:  [{ id: 'H', label: 'High', weight: 0.56, desc: 'Total DoS' }, { id: 'L', label: 'Low', weight: 0.22, desc: 'Partial DoS' }, { id: 'N', label: 'None', weight: 0.0, desc: 'No loss' }]
};

// =============================================================================
// 3. UTILITY ENGINES
// =============================================================================
function generateTimestamp(): string { 
  return new Date().toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 2 }) 
}

function generateUniqueID(): string { 
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15); 
}

function encodePayload(payload: string, type: EncodingType): string {
  try {
    switch (type) {
      case 'base64': 
        return btoa(payload);
      case 'url': 
        return encodeURIComponent(payload);
      case 'hex': 
        return Array.from(payload).map(c => c.charCodeAt(0).toString(16)).join('');
      case 'rot13': 
        return payload.replace(/[a-zA-Z]/g, c => {
          const code = c.charCodeAt(0); 
          const shifted = code + 13;
          return String.fromCharCode((c <= 'Z' ? 90 : 122) >= shifted ? shifted : shifted - 26);
        });
      case 'unicode': 
        return Array.from(payload).map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
      default: 
        return payload;
    }
  } catch (e) { 
    return "ENCODING_ERROR"; 
  }
}

function sanitizeLocalPayload(text: string, isActive: boolean): string {
  if (!isActive) return text;
  
  let s = text.replace(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, '[REDACTED_IPv4]');
  s = s.replace(/(eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,})/g, '[REDACTED_JWT]');
  s = s.replace(/(?:api_key|access_token|secret_key|password)[=:\s]*(["']?)[a-zA-Z0-9_\-]{16,}\1/gi, '[REDACTED_SECRET]');
  s = s.replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|gov|edu|ai|app)\b/gi, '[REDACTED_DOMAIN]');
  
  return s;
}

const extractTargetsFromLogic = (text: string): string[] => {
  const ipRegex = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
  const domainRegex = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|gov|edu|ai|app|local)\b/gi;
  
  return Array.from(new Set([
    ...(text.match(ipRegex) || []), 
    ...(text.match(domainRegex) || [])
  ])).slice(0, 8);
}

const parseAttackGraph = (logic: string): AttackGraph => {
  const isWeb = logic.includes('xss') || logic.includes('sql') || logic.includes('http');
  
  if (isWeb) {
    return {
      nodes: [
        { id: '1', label: 'HTTP Request', type: 'entry', x: 50, y: 150 },
        { id: '2', label: 'WAF Bypass', type: 'pivot', x: 200, y: 80 },
        { id: '3', label: 'Input Interpolation', type: 'vuln', x: 200, y: 220 },
        { id: '4', label: 'Database Execution', type: 'impact', x: 380, y: 150 }
      ],
      edges: [ 
        { source: '1', target: '2', label: 'Obfuscation' }, 
        { source: '1', target: '3', label: 'Raw Injection' }, 
        { source: '2', target: '4', label: 'Execution' }, 
        { source: '3', target: '4', label: 'Execution' } 
      ]
    };
  }
  
  return {
    nodes: [
      { id: '1', label: 'External Attack Surface', type: 'entry', x: 50, y: 150 },
      { id: '2', label: 'Service Enumeration', type: 'pivot', x: 200, y: 150 },
      { id: '3', label: 'Privilege Escalation', type: 'impact', x: 380, y: 150 }
    ],
    edges: [ 
      { source: '1', target: '2', label: 'Scan' }, 
      { source: '2', target: '3', label: 'Exploit' } 
    ]
  };
}

// =============================================================================
// 4. SUB-COMPONENTS
// =============================================================================

const CVSSCalculator = ({ theme }: { theme: AccentTheme }) => {
  const [vector, setVector] = useState<Record<string, string>>({ 
    AV: 'N', AC: 'L', PR: 'N', UI: 'N', S: 'U', C: 'H', I: 'H', A: 'H' 
  });
  
  const calculateScore = () => {
    let iss = 1 - (
      (1 - (CVSS_DEF.C.find(v=>v.id===vector.C)?.weight||0)) * (1 - (CVSS_DEF.I.find(v=>v.id===vector.I)?.weight||0)) * (1 - (CVSS_DEF.A.find(v=>v.id===vector.A)?.weight||0))
    );
    
    let impact = vector.S === 'U' 
      ? 6.42 * iss 
      : 7.52 * (iss - 0.029) - 3.25 * Math.pow((iss - 0.02), 15);
      
    let prWeight = CVSS_DEF.PR.find(v=>v.id===vector.PR)?.weight || 0;
    if (vector.S === 'C' && vector.PR === 'L') prWeight = 0.68; 
    if (vector.S === 'C' && vector.PR === 'H') prWeight = 0.50;
    
    let expl = 8.22 * (CVSS_DEF.AV.find(v=>v.id===vector.AV)?.weight||0) * (CVSS_DEF.AC.find(v=>v.id===vector.AC)?.weight||0) * prWeight * (CVSS_DEF.UI.find(v=>v.id===vector.UI)?.weight||0);
      
    if (impact <= 0) return 0.0;
    
    let base = vector.S === 'U' 
      ? Math.min(impact + expl, 10) 
      : Math.min(1.08 * (impact + expl), 10);
      
    return Math.ceil(base * 10) / 10;
  };

  const score = calculateScore();
  const severity = score === 0 ? 'NONE' : score < 4.0 ? 'LOW' : score < 7.0 ? 'MEDIUM' : score < 9.0 ? 'HIGH' : 'CRITICAL';
  
  const sevColor = severity === 'CRITICAL' 
    ? 'text-rose-500' 
    : severity === 'HIGH' 
      ? 'text-amber-500' 
      : severity === 'MEDIUM' 
        ? 'text-yellow-400' 
        : 'text-emerald-500';

  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col font-sans bg-[#0a0a0c] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
      
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-4">
        <div className="flex items-center gap-3">
          <Hash className={`size-6 ${THEME_MAP[theme].text}`} />
          <h2 className="text-2xl font-medium text-white tracking-tight">CVSS 3.1 Calculator</h2>
        </div>
        
        <div className={`flex items-center gap-4 px-6 py-3 rounded-2xl border ${THEME_MAP[theme].border} bg-black/50 shadow-2xl`}>
          <div className="flex flex-col items-end">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">Base Score</span>
            <span className={`text-3xl font-bold font-mono ${sevColor}`}>{score.toFixed(1)}</span>
          </div>
          <div className={`h-10 w-px bg-white/10`}></div>
          <div className={`px-3 py-1 rounded text-xs font-bold tracking-widest ${sevColor} bg-white/5 border border-current`}>
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
                {metric === 'AV' ? 'Attack Vector' : metric === 'AC' ? 'Attack Complexity' : metric === 'PR' ? 'Privileges Required' : 'User Interaction'}
              </label>
              <div className="flex flex-wrap gap-2">
                {CVSS_DEF[metric as keyof CVSSMetrics].map(val => (
                  <button 
                    key={val.id} 
                    onClick={() => setVector(p => ({...p, [metric]: val.id}))} 
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
                {metric === 'S' ? 'Scope' : metric === 'C' ? 'Confidentiality' : metric === 'I' ? 'Integrity' : 'Availability'}
              </label>
              <div className="flex flex-wrap gap-2">
                {CVSS_DEF[metric as keyof CVSSMetrics].map(val => (
                  <button 
                    key={val.id} 
                    onClick={() => setVector(p => ({...p, [metric]: val.id}))} 
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
          Vector String: <span className="text-white">CVSS:3.1/{Object.entries(vector).map(([k, v]) => `${k}:${v}`).join('/')}</span>
        </span>
        <button className="px-3 py-1 bg-white/10 hover:bg-white/20 rounded text-white flex items-center gap-2">
          <Copy size={12}/> Copy Vector
        </button>
      </div>
    </div>
  )
}

const BugBountyForge = ({ theme, targets }: { theme: AccentTheme, targets: string[] }) => {
  const defaultTarget = targets.length > 0 ? targets[0] : 'vulnerable-domain.com';
  
  const [report, setReport] = useState(
    `## Summary\nAn unauthenticated Information Disclosure vulnerability was discovered in ${defaultTarget}...\n\n## Description\nDue to improper access controls on the REST API endpoint, sensitive metadata is exposed.\n\n## Steps To Reproduce\n1. Run \`curl -X GET https://${defaultTarget}/api/v1/metadata\`\n2. Observe the leaked tokens in the JSON-response.\n\n## Impact\nAttackers can leverage these tokens to pivot into the internal network.`
  );

  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col font-sans bg-[#0a0a0c]">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileText className={`size-6 ${THEME_MAP[theme].text}`} />
          <h2 className="text-2xl font-medium text-white tracking-tight">Bug Bounty Forge</h2>
        </div>
        <div className="flex gap-2">
           <button className="bg-[#111116] border border-white/10 text-white px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider hover:bg-white/5">
             HackerOne Format
           </button>
           <button className="bg-[#111116] border border-white/10 text-white px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider hover:bg-white/5">
             Bugcrowd Format
           </button>
        </div>
      </div>
      
      <div className="flex-1 bg-[#111116] border border-white/10 rounded-2xl flex flex-col overflow-hidden shadow-inner">
        <div className="bg-zinc-950 border-b border-white/5 p-3 flex items-center gap-4 text-xs font-mono text-zinc-400">
          <span className="flex items-center gap-2">
            <Crosshair size={14} className={THEME_MAP[theme].text}/> 
            Target: 
            <input 
              type="text" 
              defaultValue={defaultTarget} 
              className="bg-transparent text-white outline-none border-b border-white/20 px-1 w-48"
            />
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
  )
}

const AdvancedTerminal = ({ logs, theme, onCommand }: { logs: string[], theme: AccentTheme, onCommand: (cmd: string) => void }) => {
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
           <h2 className="text-2xl font-sans font-medium text-white tracking-tight">Advanced TTY Sandbox</h2>
         </div>
         <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-3 py-1 rounded text-[10px] font-mono uppercase tracking-widest flex items-center gap-2">
           <div className="size-2 bg-emerald-500 rounded-full animate-pulse"/> 
           root@kali-sandbox
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
          <span className={`${THEME_MAP[theme].text} font-bold`}>root@hexical:~#</span>
          <input 
            type="text" 
            value={input} 
            onChange={e=>setInput(e.target.value)} 
            onKeyDown={handleKeyDown} 
            className="flex-1 bg-transparent outline-none text-white placeholder:text-zinc-700" 
            placeholder="nmap -sC -sV target.local..." 
            autoFocus 
          />
        </div>
      </div>
    </div>
  )
}

const AttackGraphVisualizer = ({ graph, theme }: { graph: AttackGraph, theme: AccentTheme }) => {
  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col bg-[#0a0a0c]">
      <div className="flex items-center justify-between mb-6">
         <div className="flex items-center gap-3">
           <Workflow className={`size-6 ${THEME_MAP[theme].text}`} />
           <h2 className="text-2xl font-sans font-medium text-white tracking-tight">Attack Path Topology</h2>
         </div>
         <button className="flex items-center gap-2 text-xs font-mono text-zinc-400 hover:text-white bg-white/5 px-3 py-1.5 rounded">
           <RefreshCw size={12}/> Redraw Graph
         </button>
      </div>
      
      <div className="flex-1 border border-white/10 rounded-2xl bg-[#111116] relative overflow-hidden shadow-inner">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-white/[0.03] to-transparent bg-[length:30px_30px]" style={{ backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.04) 1.5px, transparent 1.5px)' }}></div>
        <svg className="w-full h-full absolute inset-0">
          {graph.edges.map((edge, i) => {
            const s = graph.nodes.find(n => n.id === edge.source)!;
            const t = graph.nodes.find(n => n.id === edge.target)!;
            return (
              <g key={i}>
                <line 
                  x1={s.x + 70} 
                  y1={s.y + 25} 
                  x2={t.x} 
                  y2={t.y + 25} 
                  stroke="rgba(255,255,255,0.15)" 
                  strokeWidth="2" 
                  strokeDasharray="4 4" 
                  className="animate-pulse"
                />
                <text 
                  x={(s.x + t.x) / 2 + 35} 
                  y={(s.y + t.y) / 2 + 15} 
                  fill="rgba(255,255,255,0.5)" 
                  fontSize="10" 
                  fontFamily="monospace" 
                  textAnchor="middle"
                >
                  {edge.label}
                </text>
              </g>
            )
          })}
        </svg>
        
        {graph.nodes.map(node => (
          <div 
            key={node.id} 
            className={`absolute flex flex-col items-center justify-center p-3 rounded-xl border backdrop-blur-md shadow-2xl transition-all duration-300 hover:scale-110 hover:z-20 cursor-crosshair z-10 w-[140px]
            ${node.type === 'entry' ? 'bg-blue-500/10 border-blue-500/30 text-blue-400 shadow-blue-900/20' 
              : node.type === 'vuln' ? 'bg-rose-500/10 border-rose-500/30 text-rose-400 shadow-rose-900/20' 
              : node.type === 'pivot' ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 shadow-amber-900/20' 
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 shadow-emerald-900/20'}`}
            style={{ left: node.x, top: node.y }}
          >
            {node.type === 'entry' ? <Globe size={20} className="mb-2 opacity-80"/> 
              : node.type === 'vuln' ? <Bug size={20} className="mb-2 opacity-80"/> 
              : node.type === 'pivot' ? <GitMerge size={20} className="mb-2 opacity-80"/> 
              : <Target size={20} className="mb-2 opacity-80"/>}
            <span className="text-[11px] font-bold text-center font-sans leading-tight">{node.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const ReconDashboard = ({ targets, theme }: { targets: string[]; theme: AccentTheme }) => {
  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col bg-[#0a0a0c] overflow-y-auto">
      <div className="flex items-center gap-3 mb-6">
        <Network className={`size-6 ${THEME_MAP[theme].text}`} />
        <div>
          <h2 className="text-2xl font-medium text-white tracking-tight">Recon Dashboard</h2>
          <p className="text-sm text-zinc-400 max-w-xl">Attack surface mapping, target enumeration, and asset analysis for the current session.</p>
        </div>
      </div>
      
      <div className="grid gap-6 xl:grid-cols-[1.4fr_0.6fr]">
        <div className="bg-[#111116] border border-white/10 rounded-2xl p-6 shadow-inner">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-zinc-500 font-semibold">Discovered Targets</p>
              <h3 className="text-xl font-semibold text-white mt-2">{targets.length} entities</h3>
            </div>
            <span className={`text-[10px] uppercase tracking-widest font-bold ${THEME_MAP[theme].text}`}>
              Live Scan
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
                No targets have been extracted from the current payload yet.
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
              <li className="rounded-2xl bg-white/5 p-3">Switch to <span className="text-white">Payloads</span> for encoded injection vectors.</li>
              <li className="rounded-2xl bg-white/5 p-3">Use <span className="text-white">Topology</span> to visualize attack flow.</li>
              <li className="rounded-2xl bg-white/5 p-3">Activate <span className="text-white">Trace Logs</span> for execution diagnostics.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

const PayloadMutator = ({ theme }: { theme: AccentTheme }) => {
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
        
        <div className="flex items-center gap-4 py-2">
          {(['url', 'base64', 'hex', 'unicode', 'rot13'] as EncodingType[]).map(type => (
            <button 
              key={type} 
              onClick={() => setEncType(type)} 
              className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                encType === type 
                  ? `${THEME_MAP[theme].bg} ${THEME_MAP[theme].text} border ${THEME_MAP[theme].border}` 
                  : 'bg-white/5 text-zinc-400 hover:text-white border border-transparent'
              }`}
            >
              {type}
            </button>
          ))}
          <ArrowRight className="text-zinc-600 ml-auto" />
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
  )
}

const ASTVisualizer = ({ theme }: { theme: AccentTheme }) => {
  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col font-sans bg-[#0a0a0c]">
      <div className="flex items-center gap-3 mb-6">
        <Code className={`size-6 ${THEME_MAP[theme].text}`} />
        <h2 className="text-2xl font-medium text-white tracking-tight">AST & Code Trace (Java/C++)</h2>
      </div>
      
      <div className="flex-1 bg-[#111116] border border-white/10 rounded-2xl flex overflow-hidden shadow-inner">
        <div className="w-12 bg-black border-r border-white/5 flex flex-col items-center py-4 text-xs font-mono text-zinc-700 select-none">
          {[1,2,3,4,5,6,7,8,9,10].map(n => <span key={n} className="h-6 flex items-center">{n}</span>)}
        </div>
        <div className="flex-1 p-4 overflow-y-auto font-mono text-sm leading-6 whitespace-pre">
          <span className="text-rose-400">public class</span> <span className="text-amber-200">SearchEngine</span> {'{\n'}
          {'    '}<span className="text-rose-400">public static int</span> <span className="text-blue-300">linearSearch</span>(<span className="text-emerald-300">int</span>[] arr, <span className="text-emerald-300">int</span> target) {'{\n'}
          {'        '}<span className="text-rose-400">for</span> (<span className="text-emerald-300">int</span> i = 0; i {'<'} arr.length; i++) {'{\n'}
          <div className="bg-amber-500/10 border-l-2 border-amber-500 -ml-4 pl-4 w-full">{'            '}<span className="text-rose-400">if</span> (arr[i] == target) {'{\n'}</div>
          <div className="bg-amber-500/10 border-l-2 border-amber-500 -ml-4 pl-4 w-full">{'                '}<span className="text-zinc-500 italic">// Potential timing attack vector via constant-time deviation</span>{'\n'}</div>
          <div className="bg-amber-500/10 border-l-2 border-amber-500 -ml-4 pl-4 w-full">{'                '}<span className="text-rose-400">return</span> i; {'\n'}</div>
          <div className="bg-amber-500/10 border-l-2 border-amber-500 -ml-4 pl-4 w-full">{'            '}{'}\n'}</div>
          {'        '}{'}\n'}
          {'        '}<span className="text-rose-400">return</span> -1;{'\n'}
          {'    '}{'}\n'}
          {'}'}
        </div>
        
        <div className="w-72 bg-black border-l border-white/5 p-4 flex flex-col gap-4">
          <h3 className="text-xs uppercase tracking-widest font-bold text-zinc-500 border-b border-white/10 pb-2">Analysis</h3>
          <div className="bg-amber-500/10 border border-amber-500/20 p-3 rounded-xl">
             <div className="text-amber-400 font-bold text-[10px] uppercase mb-1 flex items-center gap-1">
               <AlertTriangle size={10}/> Timing Leak
             </div>
             <div className="text-xs text-zinc-300">
               Early return in loops comparing secure arrays can leak data via execution time deviations.
             </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// 5. MAIN CONSOLE COMPONENT
// =============================================================================
export function HexicalConsole() {
  const { user, isLoaded } = useUser()
  const { session } = useSession()
  const { signOut, openSignIn, openUserProfile } = useClerk() 
  const { checkLimit, recordUsage } = useGuestLimit()

  // State Definitions (With Lazy Init Engine)
  const [chats, setChats] = useState<any[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false)
  const [busy, setBusy] = useState<boolean>(false)
  const [loadingPhase, setLoadingPhase] = useState<string>(PROCESSING_PHASES[0])
  const [viewMode, setViewMode] = useState<ViewMode>('chat')
  const [uiTheme, setUiTheme] = useState<AccentTheme>('cyan')
  
  // Terminal & Targeting State
  const [systemLogs, setSystemLogs] = useState<string[]>([
    '[SYSTEM] Kernel loaded.', 
    '[AUTH] Waiting for handshake...'
  ])
  const [targetScope, setTargetScope] = useState<string>('')
  const [extractedTargets, setExtractedTargets] = useState<string[]>([])
  const [activeGraph, setActiveGraph] = useState<AttackGraph>({nodes:[], edges:[]})

  // Profile & Config
  const [userName, setUserName] = useState<string>(DEFAULT_GUEST_NAME)
  const [userEmail, setUserEmail] = useState<string>(DEFAULT_GUEST_EMAIL)
  const [userAvatar, setUserAvatar] = useState<string | null>(null)
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true)
  const [isMounted, setIsMounted] = useState<boolean>(false)

  const [activeTraceMessage, setActiveTraceMessage] = useState<ExtendedStreamMessage | null>(null)
  const [showTracePanel, setShowTracePanel] = useState<boolean>(false)
  const [showRawJson, setShowRawJson] = useState<boolean>(false)
  const [activeProfileId, setActiveProfileId] = useState<string>(SECURITY_PROFILES[0].id)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(WORKSPACES[0].id)
  
  // Settings Modals & Toggles
  const [showProfileMenu, setShowProfileMenu] = useState<boolean>(false)
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState<boolean>(false)
  const [showUpgradeModal, setShowUpgradeModal] = useState<boolean>(false)
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false)
  const [settingsTab, setSettingsTab] = useState<'identity' | 'telemetry' | 'engine' | 'appearance'>('identity')
  
  // Advanced Engine Settings
  const [stealthMode, setStealthMode] = useState<boolean>(false)
  const [autoRedact, setAutoRedact] = useState<boolean>(true) 
  const [targetArch, setTargetArch] = useState<string>('linux')
  const [aggressiveness, setAggressiveness] = useState<string>('scan')
  const [bountyPlatform, setBountyPlatform] = useState<string>('hackerone')
  const [contextWindow, setContextWindow] = useState<string>('4096')
  const [maxConcurrency, setMaxConcurrency] = useState<string>('3')

  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const headerMenuRef = useRef<HTMLDivElement | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const logToTerminal = useCallback((msg: string) => {
    setSystemLogs(prev => [...prev, msg])
  }, []);

  const handleTerminalCommand = (cmd: string) => {
    logToTerminal(`$ ${cmd}`);
    const normalized = cmd.trim().toLowerCase();
    
    if (normalized.startsWith('nmap')) {
      setTimeout(() => logToTerminal(`Starting Nmap 7.94...`), 200);
      setTimeout(() => logToTerminal(`Nmap scan report for ${cmd.split(' ')[1] || 'target'}`), 800);
      setTimeout(() => logToTerminal(`PORT    STATE SERVICE\n80/tcp   open  http\n443/tcp  open  https\n8080/tcp open  http-proxy`), 1500);
    } else if (normalized.startsWith('ffuf')) {
      setTimeout(() => logToTerminal(`[WARN] Directory brute-forcing initiated. WAF detection likely.`), 300);
      setTimeout(() => logToTerminal(`[SUCCESS] Found: /api/v1/users (Status: 401)`), 1200);
      setTimeout(() => logToTerminal(`[SUCCESS] Found: /admin/dashboard (Status: 302)`), 1800);
    } else if (normalized.startsWith('curl')) {
      setTimeout(() => logToTerminal(`[HTTP] Sending GET request...`), 200);
      setTimeout(() => logToTerminal(`[WARN] 403 Forbidden - Request blocked by WAF.`), 600);
    } else if (normalized.startsWith('whoami')) {
      setTimeout(() => logToTerminal(`root`), 200);
    } else if (normalized === 'clear') {
      setSystemLogs([]);
    } else {
      logToTerminal(`[ERR] Command not found in WebContainer: ${cmd.split(' ')[0]}`);
    }
  }

  // ---------------------------------------------------------------------------
  // AUTH BRIDGE & CLOUD SYNC (WITH LAZY INIT PROTECTION)
  // ---------------------------------------------------------------------------
  const getAuthenticatedClient = useCallback(async () => {
    const token = await session?.getToken({ template: 'supabase' });
    return createSupabaseClient(token || undefined);
  }, [session])
  
  const syncToCloud = useCallback(async (updatedChats: any[], forceSync = false) => {
    if (!user || stealthMode) return;
    const activeChat = updatedChats.find(c => c.id === activeId);
    
    // DEVIL'S ADVOCATE CHECK: Do not sync empty lazy chats to database
    if (activeChat && (activeChat.messages.length > 1 || forceSync)) { 
      const client = await getAuthenticatedClient();
      if (!client) return;
      
      const { error } = await client.from('conversations').upsert({
        id: activeChat.id, 
        user_id: user.id, 
        title: activeChat.title, 
        pinned: activeChat.pinned
      });
      
      if (error) {
        logToTerminal(`[DB_ERR] Sync Convo: ${error.message}`);
      }
    }
  }, [user, stealthMode, activeId, getAuthenticatedClient, logToTerminal]);

  const handleNewChat = useCallback(() => {
    const existingEmpty = chats.find(c => c.messages.length <= 1);
    if (existingEmpty) { 
      setActiveId(existingEmpty.id); 
      setActiveTraceMessage(null); 
      return; 
    }

    const newId = generateUniqueID();
    const newChat = createFreshChatState(newId);
    
    setChats(prev => [newChat, ...prev]);
    setActiveId(newId);
    setActiveTraceMessage(null); 
    setExtractedTargets([]); 
    setActiveGraph({nodes:[], edges:[]});
    
    // Save to sessionStorage to survive F5 refreshes without polluting DB
    sessionStorage.setItem(PENDING_SESSION_ID, newId);
    logToTerminal(`[SYSTEM] Spawned isolated lazy context: ${newId}`);
  }, [chats, logToTerminal]);

  const handleDelete = useCallback(async (id: string) => {
    const next = chats.filter(c => c.id !== id);
    
    if (user && !stealthMode) {
        const client = await getAuthenticatedClient();
        await client?.from('conversations').delete().eq('id', id);
        logToTerminal(`[DB] Cryptographic purge of workspace data: ${id}`);
    }
    
    if (next.length === 0) {
      handleNewChat();
    } else {
        setChats(next);
        if (activeId === id) setActiveId(next[0].id);
    }
  }, [chats, activeId, user, stealthMode, getAuthenticatedClient, handleNewChat, logToTerminal]);

  // ---------------------------------------------------------------------------
  // LIFECYCLE HOOKS
  // ---------------------------------------------------------------------------
  useEffect(() => { 
    setIsMounted(true) 
  }, [])

  useEffect(() => { 
    if (window.innerWidth >= 768) setIsSidebarOpen(true) 
  }, [])
  
  useEffect(() => {
    if (isLoaded) {
      if (user) {
        setUserName(user.fullName || user.primaryEmailAddress?.emailAddress?.split('@')[0] || 'User')
        setUserEmail(user.primaryEmailAddress?.emailAddress || 'no-email@hexical.ai')
        setUserAvatar(user.imageUrl || null)
        logToTerminal(`[AUTH] Cloud token derived. Sync engine online.`);
      } else {
        setUserName(DEFAULT_GUEST_NAME); 
        setUserEmail(DEFAULT_GUEST_EMAIL); 
        setUserAvatar(null);
        logToTerminal(`[WARN] Ephemeral session. All telemetry and sync disabled.`);
      }
      setIsAuthLoading(false)
    }
  }, [isLoaded, user, logToTerminal])

  useEffect(() => {
    if (!isMounted || isAuthLoading) return;
    
    const initializeChats = async () => {
      if (!user) { 
        const fresh = createFreshChatState(generateUniqueID());
        setChats([fresh]); 
        setActiveId(fresh.id); 
        return; 
      }

      const supabaseAuth = await getAuthenticatedClient();
      const { data: convos, error: convoErr } = await supabaseAuth
        .from('conversations')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (convoErr) { 
        logToTerminal(`[DB_ERR] Failed to load sessions.`); 
        return; 
      }

      let formatted: any[] = [];
      if (convos && convos.length > 0) {
        const convoIds = convos.map(c => c.id);
        const { data: msgs } = await supabaseAuth
          .from('messages')
          .select('*')
          .in('conversation_id', convoIds)
          .order('created_at', { ascending: true });

        formatted = convos.map(c => ({
          id: c.id, 
          title: c.title, 
          pinned: c.pinned,
          messages: msgs ? msgs.filter(m => m.conversation_id === c.id).map(m => ({
              id: m.id, 
              role: m.role, 
              text: m.content, 
              ts: new Date(m.created_at).toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 2 }),
              steps: m.role === 'hexical' ? ['REHYDRATED_STATE'] : [], 
              valid: true
          })) : []
        }));

        formatted.forEach(c => { 
          if(c.messages.length === 0) c.messages = createFreshChatState(c.id).messages; 
        });
      }

      // Check Session Storage for a pending un-saved chat
      const pendingId = sessionStorage.getItem(PENDING_SESSION_ID);
      if (pendingId && !formatted.find(c => c.id === pendingId)) {
        formatted.unshift(createFreshChatState(pendingId));
      }

      if (formatted.length === 0) {
        const freshId = generateUniqueID();
        formatted.push(createFreshChatState(freshId));
        sessionStorage.setItem(PENDING_SESSION_ID, freshId);
      }

      setChats(formatted); 
      setActiveId(prev => (prev && formatted.find(c => c.id === prev)) ? prev : formatted[0].id);
    };
    
    initializeChats();
  }, [isMounted, isAuthLoading, user, getAuthenticatedClient, logToTerminal]);

  const activeChat = chats.find(c => c.id === activeId) || chats[0]

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    const hexMessages = activeChat?.messages.filter((m: any) => m.role === 'hexical' && m.steps?.length > 0)
    
    if (hexMessages && hexMessages.length > 0) {
      setActiveTraceMessage(hexMessages[hexMessages.length - 1])
    }
  }, [chats, activeId, busy, viewMode])

  useEffect(() => {
    let interval: NodeJS.Timeout
    if (busy && !loadingPhase.includes('Queue')) {
      let step = 0; 
      setLoadingPhase(PROCESSING_PHASES[0]);
      interval = setInterval(() => { 
        step = (step + 1) % PROCESSING_PHASES.length; 
        setLoadingPhase(PROCESSING_PHASES[step]); 
      }, 1500)
    }
    return () => clearInterval(interval)
  }, [busy, loadingPhase])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); setIsSidebarOpen(prev => !prev); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'i') { e.preventDefault(); if (activeTraceMessage) setShowTracePanel(prev => !prev); }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); setShowSettingsModal(true); }
      if ((e.metaKey || e.ctrlKey) && e.key === '1') { e.preventDefault(); setViewMode('chat'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '2') { e.preventDefault(); setViewMode('recon'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '3') { e.preventDefault(); setViewMode('payloads'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '4') { e.preventDefault(); setViewMode('graph'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '5') { e.preventDefault(); setViewMode('ast'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '6') { e.preventDefault(); setViewMode('cvss'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '7') { e.preventDefault(); setViewMode('bounty'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '8') { e.preventDefault(); setViewMode('terminal'); }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTraceMessage])

  
  // ---------------------------------------------------------------------------
  // THE SWARM EXECUTION ENGINE (MAIN LOGIC) WITH POLLING & DB LAZY-WRITE
  // ---------------------------------------------------------------------------
  const handleSubmit = async (rawLogic: string) => {
    if (busy || !rawLogic.trim()) return

    if (!checkLimit()) {
      const systemWarning: ExtendedStreamMessage = { 
        id: generateUniqueID(), 
        role: 'hexical', 
        text: `**LOCKOUT:** Limit reached.`, 
        steps: ['GUEST_LIMIT_REACHED'], 
        valid: false, 
        route: 'auth_required' as any, 
        ts: generateTimestamp() 
      }
      setChats(prev => prev.map(c => c.id === activeId ? { ...c, messages: [...c.messages, { id: generateUniqueID(), role: 'user', text: rawLogic, ts: generateTimestamp() }, systemWarning] } : c))
      openSignIn(); 
      return;
    }

    const targets = extractTargetsFromLogic(rawLogic);
    if (targets.length > 0) { 
      setExtractedTargets(prev => Array.from(new Set([...prev, ...targets])).slice(0, 8)); 
      logToTerminal(`[RECON] Extracted ${targets.length} valid entities from AST flow.`); 
    }
    
    const safeLogic = sanitizeLocalPayload(rawLogic, autoRedact);
    if (safeLogic !== rawLogic) {
      logToTerminal(`[SEC] Zero-Knowledge Regex triggered. Secrets stripped prior to transit.`);
    }

    const userMsg: ExtendedStreamMessage = { 
      id: generateUniqueID(), 
      role: 'user', 
      text: safeLogic, 
      ts: generateTimestamp() 
    }
    
    const currentChatContext = chats.find(c => c.id === activeId) || chats[0];
    const isNewChat = currentChatContext.messages.length <= 1;
    const generatedTitle = isNewChat ? safeLogic.split(' ').slice(0, 4).join(' ') + '...' : currentChatContext.title;
    const updatedUserMessages = [...currentChatContext.messages, userMsg];

    setChats(prev => prev.map(c => c.id === activeId ? { ...c, title: generatedTitle, messages: updatedUserMessages } : c))
    setBusy(true); 
    logToTerminal(`[TX] Transmitting heuristic model to remote cluster...`);

    // DEVIL'S ADVOCATE: Force create the database row ONLY on the first submitted message
    if (user && !stealthMode) {
      const supabaseAuth = await getAuthenticatedClient();
      if (isNewChat) {
        await supabaseAuth.from('conversations').upsert({ 
          id: activeId, 
          user_id: user.id, 
          title: generatedTitle, 
          pinned: currentChatContext.pinned 
        });
        sessionStorage.removeItem(PENDING_SESSION_ID); 
      }
      await supabaseAuth.from('messages').insert({ 
        id: userMsg.id, 
        conversation_id: activeId, 
        user_id: user.id, 
        content: safeLogic, 
        role: 'user' 
      });
    }
    
    const startTime = performance.now()

    try {
      const res = await fetch('/api/verify', {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          logic: safeLogic, 
          profile: activeProfileId, 
          workspace: activeWorkspaceId, 
          targetArch, 
          autoRedact, 
          aggressiveness, 
          targetScope, 
          extractedTargets,
          bountyPlatform, 
          maxConcurrency, 
          contextWindow
        })
      });
      
      const initData = await res.json();
      let finalData = initData;

      if (initData.status === 'queued') {
        const jobId = initData.job_id;
        logToTerminal(`[QUEUE] Assigned Job ID: ${jobId}. Position: ${initData.position}`);
        setLoadingPhase(`In Queue (Position: ${initData.position})...`);

        let isPolling = true;
        while (isPolling) {
          if (abortControllerRef.current?.signal.aborted) {
            logToTerminal(`[SYSTEM] User aborted request.`); 
            setBusy(false); 
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 1500));
          
          try {
            const statusRes = await fetch(`http://localhost:8000/status/${jobId}`); 
            const statusData = await statusRes.json();

            if (statusData.status === 'queued') { 
              setLoadingPhase(`In Queue (Position: ${statusData.position})...`); 
            } else if (statusData.status === 'processing') { 
              setLoadingPhase('Executing payload...'); 
            } else if (statusData.status === 'completed' || statusData.status === 'error') {
              finalData = statusData.data; 
              isPolling = false;
            } else if (statusData.status === 'not_found') { 
              throw new Error("Job lost in server queue."); 
            }
          } catch (pollErr) { 
            logToTerminal(`[ERR] Polling error. Retrying...`); 
          }
        }
      }
      
      const executionTimeMs = Math.round(performance.now() - startTime)
      const mockMetrics: TraceMetrics = finalData.metrics || { 
        latencyMs: executionTimeMs, 
        tokensUsed: Math.floor(Math.random() * 1200) + 350, 
        confidenceScore: finalData.valid ? 98.4 : 62.1 
      }
      const newGraph = parseAttackGraph(safeLogic); 
      setActiveGraph(newGraph);

      const swarmData: SwarmEvaluation = {
        redTeam: { confidence: 94.2, logic: "Found unauthenticated data exposure via API.", payloadSuggested: "curl -X GET /api/v1/config" },
        blueTeam: { mitigation: "Implement strict RBAC on the config endpoint.", blockedBy: ["None"], riskLevel: "CRITICAL" },
        architect: { route: "API Gateway", architecturalFlaw: "Bypass of reverse proxy auth middleware" },
        finalConsensus: finalData.valid
      }

      logToTerminal(`[RX] Received evaluated payload. Status: ${finalData.valid ? 'SUCCESS' : 'WARN'}. Computation Time: ${executionTimeMs}ms.`);

      const hexMsg: ExtendedStreamMessage = { 
        id: generateUniqueID(), 
        role: 'hexical', 
        text: finalData.analysis, 
        steps: finalData.steps, 
        valid: finalData.valid, 
        route: inferRoute(finalData.steps), 
        ts: generateTimestamp(), 
        sources: [{ name: 'Swarm Consensus DB', verified: true, type: 'heuristic' }], 
        isVerifiedContent: finalData.valid, 
        metrics: mockMetrics, 
        swarmConsensus: swarmData, 
        graphData: newGraph
      }

      const updatedAIMessages = [...updatedUserMessages, hexMsg];
      setChats(prev => prev.map(c => c.id === activeId ? { ...c, title: generatedTitle, messages: updatedAIMessages } : c))
      setActiveTraceMessage(hexMsg)
      
      if (user && !stealthMode) {
        const supabaseAuth = await getAuthenticatedClient();
        await supabaseAuth.from('messages').insert({ 
          id: hexMsg.id, 
          conversation_id: activeId, 
          user_id: user.id, 
          content: finalData.analysis, 
          role: 'hexical' 
        });
      }
      recordUsage()
    } catch (err) { 
      logToTerminal(`[ERR] Pipeline crash during remote execution.`); 
    } finally { 
      setBusy(false) 
    }
  }

  if (!isMounted) return null
  
  const activeProfile = SECURITY_PROFILES.find(p => p.id === activeProfileId) || SECURITY_PROFILES[0]
  const activeWorkspace = WORKSPACES.find(w => w.id === activeWorkspaceId) || WORKSPACES[0]

  function getContextualGreeting() {
    const hour = new Date().getHours()
    const timePhrase = hour < 6 ? 'Night shift' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
    return `${timePhrase}, ${activeProfile?.name} ready for ${activeWorkspace?.name} diagnostics`
  }

  function handleRename(id: string, newTitle: string): void { 
    // Implementation placeholder for future chat renaming
  }

  function handleTogglePin(id: string): void {
    setChats(prev => {
      const updated = prev.map(chat => chat.id === id ? { ...chat, pinned: !chat.pinned } : chat)
      const toggledChat = updated.find(chat => chat.id === id)
      
      if (toggledChat && user && !stealthMode) {
        void (async () => {
          try {
            const supabaseAuth = await getAuthenticatedClient()
            await supabaseAuth.from('conversations').upsert({ 
              id: toggledChat.id, 
              user_id: user.id, 
              title: toggledChat.title, 
              pinned: toggledChat.pinned 
            })
          } catch (error) { 
            logToTerminal(`[WARN] Failed to sync pin state for chat ${id}.`) 
          }
        })()
      }
      return updated
    })
  }

  return (
    <>
      {showUpgradeModal && <UpgradeModal onClose={() => setShowUpgradeModal(false)} />}
      
      {/* ---------------- SETTINGS MODAL ---------------- */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in font-sans">
          <div className="w-full max-w-5xl bg-[#0a0a0c] border border-white/10 rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.5)] flex flex-col md:flex-row overflow-hidden h-[85vh] md:h-[650px]">
            
            <div className="w-full md:w-64 bg-[#111116] border-r border-white/5 flex flex-col p-4 space-y-2 shrink-0">
              <div className="flex items-center gap-2 mb-6 px-2">
                <HexicalLogo className={`size-5 ${THEME_MAP[uiTheme].text}`} />
                <h3 className="text-white font-semibold uppercase tracking-wider text-xs">System Config</h3>
              </div>
              <button 
                onClick={() => setSettingsTab('identity')} 
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${settingsTab === 'identity' ? `${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} border ${THEME_MAP[uiTheme].border}` : 'text-zinc-400 hover:bg-white/5 border border-transparent'}`}
              >
                <UserCircle size={16} /> Identity & Access
              </button>
              <button 
                onClick={() => setSettingsTab('telemetry')} 
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${settingsTab === 'telemetry' ? `${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} border ${THEME_MAP[uiTheme].border}` : 'text-zinc-400 hover:bg-white/5 border border-transparent'}`}
              >
                <Fingerprint size={16} /> Telemetry & Sec
              </button>
              <button 
                onClick={() => setSettingsTab('engine')} 
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${settingsTab === 'engine' ? `${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} border ${THEME_MAP[uiTheme].border}` : 'text-zinc-400 hover:bg-white/5 border border-transparent'}`}
              >
                <TerminalSquare size={16} /> Engine Params
              </button>
              <button 
                onClick={() => setSettingsTab('appearance')} 
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${settingsTab === 'appearance' ? `${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} border ${THEME_MAP[uiTheme].border}` : 'text-zinc-400 hover:bg-white/5 border border-transparent'}`}
              >
                <SlidersHorizontal size={16} /> UI / Theming
              </button>
            </div>

            <div className="flex-1 flex flex-col relative bg-[#0a0a0c]">
              <button 
                onClick={() => setShowSettingsModal(false)} 
                className="absolute top-4 right-4 z-10 p-2 bg-white/5 hover:bg-white/10 rounded-full text-zinc-400 hover:text-white transition-colors"
              >
                <X size={18} />
              </button>
              
              <div className="p-8 overflow-y-auto flex-1 font-sans">
                
                {settingsTab === 'identity' && (
                  <div className="space-y-8 animate-fade-in">
                    <div>
                      <h4 className="text-xl text-white font-medium mb-1">Identity & Access</h4>
                    </div>
                    <div className="flex items-center gap-4 bg-white/5 p-4 rounded-xl border border-white/5">
                      {userAvatar ? (
                        <img src={userAvatar} alt="Profile" className="w-16 h-16 rounded-full border border-white/10" />
                      ) : (
                        <div className={`w-16 h-16 rounded-full flex items-center justify-center font-bold text-xl ${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} border ${THEME_MAP[uiTheme].border}`}>
                          {userName.charAt(0)}
                        </div>
                      )}
                      <div className="flex-1">
                        <div className="text-white font-medium">{userName}</div>
                        <div className="text-zinc-400 text-sm">{userEmail}</div>
                      </div>
                      <button 
                        onClick={() => user ? openUserProfile() : openSignIn()} 
                        className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white text-sm rounded-lg font-medium"
                      >
                        {user ? 'Manage Auth' : 'Log In'}
                      </button>
                    </div>
                  </div>
                )}
                
                {settingsTab === 'telemetry' && (
                  <div className="space-y-8 animate-fade-in">
                    <div>
                      <h4 className="text-xl text-white font-medium mb-1">Telemetry & Client Security</h4>
                    </div>
                    <div className="space-y-6">
                      <div className="flex items-start justify-between border-b border-white/5 pb-6">
                         <div className="pr-8">
                           <div className="text-emerald-400 font-medium text-sm mb-1 flex items-center gap-2">
                             <Regex size={16} /> 
                             Local Payload Sanitization 
                             <span className="bg-emerald-500/20 text-emerald-400 text-[9px] px-1.5 py-0.5 rounded border border-emerald-500/30">ACTIVE</span>
                           </div>
                           <div className="text-zinc-500 text-xs leading-relaxed">
                             Client-side Regex automatically scrubs IPs, API keys, and JWTs prior to LLM transmission.
                           </div>
                         </div>
                         <button 
                           onClick={() => setAutoRedact(!autoRedact)} 
                           className={`shrink-0 transition-colors ${autoRedact ? THEME_MAP[uiTheme].text : 'text-zinc-600'}`}
                         >
                           {autoRedact ? <ToggleRight size={36} /> : <ToggleLeft size={36} />}
                         </button>
                      </div>
                      <div className="flex items-start justify-between border-b border-white/5 pb-6">
                         <div className="pr-8">
                           <div className={`font-medium text-sm mb-1 flex items-center gap-2 ${THEME_MAP[uiTheme].text}`}>
                             <Ghost size={16}/> 
                             Ephemeral Ghost Mode 
                             {stealthMode && <span className={`flex h-2 w-2 rounded-full animate-pulse ${THEME_MAP[uiTheme].bg.replace('/10','')} opacity-100`}></span>}
                           </div>
                           <div className="text-zinc-500 text-xs leading-relaxed">
                             Bypass Supabase synchronization entirely. Sessions exist purely in the DOM.
                           </div>
                         </div>
                         <button 
                           onClick={() => setStealthMode(!stealthMode)} 
                           className={`shrink-0 transition-colors ${stealthMode ? THEME_MAP[uiTheme].text : 'text-zinc-600'}`}
                         >
                           {stealthMode ? <ToggleRight size={36} /> : <ToggleLeft size={36} />}
                         </button>
                      </div>
                    </div>
                  </div>
                )}
                
                {settingsTab === 'engine' && (
                  <div className="space-y-8 animate-fade-in">
                    <div>
                      <h4 className="text-xl text-white font-medium mb-1">Execution Engine Parameters</h4>
                    </div>
                    <div className="space-y-6">
                      
                      <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl">
                        <label className="text-white font-medium text-sm mb-3 flex items-center gap-2">
                          <Target size={14} className={THEME_MAP[uiTheme].text}/> Virtual Target Architecture
                        </label>
                        <select 
                          value={targetArch} 
                          onChange={(e) => setTargetArch(e.target.value)} 
                          className={`w-full bg-black border border-white/10 text-zinc-300 text-sm rounded-lg p-2.5 outline-none focus:border-${uiTheme}-500/50`}
                        >
                          <option value="linux">Linux (x86_64 / ELF)</option>
                          <option value="windows">Windows NT (PE)</option>
                          <option value="web">Web Application / API</option>
                        </select>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl">
                          <label className="text-white font-medium text-sm mb-3 flex items-center gap-2">
                            <LayersIcon size={14} className={THEME_MAP[uiTheme].text}/> Bounty Format
                          </label>
                          <select 
                            value={bountyPlatform} 
                            onChange={(e) => setBountyPlatform(e.target.value)} 
                            className={`w-full bg-black border border-white/10 text-zinc-300 text-sm rounded-lg p-2.5 outline-none focus:border-${uiTheme}-500/50`}
                          >
                            <option value="hackerone">HackerOne Markdown</option>
                            <option value="bugcrowd">Bugcrowd Markdown</option>
                            <option value="raw">Raw JSON Output</option>
                          </select>
                        </div>
                        <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl">
                          <label className="text-white font-medium text-sm mb-3 flex items-center gap-2">
                            <CpuIcon size={14} className={THEME_MAP[uiTheme].text}/> Max Concurrency
                          </label>
                          <select 
                            value={maxConcurrency} 
                            onChange={(e) => setMaxConcurrency(e.target.value)} 
                            className={`w-full bg-black border border-white/10 text-zinc-300 text-sm rounded-lg p-2.5 outline-none focus:border-${uiTheme}-500/50`}
                          >
                            <option value="1">1 Thread (Safe)</option>
                            <option value="3">3 Threads (Balanced)</option>
                            <option value="5">5 Threads (Aggressive)</option>
                          </select>
                        </div>
                      </div>
                      
                      <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl">
                        <label className="text-white font-medium text-sm mb-3 flex items-center gap-2">
                          <Layers size={14} className={THEME_MAP[uiTheme].text}/> LLM Context Window
                        </label>
                        <select 
                          value={contextWindow} 
                          onChange={(e) => setContextWindow(e.target.value)} 
                          className={`w-full bg-black border border-white/10 text-zinc-300 text-sm rounded-lg p-2.5 outline-none focus:border-${uiTheme}-500/50`}
                        >
                          <option value="2048">2048 Tokens (Fast Recon)</option>
                          <option value="4096">4096 Tokens (Standard Analysis)</option>
                          <option value="8192">8192 Tokens (Deep AST Inspection)</option>
                        </select>
                      </div>

                    </div>
                  </div>
                )}
                
                {settingsTab === 'appearance' && (
                  <div className="space-y-8 animate-fade-in">
                    <div>
                      <h4 className="text-xl text-white font-medium mb-1">Terminal Theming</h4>
                    </div>
                    <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl">
                      <label className="text-white font-medium text-sm mb-4 block">Accent Color Injection Profile</label>
                      <div className="flex gap-4">
                         {(['cyan', 'emerald', 'rose', 'violet', 'amber'] as AccentTheme[]).map(theme => (
                           <button 
                             key={theme} 
                             onClick={() => setUiTheme(theme)} 
                             className={`size-10 rounded-full border-2 transition-all ${uiTheme === theme ? `border-white scale-110 shadow-[0_0_15px_rgba(255,255,255,0.2)]` : 'border-transparent hover:scale-105'}`}
                           >
                             <div className={`w-full h-full rounded-full ${theme === 'cyan' ? 'bg-cyan-500' : theme === 'emerald' ? 'bg-emerald-500' : theme === 'rose' ? 'bg-rose-500' : theme === 'violet' ? 'bg-violet-500' : 'bg-amber-500'}`} />
                           </button>
                         ))}
                      </div>
                    </div>
                  </div>
                )}

              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- MAIN UI LAYOUT ---------------- */}
      <div className={`flex h-screen w-full bg-[#0a0a0c] text-foreground overflow-hidden font-mono selection:${THEME_MAP[uiTheme].bg}`}>
        
        {isSidebarOpen && (
          <>
            <div 
              className="fixed inset-0 bg-black/80 backdrop-blur-sm z-40 md:hidden" 
              onClick={() => setIsSidebarOpen(false)} 
            />
            <div className="fixed md:relative w-[280px] h-full border-r border-white/5 flex-shrink-0 z-50 bg-[#0a0a0c] shadow-[20px_0_50px_rgba(0,0,0,0.5)] md:shadow-none transition-transform">
               <ChatSidebar 
                 chats={chats} 
                 activeId={activeId} 
                 isOpen={isSidebarOpen} 
                 userName={isAuthLoading ? "Booting..." : userName} 
                 userEmail={isAuthLoading ? "Securing..." : userEmail} 
                 avatarUrl={userAvatar} 
                 onToggleOpen={() => setIsSidebarOpen(false)} 
                 onSelect={setActiveId} 
                 onNewChat={handleNewChat} 
                 onDeleteChat={handleDelete} 
                 onRenameChat={handleRename} 
                 onTogglePin={handleTogglePin} 
                 onSignOut={() => signOut(() => window.location.reload())} 
                 onOpenSettings={() => setShowSettingsModal(true)} 
               />
            </div>
          </>
        )}

        <main className="flex-1 flex flex-col relative bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-zinc-950 via-[#0a0a0c] to-[#0a0a0c] min-w-0 overflow-hidden">
          
          <header className="relative z-[50] flex shrink-0 h-16 items-center justify-between gap-3 border-b border-white/5 bg-[#0a0a0c]/80 px-4 md:px-6 backdrop-blur-md">
            <div className="flex items-center gap-3 min-w-0" ref={headerMenuRef}>
              {!isSidebarOpen && (
                <button 
                  onClick={() => setIsSidebarOpen(true)} 
                  className="flex items-center gap-3 hover:bg-white/5 p-2 rounded-xl transition-all"
                >
                  <HexicalLogo className={`size-6 ${THEME_MAP[uiTheme].text}`} />
                </button>
              )}
              <div className="h-6 w-px bg-white/10 mx-1 hidden md:block"></div>

              <div className="hidden lg:flex p-1 bg-white/[0.02] border border-white/5 rounded-lg backdrop-blur-md">
                <button onClick={() => setViewMode('chat')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'chat' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}><LayoutDashboard size={14}/> Core</button>
                <button onClick={() => setViewMode('graph')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'graph' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}><Workflow size={14}/> Topology</button>
                <button onClick={() => setViewMode('payloads')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'payloads' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}><Zap size={14}/> Payloads</button>
                <button onClick={() => setViewMode('bounty')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'bounty' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}><FileText size={14}/> Forge</button>
                <button onClick={() => setViewMode('ast')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'ast' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}><Code size={14}/> AST</button>
                <button onClick={() => setViewMode('cvss')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'cvss' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}><Hash size={14}/> CVSS</button>
                <button onClick={() => setViewMode('terminal')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'terminal' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}><Terminal size={14}/> TTY</button>
              </div>

              {extractedTargets.length > 0 && viewMode === 'chat' && (
                <div className="hidden xl:flex items-center gap-2 ml-2 pl-3 border-l border-white/10">
                  <span className={`text-[9px] ${THEME_MAP[uiTheme].text} uppercase tracking-widest font-bold`}>Targets</span>
                  {extractedTargets.slice(0,3).map((target, idx) => (
                    <span 
                      key={idx} 
                      className={`${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} border ${THEME_MAP[uiTheme].border} px-2 py-1 rounded text-[10px] font-mono`}
                    >
                      {target}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <div className="relative">
                <button 
                  onClick={() => { setShowProfileMenu(!showProfileMenu); setShowWorkspaceMenu(false); }} 
                  className="flex items-center gap-2 bg-white/[0.02] hover:bg-white/[0.06] border border-white/10 px-3 py-1.5 rounded-lg transition-all text-xs font-sans"
                >
                  <activeProfile.icon className={`size-3.5 ${activeProfile.color}`} />
                  <span className="font-medium text-foreground/80">{activeProfile.name}</span>
                  <ChevronDown className="size-3 text-muted-foreground ml-1" />
                </button>
                
                {showProfileMenu && (
                  <div className="absolute top-full right-0 mt-2 w-64 bg-[#111116] border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-fade-in">
                    <div className="p-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-white/5">
                      Active Agent Override
                    </div>
                    <div className="p-1">
                      {SECURITY_PROFILES.map(profile => (
                        <button 
                          key={profile.id} 
                          onClick={() => { setActiveProfileId(profile.id); setShowProfileMenu(false); }} 
                          className={`w-full flex items-start gap-3 p-2.5 rounded-lg text-left transition-all ${activeProfileId === profile.id ? 'bg-white/5' : 'hover:bg-white/5'}`}
                        >
                          <profile.icon className={`size-4 mt-0.5 ${profile.color}`} />
                          <div className="flex-1">
                            <div className={`font-sans font-medium text-xs ${activeProfileId === profile.id ? 'text-white' : 'text-foreground/80'}`}>
                              {profile.name}
                            </div>
                            <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
                              {profile.description}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {activeTraceMessage && activeTraceMessage.steps && activeTraceMessage.steps.length > 0 && viewMode === 'chat' && (
                <button 
                  onClick={() => setShowTracePanel(!showTracePanel)} 
                  title="Inspect Logic (Cmd+I)" 
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-sans border transition-all shadow-lg ${showTracePanel ? `${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].border} text-white` : 'bg-white/5 border-white/10 hover:border-white/20 text-muted-foreground hover:text-white backdrop-blur-md'}`}
                >
                  <Eye className="size-3.5" />
                  <span className="hidden sm:inline">{showTracePanel ? 'Close Inspector' : 'Trace Logs'}</span>
                  <kbd className="hidden md:inline-flex items-center gap-1 font-mono text-[9px] opacity-50 ml-2 border border-current rounded px-1">
                    <Command className="size-2.5"/> I
                  </kbd>
                </button>
              )}
            </div>
          </header>

          <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 flex flex-col">
            {viewMode === 'recon' && <div className="p-4 md:p-6"><ReconDashboard targets={extractedTargets} theme={uiTheme} /></div>}
            {viewMode === 'cvss' && <div className="p-4 md:p-6"><CVSSCalculator theme={uiTheme} /></div>}
            {viewMode === 'graph' && <div className="p-4 md:p-6"><AttackGraphVisualizer graph={activeGraph} theme={uiTheme} /></div>}
            {viewMode === 'payloads' && <div className="p-4 md:p-6"><PayloadMutator theme={uiTheme} /></div>}
            {viewMode === 'bounty' && <div className="p-4 md:p-6"><BugBountyForge theme={uiTheme} targets={extractedTargets} /></div>}
            {viewMode === 'ast' && <div className="p-4 md:p-6"><ASTVisualizer theme={uiTheme} /></div>}
            {viewMode === 'terminal' && <div className="p-4 md:p-6 h-full"><div className="mx-auto h-full max-w-5xl"><AdvancedTerminal logs={systemLogs} theme={uiTheme} onCommand={handleTerminalCommand} /></div></div>}

            {viewMode === 'chat' && (
              <div className="flex-1 flex flex-col justify-end px-2 md:px-6 py-6 max-w-3xl mx-auto w-full">
                {activeChat?.messages.length <= 1 ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-center my-auto min-h-[50vh]">
                    <div className="mb-8 relative flex justify-center">
                      <div className={`absolute inset-0 bg-${THEME_MAP[uiTheme].accent}-500 blur-[80px] opacity-20 rounded-full w-48 h-48 m-auto`} />
                      <HexicalLogo className={`size-16 relative z-10 ${THEME_MAP[uiTheme].text}`} />
                    </div>
                    <h2 className="text-2xl md:text-4xl font-sans mb-8 text-foreground tracking-tight leading-relaxed">
                      {isAuthLoading ? (
                        <span className="flex items-center justify-center gap-3 text-muted-foreground text-xl">
                          <Loader2 className={`animate-spin size-6 ${THEME_MAP[uiTheme].text}`} /> 
                          Securing session bounds...
                        </span>
                      ) : (
                        <>
                          {getContextualGreeting()}, 
                          <span className={`font-semibold drop-shadow-[0_0_15px_rgba(255,255,255,0.1)] ${THEME_MAP[uiTheme].text}`}>
                            {userName}
                          </span>.
                        </>
                      )}
                    </h2>
                  </div>
                ) : (
                  <div className="flex flex-col pb-4">
                   <DataStream messages={activeChat?.messages ?? []} busy={busy} />
                    <div ref={messagesEndRef} className="h-6 shrink-0" />
                  </div>
                )}
              </div>
            )}
          </div>

          {viewMode === 'chat' && (
            <footer className="shrink-0 border-t border-white/5 bg-[#0a0a0c]/95 px-4 pb-6 pt-3 backdrop-blur-xl z-[40]">
              <div className="mx-auto max-w-3xl flex flex-col">
                <div className={`mb-2 flex justify-center transition-all duration-300 ${busy ? 'h-8 opacity-100' : 'h-0 opacity-0 overflow-hidden'}`}>
                  <div className={`flex items-center gap-2 text-xs font-mono px-4 py-1.5 rounded-full border backdrop-blur-md ${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} ${THEME_MAP[uiTheme].border}`}>
                    <Activity className="size-3 animate-pulse" /> 
                    {loadingPhase}
                  </div>
                </div>
                
                <div className={`rounded-3xl border border-white/10 bg-black/60 backdrop-blur-3xl shadow-[0_0_30px_rgba(0,0,0,0.5)] focus-within:border-${THEME_MAP[uiTheme].accent}-500/50 transition-all`}>
                  <div className="flex items-center gap-2 mb-2 px-4 pt-3">
                    <div className={`flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-semibold px-2 py-1 rounded border ${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} ${THEME_MAP[uiTheme].border}`}>
                      <Crosshair size={10} /> 
                      Scope:
                    </div>
                    <input 
                      type="text" 
                      placeholder="e.g. optimizely.com or vercel.app" 
                      value={targetScope} 
                      onChange={(e) => setTargetScope(e.target.value)} 
                      className="bg-transparent text-xs text-zinc-300 placeholder:text-zinc-600 outline-none flex-1 font-mono" 
                    />
                  </div>
                  <div className="px-1 pb-1">
                     <CommandInput 
                       onSubmit={handleSubmit} 
                       busy={busy} 
                       onStop={() => abortControllerRef.current?.abort()} 
                     />
                  </div>
                </div>
              </div>
            </footer>
          )}
        </main>

        {/* ================= SWARM & TRACE INSPECTOR SPLIT PANE ================= */}
        {showTracePanel && activeTraceMessage && viewMode === 'chat' && (
          <div className="w-[380px] md:w-[450px] h-full border-l border-white/5 bg-[#0a0a0c]/95 backdrop-blur-3xl flex flex-col overflow-hidden animate-fade-in flex-shrink-0 z-40 shadow-[-20px_0_50px_rgba(0,0,0,0.5)]">
            
            <div className="p-4 border-b border-white/10 flex items-center justify-between bg-black/40">
              <div className="flex items-center gap-2">
                <SearchCode className={`size-4 ${THEME_MAP[uiTheme].text}`} />
                <span className="text-xs uppercase font-bold tracking-widest text-foreground">Advanced Diagnostics</span>
              </div>
              <button 
                onClick={() => setShowTracePanel(false)} 
                className="p-1 hover:bg-white/10 rounded-md text-muted-foreground hover:text-white transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-5 space-y-6 text-xs scrollbar-thin scrollbar-thumb-white/10">
              
              {activeTraceMessage.swarmConsensus && (
                <div className="space-y-3">
                   <span className="text-muted-foreground block font-sans text-[10px] uppercase tracking-wider font-semibold border-b border-white/5 pb-2 flex items-center gap-2">
                     <GitMerge size={12}/> Multi-Agent Swarm Consensus
                   </span>
                   
                   <div className="p-3 bg-rose-500/5 border border-rose-500/20 rounded-xl relative overflow-hidden group">
                     <div className="absolute top-0 right-0 bg-rose-500/20 text-rose-400 text-[8px] px-2 py-0.5 rounded-bl-lg font-bold">
                       RED TEAM (OFFENSIVE)
                     </div>
                     <div className="font-mono text-rose-300/80 mb-2 leading-relaxed mt-2">
                       "{activeTraceMessage.swarmConsensus.redTeam.logic}"
                     </div>
                     <div className="flex items-center justify-between bg-black/40 p-2 rounded border border-rose-500/10">
                       <span className="text-rose-400/50">Exploit Confidence</span>
                       <span className="text-rose-400 font-bold">{activeTraceMessage.swarmConsensus.redTeam.confidence}%</span>
                     </div>
                   </div>

                   <div className="p-3 bg-cyan-500/5 border border-cyan-500/20 rounded-xl relative overflow-hidden group">
                     <div className="absolute top-0 right-0 bg-cyan-500/20 text-cyan-400 text-[8px] px-2 py-0.5 rounded-bl-lg font-bold">
                       BLUE TEAM (DEFENSIVE)
                     </div>
                     <div className="font-mono text-cyan-300/80 mb-2 leading-relaxed mt-2">
                       "{activeTraceMessage.swarmConsensus.blueTeam.mitigation}"
                     </div>
                     <div className="flex items-center justify-between bg-black/40 p-2 rounded border border-cyan-500/10">
                       <span className="text-cyan-400/50">Calculated Risk Level</span>
                       <span className="text-cyan-400 font-bold">{activeTraceMessage.swarmConsensus.blueTeam.riskLevel}</span>
                     </div>
                   </div>
                </div>
              )}

              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 shadow-inner flex justify-between items-start mt-6">
                <div>
                  <span className="text-muted-foreground block mb-2 font-sans text-[10px] uppercase tracking-wider font-semibold">
                    Inferred Inference Route
                  </span>
                  <span className={`font-mono text-[11px] px-2 py-1 rounded-md ${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} border ${THEME_MAP[uiTheme].border}`}>
                    {activeTraceMessage.route || 'default_eval'}
                  </span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-muted-foreground block mb-1 font-sans text-[10px] uppercase tracking-wider font-semibold">
                    Security Status
                  </span>
                  {activeTraceMessage.isVerifiedContent ? 
                    <span className="text-emerald-400 font-sans text-[10px] font-bold flex items-center gap-1 bg-emerald-950/40 border border-emerald-500/20 px-2 py-1 rounded-md">
                      <CheckCircle size={12}/> VERIFIED
                    </span> : 
                    <span className="text-amber-400 font-sans text-[10px] font-bold flex items-center gap-1 bg-amber-950/40 border border-amber-500/20 px-2 py-1 rounded-md">
                      <AlertTriangle size={12}/> UNVERIFIED
                    </span>
                  }
                </div>
              </div>

              {activeTraceMessage.metrics && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-black/30 border border-white/5 rounded-lg p-2 flex flex-col items-center justify-center text-center">
                    <Timer size={14} className="text-zinc-500 mb-1" />
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-sans">Latency</span>
                    <span className="text-white font-mono text-xs">{activeTraceMessage.metrics.latencyMs}ms</span>
                  </div>
                  <div className="bg-black/30 border border-white/5 rounded-lg p-2 flex flex-col items-center justify-center text-center">
                    <Cpu size={14} className="text-zinc-500 mb-1" />
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-sans">Tokens</span>
                    <span className="text-white font-mono text-xs">{activeTraceMessage.metrics.tokensUsed}</span>
                  </div>
                  <div className="bg-black/30 border border-white/5 rounded-lg p-2 flex flex-col items-center justify-center text-center">
                    <ShieldCheck size={14} className="text-zinc-500 mb-1" />
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-sans">Confidence</span>
                    <span className={`${THEME_MAP[uiTheme].text} font-mono text-xs`}>{activeTraceMessage.metrics.confidenceScore}%</span>
                  </div>
                </div>
              )}

              <div className="border border-white/5 rounded-lg overflow-hidden bg-black/20">
                <button 
                  onClick={() => setShowRawJson(!showRawJson)} 
                  className="w-full p-3 flex justify-between items-center text-[10px] font-sans uppercase tracking-wider text-zinc-400 hover:text-white transition-colors bg-white/[0.02]"
                >
                  <span className="flex items-center gap-2">
                    <FileJson size={14}/> View Raw JSON Payload
                  </span>
                  <ChevronDown size={14} className={`transition-transform duration-300 ${showRawJson ? 'rotate-180' : ''}`} />
                </button>
                {showRawJson && (
                  <div className="p-3 border-t border-white/5 text-[9px] text-zinc-400 overflow-x-auto">
                    <pre>{JSON.stringify({ 
                      request_id: "req_" + generateUniqueID(), 
                      timestamp: activeTraceMessage.ts, 
                      route: activeTraceMessage.route, 
                      execution_metrics: activeTraceMessage.metrics, 
                      active_targets: extractedTargets 
                    }, null, 2)}</pre>
                  </div>
                )}
              </div>

              <div className="space-y-3 pt-2">
                <span className="text-muted-foreground block font-sans text-[10px] uppercase tracking-wider font-semibold border-b border-white/5 pb-2">
                  Execution Pipeline Logs
                </span>
                {activeTraceMessage.steps && activeTraceMessage.steps.length > 0 ? (
                  <div className="space-y-2 relative before:absolute before:inset-0 before:ml-[11px] before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-white/10 before:to-transparent">
                    {activeTraceMessage.steps.map((step: string, index: number) => (
                      <div 
                        key={index} 
                        className="relative flex items-start gap-3 p-3 rounded-lg bg-black/50 border border-white/5 font-mono text-[11px] text-muted-foreground leading-relaxed break-words hover:border-white/10 transition-colors group"
                      >
                        <div className={`absolute -left-1.5 top-3.5 size-3 bg-[#0a0a0c] border-2 rounded-full transition-all z-10 border-${THEME_MAP[uiTheme].accent}-500/50 group-hover:border-${THEME_MAP[uiTheme].accent}-400`} />
                        <div className="ml-2 w-full">
                          <span className={`${THEME_MAP[uiTheme].text} opacity-70 block mb-1 font-sans text-[9px] uppercase font-bold tracking-widest`}>
                            Step 0{index + 1}
                          </span>
                          <span className="text-foreground/80">{step}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-muted-foreground italic p-3 text-center border border-dashed border-white/10 rounded-xl bg-white/[0.01]">
                    No intermediary diagnostic chains reported.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}