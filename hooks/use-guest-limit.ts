'use client'

import { useState, useEffect, useCallback } from 'react'
import { useUser } from '@clerk/nextjs'

export function useGuestLimit() {
  const { user, isLoaded } = useUser()
  const [isLocked, setIsLocked] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState<string>('')

  // 1. Inferred Subscription Tier from Clerk public metadata
  const currentTier = user ? (user.publicMetadata?.tier as 'free' | 'go' | 'plus' | 'pro') || 'free' : 'guest'

  /**
   * Helper function to get clean rolling history within the 5-hour window
   */
  const getValidHistory = useCallback(() => {
    if (typeof window === 'undefined') return []
    const history = JSON.parse(localStorage.getItem('guest_usage') || '[]')
    const now = Date.now()
    const FIVE_HOURS = 5 * 60 * 60 * 1000
    
    return history.filter((ts: number) => now - ts < FIVE_HOURS)
  }, [])

  /**
   * Evaluates if the current environment context can execute a prompt request
   */
  const checkLimit = useCallback(() => {
    // Premium paid tiers (Go, Plus, Pro) completely bypass the rolling guest restriction
    if (currentTier !== 'guest' && currentTier !== 'free') {
      setIsLocked(false)
      return true
    }

    const validHistory = getValidHistory()
    if (validHistory.length >= 10) {
      setIsLocked(true)
      return false
    }

    setIsLocked(false)
    return true
  }, [currentTier, getValidHistory])

  /**
   * Records a successful execution timestamp into the local storage queue
   */
  const recordUsage = useCallback(() => {
    if (currentTier !== 'guest' && currentTier !== 'free') return

    const validHistory = getValidHistory()
    validHistory.push(Date.now())
    localStorage.setItem('guest_usage', JSON.stringify(validHistory))
    checkLimit()
  }, [currentTier, getValidHistory, checkLimit])

  /**
   * Reactive Background Timer Engine
   * Dynamically evaluates rolling lock expiration thresholds down to the second
   */
  useEffect(() => {
    const runTimerLifecycle = () => {
      if (currentTier !== 'guest' && currentTier !== 'free') {
        setIsLocked(false)
        setTimeRemaining('')
        return
      }

      const validHistory = getValidHistory()
      
      if (validHistory.length >= 10) {
        setIsLocked(true)
        const oldestTimestamp = validHistory[0]
        const expirationThreshold = oldestTimestamp + 5 * 60 * 60 * 1000
        const distance = expirationThreshold - Date.now()

        if (distance > 0) {
          const hours = Math.floor(distance / (1000 * 60 * 60))
          const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60))
          const seconds = Math.floor((distance % (1000 * 60)) / 1000)
          
          setTimeRemaining(`${hours}h ${minutes}m ${seconds}s`)
        } else {
          // Window time frame naturally decayed beneath the limitation bounds
          setIsLocked(false)
          setTimeRemaining('')
          localStorage.setItem('guest_usage', JSON.stringify(validHistory.filter((ts: number) => Date.now() - ts < 5 * 60 * 60 * 1000)))
        }
      } else {
        setIsLocked(false)
        setTimeRemaining('')
      }
    }

    runTimerLifecycle()
    const timerInterval = setInterval(runTimerLifecycle, 1000)
    
    return () => clearInterval(timerInterval)
  }, [currentTier, getValidHistory])

  return {
    isLocked,
    timeRemaining,
    currentTier,
    isLoaded,
    checkLimit,
    recordUsage
  }
}