// app/page.tsx
import { AuthGuard } from '@/components/auth-guard';

export default function Page() {
  return (
    <main className="min-h-screen">
      <AuthGuard />
    </main>
  );
}