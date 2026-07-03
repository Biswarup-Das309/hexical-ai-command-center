'use client'

import { useState } from 'react'
import { Settings, Shield, Key, CreditCard, User, Terminal, Webhook, Zap } from 'lucide-react'
import { UserProfile, useUser } from '@clerk/nextjs'
import { dark } from '@clerk/themes'

export default function SettingsPage() {
  const { user, isLoaded } = useUser();
  const [activeTab, setActiveTab] = useState<'identity' | 'api' | 'billing' | 'integrations'>('identity')

  return (
    <div className="p-6 md:p-10 max-w-6xl mx-auto space-y-8 bg-[#0a0a0c] min-h-screen text-foreground font-sans animate-fade-in">
      
      {/* HEADER */}
      <div className="flex items-center gap-4 border-b border-white/5 pb-6">
        <div className="p-3 bg-cyan-500/10 rounded-xl border border-cyan-500/20">
          <Settings className="text-cyan-400 animate-spin-slow" size={28} />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">System Configuration</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your Hexical AI engine parameters, routing nodes, and active licenses.
          </p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-8">
        
        {/* SIDEBAR NAVIGATION */}
        <aside className="w-full md:w-64 flex-shrink-0 space-y-2">
          <button 
            onClick={() => setActiveTab('identity')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-medium ${activeTab === 'identity' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' : 'text-muted-foreground hover:bg-white/5 hover:text-white border border-transparent'}`}
          >
            <Shield size={18} /> Cryptographic Identity
          </button>
          
          <button 
            onClick={() => setActiveTab('api')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-medium ${activeTab === 'api' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' : 'text-muted-foreground hover:bg-white/5 hover:text-white border border-transparent'}`}
          >
            <Terminal size={18} /> Inference Nodes (API)
          </button>

          <button 
            onClick={() => setActiveTab('integrations')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-medium ${activeTab === 'integrations' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' : 'text-muted-foreground hover:bg-white/5 hover:text-white border border-transparent'}`}
          >
            <Webhook size={18} /> Bounty Webhooks
          </button>

          <button 
            onClick={() => setActiveTab('billing')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-medium ${activeTab === 'billing' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'text-muted-foreground hover:bg-white/5 hover:text-white border border-transparent'}`}
          >
            <CreditCard size={18} /> License & Billing
          </button>
        </aside>

        {/* MAIN CONTENT AREA */}
        <main className="flex-1 min-h-[600px]">
          
          {/* TAB 1: IDENTITY (Uses Clerk's Native Component) */}
          {activeTab === 'identity' && (
            <div className="space-y-6 animate-fade-in">
              <div>
                <h2 className="text-xl font-semibold text-white">Identity Management</h2>
                <p className="text-sm text-muted-foreground mb-6">Manage your authentication states and multi-factor tokens.</p>
              </div>
              <div className="rounded-2xl overflow-hidden border border-white/10 shadow-2xl">
                {/* We force Clerk into dark mode to match your Hexical aesthetic */}
                <UserProfile 
                  appearance={{
                    baseTheme: dark,
                    elements: {
                      rootBox: "w-full",
                      card: "bg-[#111116] border-none shadow-none w-full max-w-none rounded-none",
                      navbar: "hidden", // We hide Clerk's sidebar because we built our own!
                      pageScrollBox: "p-6",
                    }
                  }}
                />
              </div>
            </div>
          )}

          {/* TAB 2: API NODES (UI Setup for Groq/Backend Config) */}
          {activeTab === 'api' && (
            <div className="space-y-6 animate-fade-in">
              <div>
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                  <Key className="text-cyan-400" size={20}/> Custom Inference Routing
                </h2>
                <p className="text-sm text-muted-foreground mb-6">Override default Hexical servers with your own local LLM or API endpoints.</p>
              </div>
              
              <div className="p-6 rounded-xl border border-white/5 bg-white/[0.02] space-y-4">
                <div>
                  <label className="text-xs font-bold uppercase tracking-widest text-zinc-500">Groq API Override (Optional)</label>
                  <input 
                    type="password" 
                    placeholder="gsk_..." 
                    className="mt-2 w-full bg-black/50 border border-white/10 rounded-lg px-4 py-3 text-sm text-cyan-400 focus:outline-none focus:border-cyan-500/50 transition-colors"
                  />
                  <p className="text-xs text-muted-foreground mt-2">Bypass Hexical limits by routing execution through your own Groq hardware node.</p>
                </div>
                
                <div className="pt-4">
                  <button className="px-6 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm font-medium transition-colors">
                    Save Configuration
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: INTEGRATIONS (HackerOne / Bugcrowd) */}
          {activeTab === 'integrations' && (
            <div className="space-y-6 animate-fade-in">
              <div>
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                  <Webhook className="text-cyan-400" size={20}/> External Integrations
                </h2>
                <p className="text-sm text-muted-foreground mb-6">Link your vulnerability intelligence outputs directly to external platforms.</p>
              </div>
              
              <div className="grid gap-4">
                <div className="p-5 rounded-xl border border-white/5 bg-white/[0.02] flex items-center justify-between group hover:border-white/10 transition-colors">
                  <div className="space-y-1">
                    <h3 className="font-semibold text-white">HackerOne Automation</h3>
                    <p className="text-xs text-muted-foreground">Pipe generated exploit reports directly to your H1 drafts.</p>
                  </div>
                  <button className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-bold tracking-wide transition-colors">
                    CONNECT
                  </button>
                </div>

                <div className="p-5 rounded-xl border border-white/5 bg-white/[0.02] flex items-center justify-between group hover:border-white/10 transition-colors">
                  <div className="space-y-1">
                    <h3 className="font-semibold text-white">Bugcrowd Webhooks</h3>
                    <p className="text-xs text-muted-foreground">Sync target scope domains automatically from Bugcrowd briefs.</p>
                  </div>
                  <button className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-bold tracking-wide transition-colors">
                    CONNECT
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: BILLING */}
          {activeTab === 'billing' && (
            <div className="space-y-6 animate-fade-in">
              <div>
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                  <Zap className="text-amber-400" size={20}/> License & Tier Management
                </h2>
                <p className="text-sm text-muted-foreground mb-6">View your usage volume and manage your Hexical AI matrix access tier.</p>
              </div>
              
              <div className="p-8 rounded-xl border border-amber-500/20 bg-amber-500/5 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
                <div>
                  <div className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mb-1">Current License</div>
                  <div className="text-3xl font-bold text-white flex items-baseline gap-2">
                    PRO <span className="text-sm font-normal text-muted-foreground">/ Active</span>
                  </div>
                  <p className="text-sm text-zinc-400 mt-2">
                    Multi-Agent Swarm logic unlocked. You have unlimited execution volume.
                  </p>
                </div>
                
                <button 
                  onClick={() => alert("Redirecting to Razorpay/Stripe billing portal...")}
                  className="px-6 py-3 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded-lg text-sm transition-colors whitespace-nowrap"
                >
                  Manage Payment Method
                </button>
              </div>
            </div>
          )}

        </main>
      </div>
    </div>
  )
}