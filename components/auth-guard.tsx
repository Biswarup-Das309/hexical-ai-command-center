'use client';

import { useAuth } from '@clerk/nextjs';
import { HexicalConsole } from '@/components/hexical/hexical-console';

export function AuthGuard() {
  const { isLoaded } = useAuth();

  // Still wait for Clerk to initialize, so we don't flash the wrong UI
  if (!isLoaded) {
    return <div className="flex h-screen items-center justify-center">Loading...</div>;
  }

  // No more isSignedIn branch — everyone gets the console.
  return <HexicalConsole />;
}