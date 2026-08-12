import { clerkMiddleware } from '@clerk/nextjs/server'
import { isProtectedAppPathname } from '@/lib/auth-route-policy'

export default clerkMiddleware(async (auth, request) => {
  if (!isProtectedAppPathname(request.nextUrl.pathname)) return

  const { userId, redirectToSignIn } = await auth()

  if (!userId) return redirectToSignIn({ returnBackUrl: request.url })
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
}
