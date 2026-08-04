'use client'

import { useEffect, useState } from 'react'
import {
  Settings,
  Shield,
  Key,
  CreditCard,
  Terminal,
  Webhook,
  Zap,
  Loader2,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
} from 'lucide-react'
import { UserProfile, useUser } from '@clerk/nextjs'

import UpgradeModal from '@/components/hexical/upgrade-modal'

type Tier = 'free' | 'go' | 'plus' | 'pro'

// Single source of truth for how each tier renders. Previously this was four
// separate ternary chains (border, label color, description, button color)
// that all branched on the same `activeTier` value — easy for one of them to
// drift out of sync when a tier is added or a copy change is made. Now
// there's exactly one place to update.
const TIER_META: Record<Tier, {
  label: string
  sub: string
  description: string
  border: string
  labelColor: string
  buttonClass: string
}> = {
  free: {
    label: 'FREE',
    sub: 'Base Node',
    description: 'Basic heuristic node access. Upgrade required for high-volume execution.',
    border: 'border-zinc-500/20 bg-zinc-500/5',
    labelColor: 'text-zinc-500',
    buttonClass: 'bg-white hover:bg-zinc-200 text-black',
  },
  go: {
    label: 'GO',
    sub: 'Active',
    description: 'Standard execution paths enabled. Limited to 5,000,000 operations.',
    border: 'border-emerald-500/20 bg-emerald-500/5',
    labelColor: 'text-emerald-500',
    buttonClass: 'bg-emerald-500 hover:bg-emerald-400 text-black',
  },
  plus: {
    label: 'PLUS',
    sub: 'Active',
    description: 'Advanced heuristics enabled. 7,000,000 operations per cycle.',
    border: 'border-blue-500/20 bg-blue-500/5',
    labelColor: 'text-blue-500',
    buttonClass: 'bg-blue-500 hover:bg-blue-400 text-white',
  },
  pro: {
    label: 'PRO',
    sub: 'Active',
    description: 'Multi-Agent Swarm logic unlocked. You have unlimited execution volume.',
    border: 'border-amber-500/20 bg-amber-500/5',
    labelColor: 'text-amber-500',
    buttonClass: 'bg-amber-500 hover:bg-amber-400 text-black',
  },
}

export default function SettingsPage() {
  const { user, isLoaded } = useUser()
  const [activeTab, setActiveTab] = useState<'identity' | 'api' | 'billing' | 'integrations'>('identity')

  const [activeTier, setActiveTier] = useState<Tier>('free')
  const [isFetchingTier, setIsFetchingTier] = useState(true)
  const [tierError, setTierError] = useState<string | null>(null)
  const [refreshIndex, setRefreshIndex] = useState(0)
  const [showUpgradeModal, setShowUpgradeModal] = useState(false)

  const [groqKey, setGroqKey] = useState('')
  const [isSavingKey, setIsSavingKey] = useState(false)
  const [keySaveMessage, setKeySaveMessage] = useState<string | null>(null)

  // Triggers a fresh read of the real tier. Called on mount and again after
  // a successful upgrade, so the badge updates without a full page reload.
  const refetchTier = () => setRefreshIndex((i) => i + 1)

  useEffect(() => {
    if (!isLoaded) return

    // No signed-in user (e.g. mid-redirect) — stop showing "Verifying..."
    // forever instead of leaving the spinner stuck.
    if (!user?.id) {
      setActiveTier('free')
      setIsFetchingTier(false)
      return
    }

    const controller = new AbortController()
    let isActive = true

    const fetchRealTier = async () => {
      try {
        setIsFetchingTier(true)
        setTierError(null)

        const res = await fetch('/api/user/profile', { signal: controller.signal })

        if (!res.ok) {
          throw new Error(`Profile request failed with status ${res.status}`)
        }

        const data = await res.json()
        if (isActive) {
          setActiveTier((data.tier as Tier) || 'free')
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') return
        console.error('[TIER_FETCH_ERROR]:', error)
        if (isActive) {
          setActiveTier('free')
          setTierError('Could not verify your license. Showing Free until this is resolved.')
        }
      } finally {
        if (isActive) setIsFetchingTier(false)
      }
    }

    fetchRealTier()

    return () => {
      isActive = false
      controller.abort()
    }
  }, [user, isLoaded, refreshIndex])

  const handleSaveGroqKey = async () => {
    if (!groqKey.trim()) return

    setIsSavingKey(true)
    setKeySaveMessage(null)

    try {
      const res = await fetch('/api/user/inference-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'groq', key: groqKey }),
      })

      if (!res.ok) {
        throw new Error(`Save failed with status ${res.status}`)
      }

      setKeySaveMessage('Saved. Your key is encrypted and will not be shown again.')
      setGroqKey('')
    } catch (error) {
      console.error('[SAVE_KEY_ERROR]:', error)
      setKeySaveMessage('Could not save your key. Try again.')
    } finally {
      setIsSavingKey(false)
    }
  }

  const meta = TIER_META[activeTier]

  return (
    <div className="p-6 md:p-10 max-w-6xl mx-auto space-y-8 bg-[#0a0a0c] min-h-screen text-foreground font-sans animate-fade-in relative">

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

          {/* TAB 1: IDENTITY */}
          {activeTab === 'identity' && (
            <div className="space-y-6 animate-fade-in">
              <div>
                <h2 className="text-xl font-semibold text-white">Identity Management</h2>
                <p className="text-sm text-muted-foreground mb-6">Manage your authentication states and multi-factor tokens.</p>
              </div>
              <div className="rounded-2xl overflow-hidden border border-white/10 shadow-2xl">
                <UserProfile
                  routing="hash"
                  appearance={{
                    variables: {
                      colorPrimary: '#06b6d4',
                      colorBackground: '#111116',
                      colorText: '#ffffff',
                      colorTextSecondary: '#a1a1aa',
                      colorInputBackground: '#0a0a0c',
                      colorInputText: '#ffffff',
                      colorDanger: '#f43f5e',
                    },
                    elements: {
                      rootBox: "w-full",
                      card: "bg-[#111116] border-none shadow-none w-full max-w-none rounded-none",
                      navbar: "hidden",
                      pageScrollBox: "p-6",
                      formButtonPrimary: "bg-cyan-500 hover:bg-cyan-400 text-black font-bold border-none",
                    }
                  }}
                />
              </div>
            </div>
          )}

          {/* TAB 2: API NODES */}
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
                    value={groqKey}
                    onChange={(e) => setGroqKey(e.target.value)}
                    placeholder="gsk_..."
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-2 w-full bg-black/50 border border-white/10 rounded-lg px-4 py-3 text-sm text-cyan-400 focus:outline-none focus:border-cyan-500/50 transition-colors"
                  />
                  <p className="text-xs text-muted-foreground mt-2">
                    Bypass Hexical limits by routing execution through your own Groq hardware node.
                    Your key is encrypted at rest and never displayed again after saving.
                  </p>
                </div>

                <div className="pt-4 flex items-center gap-3">
                  <button
                    onClick={handleSaveGroqKey}
                    disabled={isSavingKey || !groqKey.trim()}
                    className="px-6 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isSavingKey ? 'Saving...' : 'Save Configuration'}
                  </button>

                  {keySaveMessage && (
                    <span className={`flex items-center gap-1 text-xs ${keySaveMessage.startsWith('Saved') ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {keySaveMessage.startsWith('Saved') ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                      {keySaveMessage}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: INTEGRATIONS */}
          {activeTab === 'integrations' && (
            <div className="space-y-6 animate-fade-in">
              <div>
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                  <Webhook className="text-cyan-400" size={20}/> External Integrations
                </h2>
                <p className="text-sm text-muted-foreground mb-6">External integrations are not connected in this release. Connection controls remain unavailable until a server-backed integration is shipped.</p>
              </div>

              <div className="grid gap-4">
                <div className="p-5 rounded-xl border border-white/5 bg-white/[0.02] flex items-center justify-between group hover:border-white/10 transition-colors">
                  <div className="space-y-1">
                    <h3 className="font-semibold text-white">Evidence export integrations</h3>
                    <p className="text-xs text-muted-foreground">Planned server-backed export for engineering evidence and remediation records.</p>
                  </div>
                  <button disabled className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-xs font-bold tracking-wide text-zinc-500 cursor-not-allowed">
                    NOT AVAILABLE
                  </button>
                </div>

                <div className="p-5 rounded-xl border border-white/5 bg-white/[0.02] flex items-center justify-between group hover:border-white/10 transition-colors">
                  <div className="space-y-1">
                    <h3 className="font-semibold text-white">Project context integrations</h3>
                    <p className="text-xs text-muted-foreground">Planned server-backed project context synchronization. No repository connection is active.</p>
                  </div>
                  <button disabled className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-xs font-bold tracking-wide text-zinc-500 cursor-not-allowed">
                    NOT AVAILABLE
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

              <div className={`p-8 rounded-xl border flex flex-col md:flex-row items-start md:items-center justify-between gap-6 transition-colors ${meta.border}`}>
                <div>
                  <div className={`text-[10px] font-bold uppercase tracking-widest mb-1 ${meta.labelColor}`}>
                    Current License
                  </div>

                  {isFetchingTier ? (
                    <div className="flex items-center gap-2 text-white" aria-live="polite">
                      <Loader2 className="animate-spin text-zinc-500" size={24} />
                      <span className="text-xl font-bold">Verifying...</span>
                    </div>
                  ) : (
                    <div className="text-3xl font-bold text-white flex items-baseline gap-2" aria-live="polite">
                      {meta.label}
                      <span className="text-sm font-normal text-muted-foreground">/ {meta.sub}</span>
                    </div>
                  )}

                  <p className="text-sm text-zinc-400 mt-2">{meta.description}</p>

                  {tierError && (
                    <div className="flex items-center gap-2 mt-3 text-xs text-rose-400">
                      <AlertCircle size={14} />
                      <span>{tierError}</span>
                      <button
                        onClick={refetchTier}
                        className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-rose-300"
                      >
                        <RefreshCw size={12} /> Retry
                      </button>
                    </div>
                  )}
                </div>

                <button
                  onClick={() => setShowUpgradeModal(true)}
                  className={`px-6 py-3 font-bold rounded-lg text-sm transition-colors whitespace-nowrap ${meta.buttonClass}`}
                 >
                  {activeTier === 'pro' ? 'Manage License' : 'Upgrade License'}
                </button>
              </div>

              {showUpgradeModal && (
                <UpgradeModal
                  onClose={() => setShowUpgradeModal(false)}
                  onSuccess={() => {
                    setShowUpgradeModal(false)
                    refetchTier()
                  }}
                />
              )}
            </div>
          )}

        </main>
      </div>
    </div>
  )
}
