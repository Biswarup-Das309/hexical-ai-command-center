'use client'

import { useUser } from '@clerk/nextjs'
import { useState, useEffect, useCallback, useRef } from 'react'

type Tier = 'guest' | 'free' | 'go' | 'plus' | 'pro'

interface Entitlement {
  tier: Tier
  active: boolean
  current_period_end?: string | null
}

const FIVE_HOURS = 5 * 60 * 60 * 1000
const GUEST_MESSAGE_LIMIT = 10
const POLL_INTERVAL = 30_000 // re-check entitlement every 30s while tab is open

export function useGuestLimit() {
  const { user, isLoaded: isClerkLoaded } = useUser()
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null)
  const [isEntitlementLoading, setIsEntitlementLoading] = useState(true)
  const [isLocked, setIsLocked] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState<string>('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const currentTier: Tier = !isClerkLoaded ? 'guest' : !user ? 'guest' : entitlement?.tier ?? 'free'

  const isPaidTier = currentTier !== 'guest' && currentTier !== 'free'

  /**
   * Fetch live entitlement from Supabase-backed API. This is the ONLY
   * source of truth for tier — no Clerk metadata, no localStorage tier.
   */
  const refreshEntitlement = useCallback(async () => {
    if (!user) {
      setEntitlement({ tier: 'guest', active: false })
      setIsEntitlementLoading(false)
      return
    }
    try {
      const res = await fetch('/api/entitlement', { cache: 'no-store' })
      if (!res.ok) throw new Error(`Entitlement fetch failed: ${res.status}`)
      const data: Entitlement = await res.json()
      setEntitlement(data)
    } catch (err) {
      console.error('[ENTITLEMENT_FETCH_ERROR]', err)
      // fail safe — never silently grant a paid tier on error
      setEntitlement((prev) => prev ?? { tier: 'free', active: false })
    } finally {
      setIsEntitlementLoading(false)
    }
  }, [user])

  // Initial fetch + refetch whenever the Clerk user object changes (login/logout)
  useEffect(() => {
    setIsEntitlementLoading(true)
    refreshEntitlement()
  }, [refreshEntitlement])

  // Poll periodically so an upgrade completed in another tab, or shortly
  // after a webhook fires, is picked up without requiring a manual refresh.
  useEffect(() => {
    if (!user) return
    pollRef.current = setInterval(refreshEntitlement, POLL_INTERVAL)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [user, refreshEntitlement])

  // Also refetch when the tab regains focus — covers "paid in another tab,
  // came back to this one" without waiting for the poll interval.
  useEffect(() => {
    const onFocus = () => refreshEntitlement()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshEntitlement])

  const getValidHistory = useCallback(() => {
    if (typeof window === 'undefined') return []
    try {
      const history = JSON.parse(localStorage.getItem('guest_usage') || '[]')
      const now = Date.now()
      return (history as number[]).filter((ts) => now - ts < FIVE_HOURS)
    } catch {
      return []
    }
  }, [])

  const checkLimit = useCallback(() => {
    if (isPaidTier) {
      setIsLocked(false)
      return true
    }
    const validHistory = getValidHistory()
    if (validHistory.length >= GUEST_MESSAGE_LIMIT) {
      setIsLocked(true)
      return false
    }
    setIsLocked(false)
    return true
  }, [isPaidTier, getValidHistory])

  const recordUsage = useCallback(() => {
    if (isPaidTier) return
    const validHistory = getValidHistory()
    validHistory.push(Date.now())
    localStorage.setItem('guest_usage', JSON.stringify(validHistory))
    checkLimit()
  }, [isPaidTier, getValidHistory, checkLimit])

  useEffect(() => {
    const runTimerLifecycle = () => {
      if (isPaidTier) {
        setIsLocked(false)
        setTimeRemaining('')
        return
      }
      const validHistory = getValidHistory()
      if (validHistory.length >= GUEST_MESSAGE_LIMIT) {
        setIsLocked(true)
        const expirationThreshold = validHistory[0] + FIVE_HOURS
        const distance = expirationThreshold - Date.now()
        if (distance > 0) {
          const hours = Math.floor(distance / (1000 * 60 * 60))
          const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60))
          const seconds = Math.floor((distance % (1000 * 60)) / 1000)
          setTimeRemaining(`${hours}h ${minutes}m ${seconds}s`)
        } else {
          setIsLocked(false)
          setTimeRemaining('')
          localStorage.setItem('guest_usage', JSON.stringify(validHistory.filter((ts) => Date.now() - ts < FIVE_HOURS)))
        }
      } else {
        setIsLocked(false)
        setTimeRemaining('')
      }
    }

    runTimerLifecycle()
    const timerInterval = setInterval(runTimerLifecycle, 1000)
    return () => clearInterval(timerInterval)
  }, [isPaidTier, getValidHistory])

  return {
    isLocked,
    timeRemaining,
    currentTier,
    isLoaded: isClerkLoaded && !isEntitlementLoading,
    checkLimit,
    recordUsage,
    refreshEntitlement, // call this manually right after a successful payment redirect
  }
}
