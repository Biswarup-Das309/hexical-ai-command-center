import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono, JetBrains_Mono } from 'next/font/google'
import { ClerkProvider } from '@clerk/nextjs'
import { dark } from '@clerk/themes'
import { Toaster } from 'sonner'
import './globals.css'

// --- TYPOGRAPHY ---
const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'], display: 'swap' })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'], display: 'swap' })
const jetbrainsMono = JetBrains_Mono({ variable: '--font-jetbrains-mono', subsets: ['latin'], display: 'swap' })

// --- SITE CONFIG ---
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://hexical.ai'

// --- METADATA ---
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'HEXICAL AI // Command Center',
    template: '%s // HEXICAL AI',
  },
  description:
    'Hexical AI — a hybrid intelligence engine. Cyber-elegant command center HUD for routing logic across local and global compute nodes.',
  applicationName: 'Hexical AI',
  keywords: ['Hexical AI', 'command center', 'hybrid intelligence', 'compute routing', 'HUD dashboard'],
  authors: [{ name: 'Hexical AI' }],
  formatDetection: { telephone: false, email: false, address: false },
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon-16x16.png',
    apple: '/apple-touch-icon.png',
  },
  manifest: '/site.webmanifest',
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'Hexical AI',
    title: 'HEXICAL AI // Command Center',
    description:
      'A hybrid intelligence engine — cyber-elegant HUD for routing logic across local and global compute nodes.',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'Hexical AI Command Center' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'HEXICAL AI // Command Center',
    description:
      'A hybrid intelligence engine — cyber-elegant HUD for routing logic across local and global compute nodes.',
    images: ['/og-image.png'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
  generator: 'Next.js',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'dark',
  themeColor: '#0a0a0c',
}

// --- CLERK THEME ---
// Defined outside the component so it isn't rebuilt on every render.
// No explicit type needed here — TS checks it automatically where it's used below.
const clerkAppearance = {
  baseTheme: dark,
  variables: {
    colorPrimary: '#22d3ee',
    colorBackground: '#0a0a0c',
    colorTextPrimary: '#ffffff',
    colorTextSecondary: '#a1a1aa',
    colorDanger: '#ef4444',
    colorSuccess: '#22c55e',
    fontFamily: 'var(--font-geist-sans)',
  },
  elements: {
    card: 'bg-[#0a0a0c] border border-white/10 shadow-[0_0_40px_rgba(34,211,238,0.1)] rounded-2xl',
    headerTitle: 'font-sans font-bold text-2xl text-white tracking-tight',
    headerSubtitle: 'font-mono text-xs text-muted-foreground uppercase tracking-widest',
    formButtonPrimary:
      'bg-cyan-500/10 border border-cyan-500/50 text-cyan-400 hover:bg-cyan-400 hover:text-black font-bold transition-all shadow-[0_0_15px_rgba(34,211,238,0.2)]',
    formFieldInput:
      'bg-[#111116] border border-white/10 text-white font-mono text-sm focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all rounded-lg',
    formFieldLabel: 'font-mono text-[10px] uppercase tracking-widest text-zinc-400',
    dividerLine: 'bg-white/10',
    dividerText: 'font-mono text-xs text-zinc-500',
    socialButtonsBlockButton:
      'bg-[#111116] border border-white/10 hover:bg-white/5 text-white transition-all rounded-lg',
    footerActionLink: 'text-cyan-400 hover:text-cyan-300 font-medium transition-colors',
    identityPreviewText: 'font-mono text-sm text-zinc-300',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <ClerkProvider appearance={clerkAppearance}>
      <html
        lang="en"
        className={`dark ${geistSans.variable} ${geistMono.variable} ${jetbrainsMono.variable}`}
        suppressHydrationWarning
      >
        <body className="bg-[#050505] font-sans antialiased text-foreground selection:bg-cyan-500/30 selection:text-cyan-50 min-h-screen flex flex-col">
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:rounded-lg focus:border focus:border-cyan-500/50 focus:bg-[#111116] focus:px-4 focus:py-2 focus:font-mono focus:text-xs focus:uppercase focus:tracking-widest focus:text-cyan-400"
          >
            Skip to main content
          </a>

          <div id="main-content" className="flex flex-1 flex-col">
            {children}
          </div>

          <Toaster
            position="bottom-right"
            theme="dark"
            richColors
            toastOptions={{
              className: 'font-sans border border-white/10 shadow-[0_0_30px_rgba(0,0,0,0.8)] backdrop-blur-md',
              style: {
                background: 'rgba(17, 17, 22, 0.9)',
                color: '#fff',
              },
            }}
          />

          {process.env.NODE_ENV === 'production' && (
            <>
              <Analytics />
              <SpeedInsights />
            </>
          )}
        </body>
      </html>
    </ClerkProvider>
  )
}