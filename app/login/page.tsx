'use client';

import { useState } from 'react';
import { HexicalConsole } from '@/components/hexical/hexical-console';

export default function Home() {
  // This state tracks whether the chat has "started"
  const [isChatStarted, setIsChatStarted] = useState(false);
  const userName = 'Guest';

  return (
    <main className="min-h-screen bg-background text-foreground hud-grid scanlines">
      {!isChatStarted ? (
        /* Landing Page View */
        <div className="h-screen w-full flex flex-col items-center justify-center animate-rise p-4">
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="text-3xl md:text-5xl font-sans mb-8 text-foreground">
              Let's jump in, <span className="text-cyan text-glow-cyan">{userName || 'Guest'}</span>.
            </h2>
            
            {/* When clicked, this effectively "starts" the app by switching the state */}
            <div 
              className="w-full shadow-2xl rounded-full border-glow-cyan glass p-4 cursor-pointer hover:border-cyan-500 transition-all"
              onClick={() => setIsChatStarted(true)}
            >
              <p className="text-muted-foreground text-center">Click here to initialize Hexical...</p>
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