'use client'

import Link from 'next/link'
import { useScrollRestoration } from '@/hooks/useScrollRestoration'
import { MeetingStatusBadge } from '@/components/ui/MeetingStatusBadge'
import type { MeetingStatus } from '@/lib/types'

export type MeetingRow = {
  id: string
  title: string
  status: string
  scheduled_start: string | null
  scheduled_end?: string | null
  owner: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined
  project: { id: string; title: string } | Array<{ id: string; title: string }> | undefined
}

function formatDateTime(dt: string | null) {
  if (!dt) return null
  return new Date(dt).toLocaleDateString('en-GB', {
    timeZone: 'Europe/Copenhagen',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function MeetingList({ meetings }: { meetings: MeetingRow[] }) {
  const { saveScroll } = useScrollRestoration('meetings-list')

  return (
    <div className="divide-y divide-kk-line">
      {meetings.map(m => {
        const owner = Array.isArray(m.owner) ? m.owner[0] : m.owner
        const project = Array.isArray(m.project) ? m.project[0] : m.project
        return (
          <Link
            key={m.id}
            href={`/meetings/${m.id}`}
            onClick={saveScroll}
            className="flex items-center gap-4 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-kk-ink group-hover:underline truncate">
                  {m.title}
                </span>
                <MeetingStatusBadge status={m.status as MeetingStatus} />
              </div>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                {owner && <span className="text-xs text-kk-muted">{owner.display_name}</span>}
                {project && <span className="text-xs text-kk-muted">· {project.title}</span>}
              </div>
            </div>
            {m.scheduled_start && (
              <div className="text-xs text-kk-muted shrink-0">
                {formatDateTime(m.scheduled_start)}
              </div>
            )}
          </Link>
        )
      })}
    </div>
  )
}
