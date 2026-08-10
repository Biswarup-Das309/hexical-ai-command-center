'use client'

import { useState } from 'react'
import { X, Zap, ShieldCheck, Loader2, AlertTriangle } from 'lucide-react'

interface DayPassModalProps {
  onClose: () => void;
  onSuccess?: () => void; // Triggers a UI refresh when the DB updates
}

interface RazorpayPaymentResponse {
  readonly razorpay_payment_id: string;
  readonly razorpay_order_id: string;
  readonly razorpay_signature: string;
}

interface RazorpayFailureResponse {
  readonly error?: { readonly description?: string };
}

interface RazorpayOptions {
  readonly key?: string;
  readonly amount: number;
  readonly currency: string;
  readonly name: string;
  readonly description: string;
  readonly order_id: string;
  readonly handler: (response: RazorpayPaymentResponse) => Promise<void>;
  readonly theme: { readonly color: string };
}

interface RazorpayInstance {
  on(event: 'payment.failed', handler: (response: RazorpayFailureResponse) => void): void;
  open(): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

export function DayPassModal({ onClose, onSuccess }: DayPassModalProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // ELITE FIX 1: Dynamically and safely inject the Razorpay SDK only when needed
  const loadRazorpay = () => {
    return new Promise((resolve) => {
      if (document.querySelector('script[src="https://checkout.razorpay.com/v1/checkout.js"]')) {
        resolve(true);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  };

  const handlePayment = async () => {
    setIsProcessing(true);
    setErrorMsg('');

    try {
      const isLoaded = await loadRazorpay();
      if (!isLoaded) {
        throw new Error("Razorpay SDK failed to load. Check your connection.");
      }

      // ELITE FIX 2: Server-Side Order Generation. 
      // The frontend never dictates the price. It asks the server for a secure Order ID.
      const orderResponse = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'go' })
      });
      
      if (!orderResponse.ok) {
        throw new Error("Failed to initialize secure transaction with server.");
      }
      
      const orderData = await orderResponse.json();

      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID, // Safe to expose public key
        amount: orderData.amount, 
        currency: orderData.currency,
        name: "Hexical AI",
        description: "24-Hour Swarm Engine Pass",
        order_id: orderData.id,
        handler: async function (response: RazorpayPaymentResponse) {
          try {
            // ELITE FIX 3: Cryptographic Backend Verification.
            // Do NOT grant access until the server validates the HMAC SHA256 signature.
            const verifyRes = await fetch('/api/verify-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_signature: response.razorpay_signature,
                tier: 'go',
              })
            });

            if (!verifyRes.ok) throw new Error("Cryptographic verification failed. Access denied.");
            
            if (onSuccess) onSuccess();
            onClose();
          } catch (err: unknown) {
            setErrorMsg(err instanceof Error ? err.message : "Payment verification failed. Contact support.");
            setIsProcessing(false);
          }
        },
        theme: {
          color: "#f59e0b" // Amber-500 to match the UI glow
        }
      };

      if (!window.Razorpay) throw new Error('Razorpay SDK is unavailable. Please retry.');
      const paymentObject = new window.Razorpay(options);
      
      paymentObject.on('payment.failed', function (response: RazorpayFailureResponse) {
         setErrorMsg(response.error?.description || "Transaction declined by bank.");
         setIsProcessing(false);
      });
      
      paymentObject.open();

    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "An unexpected error occurred during checkout.");
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in font-sans">
      <div className="bg-[#0a0a0c] border border-amber-500/20 rounded-2xl w-full max-w-md p-6 text-white relative shadow-[0_0_50px_rgba(245,158,11,0.1)]">
        
        <button 
          onClick={onClose} 
          disabled={isProcessing}
          className="absolute top-4 right-4 p-2 text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
        >
          <X size={18} />
        </button>

        <div className="flex flex-col items-center text-center mt-4">
          <div className="size-16 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-4">
            <Zap className="size-8 text-amber-400" />
          </div>
          
          <h2 className="text-2xl font-bold mb-2">Upgrade to Go</h2>
          <p className="text-sm text-zinc-400 mb-6">
            You have exhausted your free tier execution limits. Upgrade to Go for more throughput and faster analysis.
          </p>

          <div className="w-full bg-black/50 border border-white/5 rounded-xl p-4 mb-4 text-left">
            <ul className="space-y-3 text-sm text-zinc-300">
              <li className="flex items-center gap-2"><ShieldCheck size={16} className="text-emerald-400"/> Multi-Agent Consensus</li>
              <li className="flex items-center gap-2"><ShieldCheck size={16} className="text-emerald-400"/> PDF Audit Reports</li>
              <li className="flex items-center gap-2"><ShieldCheck size={16} className="text-emerald-400"/> Priority API Routing</li>
            </ul>
          </div>

          {/* ELITE FIX 4: Inline Error Handling so users aren't guessing what went wrong */}
          {errorMsg && (
            <div className="w-full mb-4 p-3 bg-rose-500/10 border border-rose-500/20 rounded-lg flex items-center gap-2 text-rose-400 text-xs text-left">
              <AlertTriangle size={14} className="shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* ELITE FIX 5: Loading state prevents double-charging and UI freezing */}
          <button 
            onClick={handlePayment}
            disabled={isProcessing}
            className="w-full flex justify-center items-center gap-2 py-3 bg-amber-500 hover:bg-amber-400 disabled:bg-amber-500/50 text-black font-bold rounded-xl transition-all shadow-[0_0_20px_rgba(245,158,11,0.2)]"
          >
            {isProcessing ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                Initializing Secure Gateway...
              </>
            ) : (
              "Upgrade to Go - ₹299"
            )}
          </button>
          
          <p className="text-[10px] text-zinc-500 mt-4 uppercase tracking-wider">
            Secured via Razorpay
          </p>
        </div>
      </div>
    </div>
  )
}
