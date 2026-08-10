// app/page.tsx
import { Loader2 } from 'lucide-react'
import { Suspense } from 'react'
import { AuthGuard } from '@/components/auth-guard'

export default function Page() {
  return (
    <main className="min-h-screen bg-[#0a0a0c]">
      {/* Suspense is the professional way to handle async loading states */}
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-cyan-400">
            <Loader2 className="animate-spin size-8" />
          </div>
        }
      >
        <AuthGuard />
      </Suspense>
    </main>
  )
}
