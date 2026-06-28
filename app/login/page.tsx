'use client';

import { useState, useEffect } from 'react';
import { HexicalConsole } from '@/components/hexical/hexical-console';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export default function Home() {
  const [isChatStarted, setIsChatStarted] = useState(false);
  const [userName, setUserName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    // Check for active session on load
    const checkUser = async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session?.user) {
        const fullName = data.session.user.user_metadata.full_name || 'User';
        setUserName(fullName.split(' ')[0]);
      } else {
        setUserName('Guest');
      }
      setIsLoading(false);
    };

    checkUser();
  }, []);

  return (
    <main className="min-h-screen bg-background text-foreground hud-grid scanlines">
      {!isChatStarted ? (
        /* Landing Page View */
        <div className="h-screen w-full flex flex-col items-center justify-center animate-rise p-4">
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="text-3xl md:text-5xl font-sans mb-8 text-foreground">
              {isLoading ? (
                <Loader2 className="animate-spin inline size-8" />
              ) : (
                <>
                  Let's jump in, <span className="text-cyan text-glow-cyan">{userName || 'Guest'}</span>.
                </>
              )}
            </h2>
            
            {/* Action Buttons */}
            <div className="flex flex-col gap-4">
              {/* Initialize Button */}
              <div 
                className="w-full shadow-2xl rounded-full border border-glow-cyan glass p-4 cursor-pointer hover:border-cyan-500 transition-all"
                onClick={() => setIsChatStarted(true)}
              >
                <p className="text-muted-foreground text-center">Click here to initialize Hexical...</p>
              </div>

              {/* Conditional Auth Button */}
              {!isLoading && userName === 'Guest' && (
                <button 
                  onClick={() => router.push('/login')}
                  className="mt-4 text-sm text-cyan/70 hover:text-cyan transition-colors underline"
                >
                  Already have an account? Sign in.
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* Chat Console View */
        <HexicalConsole />
      )}
    </main>
  );
}