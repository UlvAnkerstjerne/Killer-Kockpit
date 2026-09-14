'use client'

import { useCallback, useEffect, useState } from 'react'

export type RecentItemType = 'task' | 'project' | 'meeting' | 'waiting_on'

export interface RecentItem {
  id: string
  type: RecentItemType
  title: string
  href: string
  openedAt: number
}

const MAX_ITEMS = 5

function storageKey(userId: string) {
  return `kk_recents_v1_${userId}`
}

function readStorage(userId: string): RecentItem[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(storageKey(userId))
    return raw ? (JSON.parse(raw) as RecentItem[]) : []
  } catch {
    return []
  }
}

function writeStorage(userId: string, items: RecentItem[]) {
  localStorage.setItem(storageKey(userId), JSON.stringify(items))
}

export function useRecentlyOpened(userId: string) {
  const [recents, setRecents] = useState<RecentItem[]>([])

  useEffect(() => {
    setRecents(readStorage(userId))
  }, [userId])

  const record = useCallback((item: Omit<RecentItem, 'openedAt'>) => {
    const current = readStorage(userId)
    // Remove any existing entry for this same item, then prepend
    const filtered = current.filter(r => !(r.id === item.id && r.type === item.type))
    const next = [{ ...item, openedAt: Date.now() }, ...filtered].slice(0, MAX_ITEMS)
    writeStorage(userId, next)
    setRecents(next)
  }, [userId])

  return { recents, record }
}
