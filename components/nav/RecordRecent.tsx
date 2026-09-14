'use client'

import { useEffect } from 'react'
import { useRecentlyOpened, type RecentItem } from '@/lib/hooks/useRecentlyOpened'

/**
 * Drop onto a detail page to record it as a recently-opened item.
 * Renders nothing — side-effect only.
 */
export default function RecordRecent({ userId, item }: { userId: string; item: Omit<RecentItem, 'openedAt'> }) {
  const { record } = useRecentlyOpened(userId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { record(item) }, [])
  return null
}
