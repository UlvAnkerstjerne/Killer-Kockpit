'use client'

import { useEffect } from 'react'

/**
 * Saves and restores window scroll position via sessionStorage.
 * Reusable across list pages (tasks, projects, waiting-ons, meetings).
 *
 * Usage:
 *   const { saveScroll } = useScrollRestoration('tasks-list')
 *   // call saveScroll() in the onClick of each list item link
 */
export function useScrollRestoration(storageKey: string) {
  useEffect(() => {
    const saved = sessionStorage.getItem(storageKey)
    if (saved !== null) {
      const y = parseInt(saved, 10)
      sessionStorage.removeItem(storageKey)
      if (!isNaN(y) && y > 0) {
        requestAnimationFrame(() => window.scrollTo(0, y))
      }
    }
  }, [storageKey])

  return {
    saveScroll() {
      sessionStorage.setItem(storageKey, String(window.scrollY))
    },
  }
}
