'use client';

import { useState } from 'react';
import { createSupabaseClient } from '@/lib/supabase';
import { Loader2 } from 'lucide-react';

const supabase = createSupabaseClient();

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    
    if (error) {
      setError(error.message);
    } else {
      window.location.assign('/'); // Hard redirect back to home on success
    }
    setLoading(false);
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` }
    });
    if (error) setError(error.message);
  };

  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-4 hud-grid scanlines">
      <div className="w-full max-w-md p-8 rounded-2xl border border-glow-cyan bg-card/80 backdrop-blur-md shadow-2xl relative z-10">
        <h1 className="text-3xl font-sans mb-6 text-center text-foreground">
          Hexical <span className="text-cyan text-glow-cyan">Access</span>
        </h1>
        
        {error && <p className="text-red-500 text-sm mb-4 text-center bg-red-500/10 p-2 rounded">{error}</p>}

        <form onSubmit={handleEmailLogin} className="space-y-4">
          <input
            type="email"
            placeholder="Email Address"
            className="w-full p-3 rounded-lg bg-background border border-border focus:border-cyan outline-none transition-all font-mono text-sm"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Password"
            className="w-full p-3 rounded-lg bg-background border border-border focus:border-cyan outline-none transition-all font-mono text-sm"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full p-3 rounded-lg bg-cyan text-background font-bold hover:bg-cyan/90 transition-all flex justify-center mt-2"
          >
            {loading ? <Loader2 className="animate-spin" /> : 'Initialize Session'}
          </button>
        </form>

        <div className="my-6 flex items-center gap-4">
          <div className="flex-1 h-px bg-border"></div>
          <span className="text-muted-foreground text-xs font-mono">OR</span>
          <div className="flex-1 h-px bg-border"></div>
        </div>

        <button
          onClick={handleGoogleLogin}
          disabled={loading}
          className="w-full p-3 rounded-lg border border-border hover:border-cyan hover:text-cyan transition-all font-mono text-sm flex items-center justify-center gap-2"
        >
          {loading ? <Loader2 className="animate-spin size-4" /> : 'Continue with Google'}
        </button>
      </div>
    </main>
  );
}
