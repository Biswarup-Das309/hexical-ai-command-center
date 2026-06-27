import { useState } from 'react';

export function useGuestLimit() {
  const checkLimit = () => {
    // 1. Get history or default to empty array
    const history = JSON.parse(localStorage.getItem('guest_usage') || '[]');
    const now = Date.now();
    const fiveHours = 5 * 60 * 60 * 1000;
    
    // 2. Filter out messages older than 5 hours
    const validHistory = history.filter((ts: number) => now - ts < fiveHours);
    
    // 3. Check if reached 10 messages
    if (validHistory.length >= 10) {
      return false; // Limit reached
    }
    
    // 4. Record the new attempt
    validHistory.push(now);
    localStorage.setItem('guest_usage', JSON.stringify(validHistory));
    return true;
  };

  return { checkLimit };
}