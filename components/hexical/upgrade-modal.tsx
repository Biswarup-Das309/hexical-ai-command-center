'use client'

import { useState, type ReactElement } from 'react'
import { useRouter } from 'next/navigation'
import Script from 'next/script'
import { toast } from 'sonner'
import type { LucideIcon } from 'lucide-react'
import { X, Sparkles, Shield, Network, Activity, TerminalSquare, Crosshair, FileJson, Zap, GitMerge, Target, FileBadge, Loader2, Mail, Phone } from 'lucide-react'
import { PLAN_CATALOG, PLAN_ORDER, type PlanDisplayConfig, type PlanFeatureIcon, type PlanFeatureTone, type PlanTier } from '@/lib/plans'

interface UpgradeModalProps {
  onClose: () => void
  onSuccess?: () => void
  currentTier?: PlanTier | 'enterprise'
}

type PlanCardUi = {
  cardClassName: string
  periodClassName: string
  descriptionClassName: string
  featuresClassName: string
  badgeClassName?: string
}

const FEATURE_ICONS: Record<PlanFeatureIcon, LucideIcon> = {
  activity: Activity,
  crosshair: Crosshair,
  fileBadge: FileBadge,
  fileJson: FileJson,
  gitMerge: GitMerge,
  network: Network,
  shield: Shield,
  sparkles: Sparkles,
  target: Target,
  terminal: TerminalSquare,
  zap: Zap,
}

const FEATURE_ICON_CLASSES: Record<PlanTier, Record<PlanFeatureTone, string>> = {
  free: {
    accent: 'text-muted-foreground shrink-0 mt-0.5',
    muted: 'text-muted-foreground shrink-0 mt-0.5',
  },
  go: {
    accent: 'text-emerald-400 shrink-0 mt-0.5',
    muted: 'text-muted-foreground shrink-0 mt-0.5',
  },
  plus: {
    accent: 'text-cyan-400 shrink-0 mt-0.5',
    muted: 'text-cyan-400 shrink-0 mt-0.5',
  },
  pro: {
    accent: 'text-amber-500 shrink-0 mt-0.5',
    muted: 'text-amber-500 shrink-0 mt-0.5',
  },
}

const PLAN_CARD_UI: Record<PlanTier, PlanCardUi> = {
  free: {
    cardClassName: 'bg-[#111116] border border-white/5 rounded-2xl p-6 flex flex-col hover:border-white/10 transition-colors relative',
    periodClassName: 'text-xs text-muted-foreground font-normal tracking-wide',
    descriptionClassName: 'text-sm text-muted-foreground mb-6 h-10',
    featuresClassName: 'space-y-4 text-sm text-foreground/80 flex-1 font-medium',
  },
  go: {
    cardClassName: 'bg-[#111116] border border-emerald-500/10 rounded-2xl p-6 flex flex-col hover:border-emerald-500/30 transition-colors',
    periodClassName: 'text-xs text-muted-foreground font-normal tracking-wide',
    descriptionClassName: 'text-sm text-muted-foreground mb-6 h-10',
    featuresClassName: 'space-y-4 text-sm text-foreground/80 flex-1 font-medium',
  },
  plus: {
    cardClassName: 'bg-[#111116] border border-cyan-500/50 rounded-2xl p-6 flex flex-col relative shadow-[0_0_30px_rgba(34,211,238,0.15)] hover:shadow-[0_0_40px_rgba(34,211,238,0.25)] transition-all',
    periodClassName: 'text-xs text-cyan-200/50 font-normal tracking-wide',
    descriptionClassName: 'text-sm text-cyan-200/70 mb-6 h-10',
    featuresClassName: 'space-y-4 text-sm text-white flex-1 font-medium',
    badgeClassName: 'absolute top-5 right-5 bg-cyan-500/20 text-cyan-400 text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full border border-cyan-500/30',
  },
  pro: {
    cardClassName: 'bg-[#111116] border border-amber-500/30 rounded-2xl p-6 flex flex-col relative shadow-[0_0_20px_rgba(245,158,11,0.05)] hover:border-amber-500/50 transition-colors',
    periodClassName: 'text-xs text-muted-foreground font-normal tracking-wide',
    descriptionClassName: 'text-sm text-muted-foreground mb-6 h-10',
    featuresClassName: 'space-y-4 text-sm text-foreground/80 flex-1 font-medium',
    badgeClassName: 'absolute top-5 right-5 bg-amber-500/10 text-amber-500 text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full border border-amber-500/20',
  },
}

// -----------------------------------------------------------------------------
// Enterprise contact details — update here if they ever change.
// -----------------------------------------------------------------------------
const ENTERPRISE_CONTACT_EMAIL = 'biswarup.das.0087@gmail.com'
const ENTERPRISE_CONTACT_PHONE_DISPLAY = '+91 81006 22939'
const ENTERPRISE_CONTACT_PHONE_TEL = '+918100622939'

function PricingCard({ action, plan }: { action: ReactElement; plan: PlanDisplayConfig }) {
  const ui = PLAN_CARD_UI[plan.tier]

  return (
    <div className={ui.cardClassName}>
      {plan.badge && ui.badgeClassName && <div className={ui.badgeClassName}>{plan.badge}</div>}

      <h3 className="text-xl font-semibold text-white mb-2">{plan.name}</h3>
      <div className="text-4xl text-white font-bold mb-2">
        {plan.priceLabel} <span className={ui.periodClassName}>/ month</span>
      </div>
      <p className={ui.descriptionClassName}>{plan.description}</p>

      {action}

      <div className={ui.featuresClassName}>
        {plan.includesLabel && (
          <div className="text-[10px] font-bold text-amber-500/80 uppercase tracking-widest mb-3">{plan.includesLabel}</div>
        )}

        {plan.features.map((feature) => {
          const Icon = FEATURE_ICONS[feature.icon]
          return (
            <div key={`${plan.tier}-${feature.text}`} className="flex items-start gap-3">
              <Icon size={18} className={FEATURE_ICON_CLASSES[plan.tier][feature.tone]} /> {feature.text}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function UpgradeModal({ onClose, onSuccess, currentTier = 'free' }: UpgradeModalProps) {
  const router = useRouter()
  const [billingCycle, setBillingCycle] = useState<'personal' | 'business'>('personal')
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null)
  const [isVerifying, setIsVerifying] = useState(false)
  const [errorFeedback, setErrorFeedback] = useState<string | null>(null)

  const activeTier = currentTier

  const handleUpgrade = async (plan: string) => {
    setLoadingPlan(plan)
    setErrorFeedback(null)

    try {
      if (typeof window === 'undefined' || !(window as { Razorpay?: unknown }).Razorpay) {
        throw new Error('Payment gateway is initializing. Please try again in a few seconds.')
      }

      const payloadTier = plan.toLowerCase()

      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: payloadTier }),
      })

      const orderData = await res.json()

      if (!res.ok || orderData.error) {
        throw new Error(orderData.error || 'Failed to provision checkout session infrastructure.')
      }

      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '',
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'Hexical AI',
        description: `Deployment Authorization: ${plan} Access Pass`,
        order_id: orderData.id,
        prefill: {
          name: orderData.userMeta?.name || 'Hexical Operative',
          email: orderData.userMeta?.email || '',
        },
        theme: { color: '#06b6d4' },
        handler: async function (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) {
          setIsVerifying(true)
          toast.loading('Verifying cryptographic signature...', { id: 'payment-verify' })

          try {
            const verifyRes = await fetch('/api/verify-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_signature: response.razorpay_signature,
                tier: payloadTier,
              }),
            })

            if (!verifyRes.ok) throw new Error('Signature verification rejected by infrastructure.')

            toast.success('Deployment Complete', {
              id: 'payment-verify',
              description: 'Database synced. Your new license is active.',
            })

            router.refresh()
            onSuccess?.()
            onClose()
          } catch {
            toast.error('Verification Failed', {
              id: 'payment-verify',
              description: 'Could not validate payment signature with the server.',
            })
            setIsVerifying(false)
            setLoadingPlan(null)
          }
        },
        modal: {
          ondismiss: function () {
            setLoadingPlan(null)
            setIsVerifying(false)
          },
        },
      }

      const RazorpayCtor = (window as unknown as { Razorpay: new (opts: unknown) => { open: () => void; on: (event: string, cb: (r: { error: { description: string } }) => void) => void } }).Razorpay
      const rzp = new RazorpayCtor(options)
      rzp.on('payment.failed', function (response) {
        toast.error('Transaction Rejected', { description: response.error.description })
        setLoadingPlan(null)
        setIsVerifying(false)
      })
      rzp.open()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unexpected error disrupted the checkout handshake.'
      console.error('[GATEWAY_INTERFACE_CRASH]:', err)
      toast.error('Checkout Failed', { description: message })
      setErrorFeedback(message)
      setLoadingPlan(null)
      setIsVerifying(false)
    }
  }

  const renderPlanAction = (tier: PlanTier) => {
    if (tier === 'free') {
      return activeTier === 'free' ? (
        <button className="w-full py-3 rounded-xl bg-white/5 text-muted-foreground font-medium mb-8 cursor-default border border-white/5 transition-colors">
          Current License
        </button>
      ) : (
        <button disabled className="w-full py-3 rounded-xl bg-transparent text-muted-foreground/30 font-medium mb-8 cursor-not-allowed border border-white/5 transition-colors">
          Included in Plan
        </button>
      )
    }

    if (tier === 'go') {
      return activeTier === 'go' ? (
        <button className="w-full py-3 rounded-xl bg-white/5 text-muted-foreground font-medium mb-8 cursor-default border border-white/5 transition-colors">
          Current License
        </button>
      ) : (
        <button
          onClick={() => handleUpgrade('Go')}
          disabled={loadingPlan !== null || activeTier === 'plus' || activeTier === 'pro' || activeTier === 'enterprise'}
          className="w-full py-3 rounded-xl bg-white/10 text-white hover:bg-white/20 font-medium mb-8 transition-colors flex items-center justify-center gap-2 border border-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loadingPlan === 'Go' ? (
            <>
              <Loader2 className="animate-spin" size={18} /> {isVerifying ? 'Verifying...' : 'Deploying...'}
            </>
          ) : activeTier === 'plus' || activeTier === 'pro' || activeTier === 'enterprise' ? (
            'Included in Plan'
          ) : (
            'Deploy Go'
          )}
        </button>
      )
    }

    if (tier === 'plus') {
      return activeTier === 'plus' ? (
        <button className="w-full py-3 rounded-xl bg-cyan-500/20 text-cyan-400 font-bold mb-8 cursor-default border border-cyan-500/30 transition-colors">
          Current License
        </button>
      ) : (
        <button
          onClick={() => handleUpgrade('Plus')}
          disabled={loadingPlan !== null || activeTier === 'pro' || activeTier === 'enterprise'}
          className="w-full py-3 rounded-xl bg-cyan-500 text-black hover:bg-cyan-400 font-bold mb-8 transition-colors shadow-lg shadow-cyan-500/20 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loadingPlan === 'Plus' ? (
            <>
              <Loader2 className="animate-spin text-black" size={18} /> {isVerifying ? 'Verifying...' : 'Deploying...'}
            </>
          ) : activeTier === 'pro' || activeTier === 'enterprise' ? (
            'Included in Plan'
          ) : (
            'Deploy Plus'
          )}
        </button>
      )
    }

    return activeTier === 'pro' ? (
      <button className="w-full py-3 rounded-xl bg-amber-500/20 text-amber-500 font-bold mb-8 cursor-default border border-amber-500/30 transition-colors">
        Current License
      </button>
    ) : (
      <button
        onClick={() => handleUpgrade('Pro')}
        disabled={loadingPlan !== null || activeTier === 'enterprise'}
        className="w-full py-3 rounded-xl bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 font-bold mb-8 transition-colors flex items-center justify-center gap-2 border border-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loadingPlan === 'Pro' ? (
          <>
            <Loader2 className="animate-spin" size={18} /> {isVerifying ? 'Verifying...' : 'Deploying...'}
          </>
        ) : activeTier === 'enterprise' ? (
          'Included in Enterprise'
        ) : (
          'Deploy Pro'
        )}
      </button>
    )
  }

  return (
    <>
      <Script id="razorpay-checkout-js" src="https://checkout.razorpay.com/v1/checkout.js" strategy="afterInteractive" />

      <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
        <div className="bg-[#0a0a0c] border border-white/10 w-full max-w-7xl max-h-[90vh] rounded-3xl flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.8)] overflow-hidden relative font-sans">
          <div className="flex flex-col items-center justify-center p-6 pb-4 shrink-0 relative bg-gradient-to-b from-[#111116] to-[#0a0a0c]">
            <button
              onClick={onClose}
              disabled={isVerifying}
              className="absolute right-6 top-6 p-2 rounded-full hover:bg-white/10 text-muted-foreground transition-colors disabled:opacity-50"
            >
              <X size={24} />
            </button>

            <h2 className="text-3xl font-bold text-white mb-2 tracking-tight">Unlock Premium Intelligence</h2>

            {errorFeedback && (
              <div className="text-xs font-semibold text-red-400 bg-red-500/10 border border-red-500/20 px-4 py-1.5 rounded-md mb-3 max-w-md text-center">
                {errorFeedback}
              </div>
            )}

            <div className="flex items-center bg-white/[0.03] p-1 rounded-xl border border-white/5 mt-2">
              <button
                onClick={() => setBillingCycle('personal')}
                disabled={isVerifying}
                className={`px-8 py-2 rounded-lg text-sm font-medium transition-all ${
                  billingCycle === 'personal' ? 'bg-white/[0.08] text-white shadow-sm' : 'text-muted-foreground hover:text-white'
                }`}
              >
                Researcher
              </button>
              <button
                onClick={() => setBillingCycle('business')}
                disabled={isVerifying}
                className={`px-8 py-2 rounded-lg text-sm font-medium transition-all ${
                  billingCycle === 'business' ? 'bg-white/[0.08] text-white shadow-sm' : 'text-muted-foreground hover:text-white'
                }`}
              >
                Enterprise Team
              </button>
            </div>
          </div>

          <div className="overflow-y-auto p-4 md:p-8 scrollbar-thin scrollbar-thumb-white/10 flex-1">
            {billingCycle === 'personal' ? (
              /* =========================================
                 STANDARD TIERS (Go, Plus, Pro)
                 ========================================= */
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
                {PLAN_ORDER.map((tier) => (
                  <PricingCard key={tier} action={renderPlanAction(tier)} plan={PLAN_CATALOG[tier]} />
                ))}
              </div>
            ) : (
              /* =========================================
                 ENTERPRISE TIER (Custom Node)
                 ========================================= */
              <div className="max-w-5xl mx-auto w-full bg-[#111116] border border-white/10 rounded-3xl p-8 md:p-12 relative overflow-hidden shadow-2xl">
                {/* Glow effect */}
                <div className="absolute top-0 right-0 -mr-32 -mt-32 w-96 h-96 bg-white/5 rounded-full blur-3xl pointer-events-none"></div>

                <div className="flex flex-col lg:flex-row gap-12 relative z-10">
                  <div className="flex-1 space-y-6">
                    <div className="inline-block bg-white/10 text-white text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full border border-white/20">
                      Custom Deployment
                    </div>
                    <h3 className="text-3xl md:text-4xl font-bold text-white tracking-tight">Hexical Enterprise Node</h3>
                    <p className="text-muted-foreground leading-relaxed text-sm md:text-base">
                      Designed for massive engineering teams. Bypass all rate limits, deploy custom routing architectures, and integrate directly into your private VPC. Connect with the founder directly to negotiate SLAs and data limits.
                    </p>

                    <div className="pt-4 pb-2">
                      <div className="text-3xl font-bold text-white mb-1">
                        Custom Pricing
                      </div>
                      <div className="text-xs text-muted-foreground tracking-wide uppercase">Custom volume based on SLA</div>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-3">
                      <a
                        href={`mailto:${ENTERPRISE_CONTACT_EMAIL}?subject=Hexical%20Enterprise%20Inquiry`}
                        className="px-8 py-4 rounded-xl bg-white text-black hover:bg-zinc-200 font-bold transition-colors shadow-[0_0_30px_rgba(255,255,255,0.15)] flex items-center justify-center gap-2"
                      >
                        <Mail size={18} /> Discuss Enterprise Access
                      </a>
                      <a
                        href={`tel:${ENTERPRISE_CONTACT_PHONE_TEL}`}
                        className="px-8 py-4 rounded-xl bg-white/5 text-white hover:bg-white/10 font-bold transition-colors border border-white/10 flex items-center justify-center gap-2"
                      >
                        <Phone size={18} /> Call the Founder
                      </a>
                    </div>

                    <div className="pt-2 space-y-1.5">
                      <a
                        href={`mailto:${ENTERPRISE_CONTACT_EMAIL}`}
                        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors w-fit"
                      >
                        <Mail size={14} /> {ENTERPRISE_CONTACT_EMAIL}
                      </a>
                      <a
                        href={`tel:${ENTERPRISE_CONTACT_PHONE_TEL}`}
                        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors w-fit"
                      >
                        <Phone size={14} /> {ENTERPRISE_CONTACT_PHONE_DISPLAY}
                      </a>
                    </div>
                  </div>

                  <div className="flex-1 bg-black/40 border border-white/5 rounded-2xl p-6 lg:p-8">
                    <h4 className="text-xs font-bold text-white/50 uppercase tracking-widest mb-6">Enterprise Capabilities</h4>
                    <div className="space-y-5">
                      {[
                        { icon: Network, text: 'Private VPC & On-Prem Deployment' },
                        { icon: Target, text: 'Custom LLM Routing & Agent Creation' },
                        { icon: Sparkles, text: 'Unlimited Concurrent Agents' },
                        { icon: Shield, text: 'SOC2 & HIPAA Compliance Logs' },
                        { icon: Zap, text: 'Massive 1M+ Character Payload Limits' },
                        { icon: Activity, text: 'Dedicated Founder Support & SLA' },
                      ].map((feature, i) => (
                        <div key={i} className="flex items-start gap-4 text-sm text-foreground/80 font-medium">
                          <feature.icon size={20} className="text-white shrink-0" />
                          {feature.text}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
