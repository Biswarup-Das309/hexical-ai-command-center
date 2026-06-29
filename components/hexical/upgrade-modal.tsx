'use client'

import { useState } from 'react'
import { 
  X, Check, Sparkles, MessageSquare, Image as ImageIcon, 
  Brain, Mic, TrendingUp, Bot, Search, MessageCircle, 
  Zap, FlaskConical, FolderGit2, Loader2 
} from 'lucide-react'

interface UpgradeModalProps {
  onClose: () => void
}

export function UpgradeModal({ onClose }: UpgradeModalProps) {
  const [billingCycle, setBillingCycle] = useState<'personal' | 'business'>('personal')
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null)

  // This handler simulates a payment initiation process
  const handleUpgrade = (plan: string) => {
    setLoadingPlan(plan)
    setTimeout(() => {
      setLoadingPlan(null)
      console.log(`Redirecting to payment for: ${plan}`)
    }, 2000)
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-[#111116] border border-white/10 w-full max-w-6xl max-h-[90vh] rounded-3xl flex flex-col shadow-2xl overflow-hidden relative font-sans">

        {/* Header Section */}
        <div className="flex flex-col items-center justify-center p-6 pb-4 shrink-0 relative bg-gradient-to-b from-[#0a0a0c] to-transparent">
          <button 
            onClick={onClose} 
            className="absolute right-6 top-6 p-2 rounded-full hover:bg-white/10 text-muted-foreground transition-colors"
          >
            <X size={24} />
          </button>
          
          <h2 className="text-3xl font-semibold text-white mb-6 tracking-tight">Upgrade your plan</h2>

          {/* Personal / Business Toggle */}
          <div className="flex items-center bg-white/[0.03] p-1 rounded-xl border border-white/5">
            <button
              onClick={() => setBillingCycle('personal')}
              className={`px-8 py-2 rounded-lg text-sm font-medium transition-all ${
                billingCycle === 'personal' 
                  ? 'bg-white/[0.08] text-white shadow-sm' 
                  : 'text-muted-foreground hover:text-white'
              }`}
            >
              Personal
            </button>
            <button
              onClick={() => setBillingCycle('business')}
              className={`px-8 py-2 rounded-lg text-sm font-medium transition-all ${
                billingCycle === 'business' 
                  ? 'bg-white/[0.08] text-white shadow-sm' 
                  : 'text-muted-foreground hover:text-white'
              }`}
            >
              Business
            </button>
          </div>
        </div>

        {/* Scrollable Pricing Content */}
        <div className="overflow-y-auto p-4 md:p-8 scrollbar-thin scrollbar-thumb-white/10 flex-1">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">

            {/* 1. FREE TIER */}
            <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-6 flex flex-col hover:bg-white/[0.04] transition-colors">
              <h3 className="text-2xl font-semibold text-white mb-2">Free</h3>
              <div className="text-4xl text-white font-semibold mb-2">
                ₹0 <span className="text-xs text-muted-foreground font-normal tracking-wide">INR / month</span>
              </div>
              <p className="text-sm text-muted-foreground mb-6 h-10">See what AI can do</p>
              
              <button className="w-full py-3 rounded-xl bg-white/5 text-muted-foreground font-medium mb-8 cursor-default border border-white/5 transition-colors">
                Your current plan
              </button>
              
              <div className="space-y-4 text-sm text-foreground/80 flex-1 font-medium">
                <div className="flex items-start gap-3"><Sparkles size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Core model</div>
                <div className="flex items-start gap-3"><MessageSquare size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Limited messages and uploads</div>
                <div className="flex items-start gap-3"><ImageIcon size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Limited image creation</div>
                <div className="flex items-start gap-3"><Brain size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Limited memory</div>
              </div>
            </div>

            {/* 2. GO TIER */}
            <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-6 flex flex-col hover:bg-white/[0.04] transition-colors">
              <h3 className="text-2xl font-semibold text-white mb-2">Go</h3>
              <div className="text-4xl text-white font-semibold mb-2">
                ₹299 <span className="text-xs text-muted-foreground font-normal tracking-wide">INR / month (inclusive of GST)</span>
              </div>
              <p className="text-sm text-muted-foreground mb-6 h-10">Keep chatting with expanded access</p>
              
              <button 
                onClick={() => handleUpgrade('Go')}
                disabled={loadingPlan === 'Go'}
                className="w-full py-3 rounded-xl bg-white text-black hover:bg-white/90 font-medium mb-8 transition-colors flex items-center justify-center gap-2"
              >
                {loadingPlan === 'Go' ? <Loader2 className="animate-spin" size={18} /> : 'Upgrade to Go'}
              </button>
              
              <div className="space-y-4 text-sm text-foreground/80 flex-1 font-medium">
                <div className="flex items-start gap-3"><Sparkles size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Core model</div>
                <div className="flex items-start gap-3"><MessageSquare size={18} className="text-muted-foreground shrink-0 mt-0.5" /> More messages and uploads</div>
                <div className="flex items-start gap-3"><ImageIcon size={18} className="text-muted-foreground shrink-0 mt-0.5" /> More image creation</div>
                <div className="flex items-start gap-3"><Brain size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Longer memory</div>
                <div className="flex items-start gap-3"><Mic size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Expanded voice mode</div>
              </div>
            </div>

            {/* 3. PLUS TIER (POPULAR) */}
            <div className="bg-[#1e293b]/40 border border-blue-500/40 rounded-2xl p-6 flex flex-col relative shadow-[0_0_30px_rgba(59,130,246,0.1)] hover:shadow-[0_0_40px_rgba(59,130,246,0.15)] transition-all">
              <div className="absolute top-5 right-5 bg-blue-500/20 text-blue-300 text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full border border-blue-500/20">
                Popular
              </div>
              
              <h3 className="text-2xl font-semibold text-white mb-2">Plus</h3>
              <div className="text-4xl text-white font-semibold mb-2">
                ₹1,599 <span className="text-xs text-blue-200/50 font-normal tracking-wide">INR / month (inclusive of GST)</span>
              </div>
              <p className="text-sm text-blue-200/70 mb-6 h-10">Unlock the full experience</p>
              
              <button 
                onClick={() => handleUpgrade('Plus')}
                disabled={loadingPlan === 'Plus'}
                className="w-full py-3 rounded-xl bg-blue-500 text-white hover:bg-blue-600 font-medium mb-8 transition-colors shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2"
              >
                {loadingPlan === 'Plus' ? <Loader2 className="animate-spin" size={18} /> : 'Upgrade to Plus'}
              </button>
              
              <div className="space-y-4 text-sm text-white flex-1 font-medium">
                <div className="flex items-start gap-3"><Sparkles size={18} className="text-blue-400 shrink-0 mt-0.5" /> Advanced models</div>
                <div className="flex items-start gap-3"><ImageIcon size={18} className="text-blue-400 shrink-0 mt-0.5" /> Advanced image creation with Thinking</div>
                <div className="flex items-start gap-3"><Brain size={18} className="text-blue-400 shrink-0 mt-0.5" /> Expanded memory across chats</div>
                <div className="flex items-start gap-3"><Bot size={18} className="text-blue-400 shrink-0 mt-0.5" /> Codex coding agent</div>
                <div className="flex items-start gap-3"><Search size={18} className="text-blue-400 shrink-0 mt-0.5" /> Expanded deep research</div>
                <div className="flex items-start gap-3"><FolderGit2 size={18} className="text-blue-400 shrink-0 mt-0.5" /> Projects and custom GPTs</div>
              </div>
            </div>

            {/* 4. PRO TIER */}
            <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-6 flex flex-col hover:bg-white/[0.04] transition-colors">
              <h3 className="text-2xl font-semibold text-white mb-2">Pro</h3>
              <div className="text-4xl text-white font-semibold mb-2">
                ₹9,599 <span className="text-xs text-muted-foreground font-normal tracking-wide">INR / month (inclusive of GST)</span>
              </div>
              <p className="text-sm text-muted-foreground mb-6 h-10">Maximize your productivity</p>
              
              <button 
                onClick={() => handleUpgrade('Pro')}
                disabled={loadingPlan === 'Pro'}
                className="w-full py-3 rounded-xl bg-white text-black hover:bg-white/90 font-medium mb-8 transition-colors flex items-center justify-center gap-2"
              >
                {loadingPlan === 'Pro' ? <Loader2 className="animate-spin" size={18} /> : 'Upgrade to Pro'}
              </button>
              
              <div className="space-y-4 text-sm text-foreground/80 flex-1 font-medium">
                <div className="text-xs font-bold text-white mb-3">Everything in Plus and:</div>
                <div className="flex items-start gap-3"><TrendingUp size={18} className="text-muted-foreground shrink-0 mt-0.5" /> 5x or 20x more usage than Plus</div>
                <div className="flex items-start gap-3"><Sparkles size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Frontier Pro model</div>
                <div className="flex items-start gap-3"><Bot size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Maximum access to Codex</div>
                <div className="flex items-start gap-3"><Search size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Maximum deep research</div>
                <div className="flex items-start gap-3"><MessageCircle size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Unlimited core chat</div>
                <div className="flex items-start gap-3"><Zap size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Unlimited and faster image creation</div>
                <div className="flex items-start gap-3"><Brain size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Maximum memory and context</div>
                <div className="flex items-start gap-3"><FlaskConical size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Early access to experimental features</div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}