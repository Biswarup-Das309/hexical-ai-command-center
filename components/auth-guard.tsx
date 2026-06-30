'use client';

import { useAuth, SignInButton } from '@clerk/nextjs';
import { HexicalConsole } from '@/components/hexical/hexical-console';

export function AuthGuard() {
  const { isLoaded, isSignedIn } = useAuth();

  // 1. Handle the loading state (Crucial for Clerk to initialize)
  if (!isLoaded) {
    return <div className="flex h-screen items-center justify-center">Loading...</div>;
  }

  // 2. Logic-based rendering (Replaces SignedIn/SignedOut components)
  if (isSignedIn) {
    return <HexicalConsole />;
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4">
      <h1 className="text-2xl font-bold">Welcome to Hexical AI</h1>
      <p>Please sign in to access your secure console.</p>
      
      <SignInButton mode="modal">
        <button className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          Sign In
        </button>
      </SignInButton>
    </div>
  );
}