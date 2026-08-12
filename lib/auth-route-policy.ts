/**
 * Browser-facing application routes that must never render for an anonymous
 * visitor. API handlers still perform their own authorization checks; this
 * policy protects document navigation before a client component can mount.
 */
const PROTECTED_APP_ROUTE_PREFIXES = ['/dashboard'] as const

export function isProtectedAppPathname(pathname: string): boolean {
  return PROTECTED_APP_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
