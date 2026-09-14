'use client'

import Link from 'next/link'
import { useRecentlyOpened, type RecentItemType } from '@/lib/hooks/useRecentlyOpened'

const TYPE_LABEL: Record<RecentItemType, string> = {
  task:        'Task',
  project:     'Project',
  meeting:     'Meeting',
  waiting_on:  'WO',
}

export default function RecentlyOpened({ userId, onNavigate }: { userId: string; onNavigate?: () => void }) {
  const { recents } = useRecentlyOpened(userId)
  if (recents.length === 0) return null

  return (
    <div className="mt-2 mb-1">
      <div className="px-2.5 mb-1 text-[10px] font-bold tracking-[0.12em] uppercase text-kk-ink/40">
        Recent
      </div>
      <div className="space-y-0.5">
        {recents.map(item => (
          <Link
            key={`${item.type}:${item.id}`}
            href={item.href}
            onClick={onNavigate}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg text-xs text-kk-muted hover:bg-kk-soft hover:text-kk-ink transition-colors"
          >
            <span className="truncate flex-1 leading-snug">{item.title}</span>
            <span className="text-[9px] text-kk-ink/30 shrink-0 font-medium">{TYPE_LABEL[item.type]}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
