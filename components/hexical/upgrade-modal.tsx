'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation' 
import Script from 'next/script' 
import { toast } from 'sonner' 
import { 
  X, Check, Sparkles, Shield, Network, Activity, 
  TerminalSquare, Crosshair, FileJson, Zap, GitMerge, 
  Target, FileBadge, Loader2
} from 'lucide-react'

interface UpgradeModalProps {
  onClose: () => void
  currentTier: string 
}

export function UpgradeModal({ onClose, currentTier }: UpgradeModalProps) {
  const router = useRouter()
  const [billingCycle, setBillingCycle] = useState<'personal' | 'business'>('personal')
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null)
  const [isVerifying, setIsVerifying] = useState(false) 
  const [errorFeedback, setErrorFeedback] = useState<string | null>(null)

  const activeTier = currentTier?.toLowerCase() || 'free'

  // ============================================================================
  // SECURE RAZORPAY FRONTEND TRIGGER
  // ============================================================================
  const handleUpgrade = async (plan: string) => {
    setLoadingPlan(plan);
    setErrorFeedback(null);

    try {
      if (typeof window === 'undefined' || !(window as any).Razorpay) {
        throw new Error("Payment gateway is initializing. Please try again in a few seconds.");
      }

      const payloadTier = plan.toLowerCase();

      // 1. Request a secure Order ID from your backend
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: payloadTier }),
      });

      const orderData = await res.json();

      if (!res.ok || orderData.error) {
        throw new Error(orderData.error || "Failed to provision checkout session infrastructure.");
      }

      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '', 
        amount: orderData.amount,
        currency: orderData.currency,
        name: "Hexical AI",
        description: `Deployment Authorization: ${plan} Access Pass`,
        order_id: orderData.id,
        prefill: {
          name: orderData.userMeta.name,
          email: orderData.userMeta.email,
        },
        theme: {
          color: "#06b6d4" 
        },
        // THE FIX: Cryptographic Verification Handshake
        handler: async function (response: any) {
          setIsVerifying(true);
          toast.loading("Verifying cryptographic signature...", { id: "payment-verify" });

          try {
            // Send the tokens back to your server to PROVE the payment is real
            const verifyRes = await fetch('/api/verify-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_signature: response.razorpay_signature,
                tier: payloadTier
              })
            });

            if (!verifyRes.ok) throw new Error("Signature verification failed.");

            toast.success("Deployment Complete", {
              id: "payment-verify",
              description: "Database synced. Your new license is active."
            });
            
            router.refresh(); 
            onClose(); 
          } catch (verifyErr) {
            toast.error("Verification Failed", {
              id: "payment-verify",
              description: "Could not validate payment signature with the server."
            });
            setIsVerifying(false);
            setLoadingPlan(null);
          }
        },
        modal: {
          ondismiss: function () {
            setLoadingPlan(null);
            setIsVerifying(false);
          }
        }
      };

      const rzp = new (window as any).Razorpay(options);
      rzp.on('payment.failed', function (response: any) {
        toast.error("Transaction Rejected", { description: response.error.description });
        setLoadingPlan(null);
        setIsVerifying(false);
      });
      rzp.open();

    } catch (err: any) {
      console.error("[GATEWAY_INTERFACE_CRASH]:", err);
      toast.error("Checkout Failed", { description: err.message });
      setErrorFeedback(err.message || "An unexpected error disrupted the checkout handshake.");
      setLoadingPlan(null); 
      setIsVerifying(false);
    }
  };

  return (
    <>
      {/* THE FIX: Load script before interactive so it's ready when the user clicks */}
      <Script 
        id="razorpay-checkout-js" 
        src="https://checkout.razorpay.com/v1/checkout.js" 
        strategy="beforeInteractive" 
      />

      <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
        <div className="bg-[#0a0a0c] border border-white/10 w-full max-w-7xl max-h-[90vh] rounded-3xl flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.8)] overflow-hidden relative font-sans">

          {/* Header Section */}
          <div className="flex flex-col items-center justify-center p-6 pb-4 shrink-0 relative bg-gradient-to-b from-[#111116] to-[#0a0a0c]">
            <button 
              onClick={onClose} 
              disabled={isVerifying} 
              className="absolute right-6 top-6 p-2 rounded-full hover:bg-white/10 text-muted-foreground transition-colors disabled:opacity-50"
            >
              <X size={24} />
            </button>
            
            <h2 className="text-3xl font-bold text-white mb-2 tracking-tight">Deploy Hexical Intelligence</h2>
            
            {errorFeedback && (
              <div className="text-xs font-semibold text-red-400 bg-red-500/10 border border-red-500/20 px-4 py-1.5 rounded-md mb-3 max-w-md text-center">
                {errorFeedback}
              </div>
            )}

            {/* Personal / Business Toggle */}
            <div className="flex items-center bg-white/[0.03] p-1 rounded-xl border border-white/5 mt-2">
              <button
                onClick={() => setBillingCycle('personal')}
                disabled={isVerifying}
                className={`px-8 py-2 rounded-lg text-sm font-medium transition-all ${
                  billingCycle === 'personal' 
                    ? 'bg-white/[0.08] text-white shadow-sm' 
                    : 'text-muted-foreground hover:text-white'
                }`}
              >
                Researcher
              </button>
              <button
                onClick={() => setBillingCycle('business')}
                disabled={isVerifying}
                className={`px-8 py-2 rounded-lg text-sm font-medium transition-all ${
                  billingCycle === 'business' 
                    ? 'bg-white/[0.08] text-white shadow-sm' 
                    : 'text-muted-foreground hover:text-white'
                }`}
              >
                Enterprise Team
              </button>
            </div>
          </div>

          {/* Scrollable Pricing Content */}
          <div className="overflow-y-auto p-4 md:p-8 scrollbar-thin scrollbar-thumb-white/10 flex-1">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">

              {/* 1. FREE TIER */}
              <div className="bg-[#111116] border border-white/5 rounded-2xl p-6 flex flex-col hover:border-white/10 transition-colors relative">
                <h3 className="text-xl font-semibold text-white mb-2">Sandbox</h3>
                <div className="text-4xl text-white font-bold mb-2">
                  ₹0 <span className="text-xs text-muted-foreground font-normal tracking-wide">/ month</span>
                </div>
                <p className="text-sm text-muted-foreground mb-6 h-10">Essential tools for code analysis.</p>
                
                {activeTier === 'free' ? (
                  <button className="w-full py-3 rounded-xl bg-white/5 text-muted-foreground font-medium mb-8 cursor-default border border-white/5 transition-colors">
                    Current License
                  </button>
                ) : (
                  <button disabled className="w-full py-3 rounded-xl bg-transparent text-muted-foreground/30 font-medium mb-8 cursor-not-allowed border border-white/5 transition-colors">
                    Included in Plan
                  </button>
                )}
                
                <div className="space-y-4 text-sm text-foreground/80 flex-1 font-medium">
                  <div className="flex items-start gap-3"><TerminalSquare size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Llama-3.1 Core Model</div>
                  <div className="flex items-start gap-3"><Network size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Basic AST Path Tracing</div>
                  <div className="flex items-start gap-3"><Activity size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Standard Heuristic Scans</div>
                  <div className="flex items-start gap-3"><FileJson size={18} className="text-muted-foreground shrink-0 mt-0.5" /> 50 Executions / month</div>
                </div>
              </div>

              {/* 2. GO TIER */}
              <div className="bg-[#111116] border border-cyan-500/10 rounded-2xl p-6 flex flex-col hover:border-cyan-500/30 transition-colors">
                <h3 className="text-xl font-semibold text-white mb-2">Go</h3>
                <div className="text-4xl text-white font-bold mb-2">
                  ₹299 <span className="text-xs text-muted-foreground font-normal tracking-wide">/ month</span>
                </div>
                <p className="text-sm text-muted-foreground mb-6 h-10">Expanded access for rapid testing.</p>
                
                {activeTier === 'go' ? (
                   <button className="w-full py-3 rounded-xl bg-white/5 text-muted-foreground font-medium mb-8 cursor-default border border-white/5 transition-colors">
                     Current License
                   </button>
                ) : (
                  <button 
                    onClick={() => handleUpgrade('Go')}
                    disabled={loadingPlan !== null || activeTier === 'plus' || activeTier === 'pro'}
                    className="w-full py-3 rounded-xl bg-white/10 text-white hover:bg-white/20 font-medium mb-8 transition-colors flex items-center justify-center gap-2 border border-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loadingPlan === 'Go' ? (
                      <><Loader2 className="animate-spin" size={18} /> {isVerifying ? 'Verifying...' : 'Deploying...'}</>
                    ) : (
                      (activeTier === 'plus' || activeTier === 'pro' ? 'Included in Plan' : 'Deploy Go')
                    )}
                  </button>
                )}
                
                <div className="space-y-4 text-sm text-foreground/80 flex-1 font-medium">
                  <div className="flex items-start gap-3"><Zap size={18} className="text-cyan-400 shrink-0 mt-0.5" /> Priority API Queue</div>
                  <div className="flex items-start gap-3"><Network size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Enhanced AST Visualization</div>
                  <div className="flex items-start gap-3"><Shield size={18} className="text-muted-foreground shrink-0 mt-0.5" /> Unlimited Chat History</div>
                  <div className="flex items-start gap-3"><FileJson size={18} className="text-muted-foreground shrink-0 mt-0.5" /> 200 Executions / month</div>
                </div>
              </div>

              {/* 3. PLUS TIER (POPULAR) */}
              <div className="bg-[#111116] border border-cyan-500/50 rounded-2xl p-6 flex flex-col relative shadow-[0_0_30px_rgba(34,211,238,0.15)] hover:shadow-[0_0_40px_rgba(34,211,238,0.25)] transition-all">
                <div className="absolute top-5 right-5 bg-cyan-500/20 text-cyan-400 text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full border border-cyan-500/30">
                  Hunter
                </div>
                
                <h3 className="text-xl font-semibold text-white mb-2">Plus</h3>
                <div className="text-4xl text-white font-bold mb-2">
                  ₹1,999 <span className="text-xs text-cyan-200/50 font-normal tracking-wide">/ month</span>
                </div>
                <p className="text-sm text-cyan-200/70 mb-6 h-10">Optimized workflows for Bug Bounty.</p>
                
                {activeTier === 'plus' ? (
                  <button className="w-full py-3 rounded-xl bg-cyan-500/20 text-cyan-400 font-bold mb-8 cursor-default border border-cyan-500/30 transition-colors">
                    Current License
                  </button>
                ) : (
                  <button 
                    onClick={() => handleUpgrade('Plus')}
                    disabled={loadingPlan !== null || activeTier === 'pro'}
                    className="w-full py-3 rounded-xl bg-cyan-500 text-black hover:bg-cyan-400 font-bold mb-8 transition-colors shadow-lg shadow-cyan-500/20 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loadingPlan === 'Plus' ? (
                      <><Loader2 className="animate-spin text-black" size={18} /> {isVerifying ? 'Verifying...' : 'Deploying...'}</>
                    ) : (
                      (activeTier === 'pro' ? 'Included in Plan' : 'Deploy Plus')
                    )}
                  </button>
                )}
                
                <div className="space-y-4 text-sm text-white flex-1 font-medium">
                  <div className="flex items-start gap-3"><Target size={18} className="text-cyan-400 shrink-0 mt-0.5" /> Interactive Topology Graph</div>
                  <div className="flex items-start gap-3"><Crosshair size={18} className="text-cyan-400 shrink-0 mt-0.5" /> HackerOne/Bugcrowd Webhooks</div>
                  <div className="flex items-start gap-3"><TerminalSquare size={18} className="text-cyan-400 shrink-0 mt-0.5" /> Deep Context (128k Tokens)</div>
                  <div className="flex items-start gap-3"><GitMerge size={18} className="text-cyan-400 shrink-0 mt-0.5" /> Payload Mutation Engine</div>
                  <div className="flex items-start gap-3"><FileJson size={18} className="text-cyan-400 shrink-0 mt-0.5" /> 1,000 Executions / month</div>
                </div>
              </div>

              {/* 4. PRO TIER (ENTERPRISE) */}
              <div className="bg-[#111116] border border-amber-500/30 rounded-2xl p-6 flex flex-col relative shadow-[0_0_20px_rgba(245,158,11,0.05)] hover:border-amber-500/50 transition-colors">
                <div className="absolute top-5 right-5 bg-amber-500/10 text-amber-500 text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full border border-amber-500/20">
                  Architect
                </div>

                <h3 className="text-xl font-semibold text-white mb-2">Pro</h3>
                <div className="text-4xl text-white font-bold mb-2">
                  ₹9,599 <span className="text-xs text-muted-foreground font-normal tracking-wide">/ month</span>
                </div>
                <p className="text-sm text-muted-foreground mb-6 h-10">Full adversarial simulation & consensus.</p>
                
                {activeTier === 'pro' ? (
                  <button className="w-full py-3 rounded-xl bg-amber-500/20 text-amber-500 font-bold mb-8 cursor-default border border-amber-500/30 transition-colors">
                    Current License
                  </button>
                ) : (
                  <button 
                    onClick={() => handleUpgrade('Pro')}
                    disabled={loadingPlan !== null}
                    className="w-full py-3 rounded-xl bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 font-bold mb-8 transition-colors flex items-center justify-center gap-2 border border-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loadingPlan === 'Pro' ? (
                      <><Loader2 className="animate-spin" size={18} /> {isVerifying ? 'Verifying...' : 'Deploying...'}</>
                    ) : (
                      'Deploy Pro'
                    )}
                  </button>
                )}
                
                <div className="space-y-4 text-sm text-foreground/80 flex-1 font-medium">
                  <div className="text-[10px] font-bold text-amber-500/80 uppercase tracking-widest mb-3">Includes Plus, and:</div>
                  <div className="flex items-start gap-3"><Shield size={18} className="text-amber-500 shrink-0 mt-0.5" /> Red/Blue Agent Swarm</div>
                  <div className="flex items-start gap-3"><Sparkles size={18} className="text-amber-500 shrink-0 mt-0.5" /> Zero-Day Heuristics AI</div>
                  <div className="flex items-start gap-3"><FileBadge size={18} className="text-amber-500 shrink-0 mt-0.5" /> Professional Audit PDF Exports</div>
                  <div className="flex items-start gap-3"><Zap size={18} className="text-amber-500 shrink-0 mt-0.5" /> Dedicated Compute Instances</div>
                  <div className="flex items-start gap-3"><Activity size={18} className="text-amber-500 shrink-0 mt-0.5" /> Unlimited Executions</div>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>
    </>
  )
}