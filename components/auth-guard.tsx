'use client';

import { useAuth, SignInButton } from '@clerk/nextjs';
import { HexicalConsole } from '@/components/hexical/hexical-console';
import {
  Shield,
  Code2,
  GraduationCap,
  Radar,
  ShieldCheck,
  Binary,
  TerminalSquare,
  Users,
  CheckCircle2,
} from 'lucide-react';

export function AuthGuard() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0a0a0c] font-mono text-sm text-cyan-400">
        booting session…
      </div>
    );
  }

  if (isSignedIn) {
    return <HexicalConsole />;
  }

  return <LandingPage />;
}

function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0c] text-zinc-100">
      {/* ambient backdrop — kept subtle on purpose */}
      <div
        className="pointer-events-none fixed inset-0 opacity-40"
        style={{
          background:
            'radial-gradient(circle at 50% -10%, rgba(34,211,238,0.10), transparent 55%)',
        }}
      />

      <div className="relative">
        {/* 1. Hero */}
        <section className="mx-auto max-w-4xl px-6 pt-28 pb-14 text-center">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
            AI that{' '}
            <span className="text-cyan-400 [text-shadow:0_0_28px_rgba(34,211,238,0.45)]">
              shows its work.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl font-mono text-sm text-zinc-400 sm:text-base">
            Multi-agent cybersecurity platform with full execution transparency.
            See every model call, raw payload, and security check behind each answer.
          </p>
          <SignInButton mode="modal">
            <button className="mt-8 rounded-lg bg-cyan-400 px-7 py-3 text-sm font-semibold text-black transition hover:bg-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0c]">
              Get Started
            </button>
          </SignInButton>
        </section>

        {/* 2. Visual — the Trace Log itself, not a placeholder */}
        <section className="mx-auto max-w-3xl px-6 pb-20">
          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-black/60 shadow-[0_0_60px_-15px_rgba(34,211,238,0.15)]">
            <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
              <span className="ml-3 font-mono text-xs text-zinc-500">
                trace — session_9f21a.log
              </span>
            </div>
            <div className="space-y-1.5 overflow-x-auto px-5 py-5 font-mono text-[13px] leading-relaxed">
              <TraceLine time="00:00.12" tag="RECON_ENGINE" tagColor="text-cyan-400">
                scanning target: <span className="text-zinc-300">api.staging.internal</span>
              </TraceLine>
              <TraceLine time="00:00.41" tag="RECON_ENGINE" tagColor="text-cyan-400" status="ok">
                3 open ports found — 443, 8080, 5432
              </TraceLine>
              <TraceLine time="00:01.03" tag="MODEL_CALL" tagColor="text-violet-400">
                gpt-oss-sec-7b → &quot;classify auth flow on /users/:id&quot;
              </TraceLine>
              <TraceLine time="00:01.09" tag="VERIFY" tagColor="text-emerald-400" status="ok">
                response matches raw payload — diff: 0
              </TraceLine>
              <TraceLine time="00:01.22" tag="EXPLOIT_ARCHITECT" tagColor="text-cyan-400">
                drafting payload — broken object-level authorization
              </TraceLine>
              <TraceLine time="00:01.30" tag="SECURITY_CHECK" tagColor="text-emerald-400" status="ok">
                payload scoped to test environment only
              </TraceLine>
              <TraceLine time="00:01.44" tag="CVSS_CALC" tagColor="text-amber-400">
                7.1 HIGH — broken access control
              </TraceLine>
              <TraceLine time="00:01.51" tag="DEFENSE_MATRIX" tagColor="text-emerald-400" status="ok">
                mitigation drafted — scope JWT claims to resource owner
              </TraceLine>
              <div className="flex items-center gap-2 pt-1 text-zinc-600">
                <span>hexical@trace:~$</span>
                <span className="h-4 w-2 animate-pulse bg-cyan-400/70 motion-reduce:animate-none" />
              </div>
            </div>
          </div>
          <p className="mt-3 text-center font-mono text-xs text-zinc-600">
            representative trace — swap in a real session recording when you have one
          </p>
        </section>

        {/* 3. Who it's for */}
        <section className="mx-auto max-w-5xl border-t border-zinc-900 px-6 py-20">
          <div className="grid gap-6 sm:grid-cols-3">
            <AudienceCard
              icon={<Shield className="h-6 w-6" />}
              title="Researchers & bug bounty hunters"
              body="Validate findings and streamline reporting without re-checking the AI's logic line by line."
            />
            <AudienceCard
              icon={<Code2 className="h-6 w-6" />}
              title="Developers"
              body="Run AST-level code analysis and trace a flaw back to the exact line it originates from."
            />
            <AudienceCard
              icon={<GraduationCap className="h-6 w-6" />}
              title="CS/IT students"
              body="Learn real security workflows by watching the step-by-step reasoning behind each exploit."
            />
          </div>
        </section>

        {/* 4. Key features */}
        <section className="mx-auto max-w-4xl border-t border-zinc-900 px-6 py-20">
          <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
            <FeatureRow
              icon={<Radar className="h-5 w-5" />}
              title="Recon Engine, Exploit Architect, Defense Matrix"
              body="Automated discovery, structured payload drafting, and mitigation suggestions in one pipeline."
            />
            <FeatureRow
              icon={<Binary className="h-5 w-5" />}
              title="AST code tracing & CVSS calculator"
              body="Precise, line-level vulnerability mapping with standardized severity scoring."
            />
            <FeatureRow
              icon={<TerminalSquare className="h-5 w-5" />}
              title="Live TTY sandbox"
              body="Run controlled simulations in a real terminal, isolated from production."
            />
            <FeatureRow
              icon={<Users className="h-5 w-5" />}
              title="Swarm Intelligence"
              body="Run multiple specialized agents against the same target at once."
              badge="PRO"
            />
          </div>
        </section>

        {/* 5. Trust signal + footer CTA */}
        <section className="mx-auto max-w-2xl border-t border-zinc-900 px-6 py-20 text-center">
          <ShieldCheck className="mx-auto mb-5 h-8 w-8 text-cyan-400" />
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Built for people who need to verify, not just trust.
          </h2>
          <p className="mt-6 font-mono text-sm text-zinc-500">Ready to see it yourself?</p>
          <SignInButton mode="modal">
            <button className="mt-5 rounded-lg border border-cyan-400/60 px-7 py-3 text-sm font-semibold text-cyan-400 transition hover:bg-cyan-400 hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0c]">
              Get Started
            </button>
          </SignInButton>
        </section>
      </div>
    </div>
  );
}

function TraceLine({
  time,
  tag,
  tagColor,
  status,
  children,
}: {
  time: string;
  tag: string;
  tagColor: string;
  status?: 'ok';
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="text-zinc-600">[{time}]</span>
      <span className={`w-[130px] shrink-0 ${tagColor}`}>{tag}</span>
      {status === 'ok' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
      <span className="text-zinc-400">{children}</span>
    </div>
  );
}

function AudienceCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-900 bg-zinc-950/50 p-6 transition hover:border-cyan-400/30">
      <div className="text-cyan-400">{icon}</div>
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p className="mt-2 font-mono text-[13px] leading-relaxed text-zinc-500">{body}</p>
    </div>
  );
}

function FeatureRow({
  icon,
  title,
  body,
  badge,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  badge?: string;
}) {
  return (
    <div className="flex gap-4">
      <div className="mt-0.5 text-cyan-400">{icon}</div>
      <div>
        <div className="flex items-center gap-2">
          <h4 className="font-semibold">{title}</h4>
          {badge && (
            <span className="rounded border border-amber-400/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">
              {badge}
            </span>
          )}
        </div>
        <p className="mt-1 font-mono text-[13px] leading-relaxed text-zinc-500">{body}</p>
      </div>
    </div>
  );
}