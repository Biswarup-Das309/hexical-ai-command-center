import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono, JetBrains_Mono } from 'next/font/google'
import { ClerkProvider } from '@clerk/nextjs'
import { dark } from '@clerk/themes' 
import { Toaster } from 'sonner' 
import './globals.css'

// --- TYPOGRAPHY ---
const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })
const jetbrainsMono = JetBrains_Mono({ variable: '--font-jetbrains-mono', subsets: ['latin'] })

// --- METADATA ---
export const metadata: Metadata = {
  title: 'HEXICAL AI // Command Center',
  description: 'Hexical AI — a hybrid intelligence engine. Cyber-elegant command center HUD for routing logic across local and global compute nodes.',
  generator: 'Next.js', // Updated from generic v0.app
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0a0a0c', // Synced exactly with your app background
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <ClerkProvider
      appearance={{
        baseTheme: dark,
        variables: {
          colorPrimary: '#22d3ee', // Hexical Cyan
          colorBackground: '#0a0a0c', 
          colorTextPrimary: '#ffffff',
          colorTextSecondary: '#a1a1aa',
          colorDanger: '#ef4444',
          colorSuccess: '#22c55e',
          // FIX: Force Clerk to use your Next.js Geist font
          fontFamily: 'var(--font-geist-sans)', 
        },
        elements: {
          // --- TOTAL UI OVERRIDE FOR CYBER HUD AESTHETIC ---
          card: 'bg-[#0a0a0c] border border-white/10 shadow-[0_0_40px_rgba(34,211,238,0.1)] rounded-2xl',
          headerTitle: 'font-sans font-bold text-2xl text-white tracking-tight',
          headerSubtitle: 'font-mono text-xs text-muted-foreground uppercase tracking-widest',
          
          // Custom glowing Cyan button
          formButtonPrimary: 'bg-cyan-500/10 border border-cyan-500/50 text-cyan-400 hover:bg-cyan-400 hover:text-black font-bold transition-all shadow-[0_0_15px_rgba(34,211,238,0.2)]',
          
          // Monospace HUD inputs
          formFieldInput: 'bg-[#111116] border border-white/10 text-white font-mono text-sm focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all rounded-lg',
          formFieldLabel: 'font-mono text-[10px] uppercase tracking-widest text-zinc-400',
          
          // Minor details
          dividerLine: 'bg-white/10',
          dividerText: 'font-mono text-xs text-zinc-500',
          socialButtonsBlockButton: 'bg-[#111116] border border-white/10 hover:bg-white/5 text-white transition-all rounded-lg',
          footerActionLink: 'text-cyan-400 hover:text-cyan-300 font-medium transition-colors',
          identityPreviewText: 'font-mono text-sm text-zinc-300',
        }
      }}
    >
      <html
        lang="en"
        className={`dark ${geistSans.variable} ${geistMono.variable} ${jetbrainsMono.variable}`}
        suppressHydrationWarning 
      >
        {/* FIX: Added global custom selection color (Cyan highlight when dragging text) */}
        <body className="bg-[#050505] font-sans antialiased text-foreground selection:bg-cyan-500/30 selection:text-cyan-50 min-h-screen flex flex-col">
          
          {children}
          
          {/* FIX: Premium HUD-themed Sonner Toaster */}
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
          
          {process.env.NODE_ENV === 'production' && <Analytics />}
        </body>
      </html>
    </ClerkProvider>
  )
}