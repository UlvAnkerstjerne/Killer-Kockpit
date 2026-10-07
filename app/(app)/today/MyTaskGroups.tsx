import Link from 'next/link'
import { getDueState } from '@/lib/today/weekUtils'
import type { DuedTask, TaskGroupKey } from '@/lib/today/myTasks'
import { PriorityDot } from '@/components/ui/PriorityDot'
import { DUE_STATE_CONFIG, formatShortDate } from './dueDisplay'

/**
 * Deadline-grouped rows for the Today "My tasks" card.
 * Groups arrive already filtered, deduplicated and sorted by buildMyTasks().
 */
export default function MyTaskGroups({
  groups,
  now,
  weekEnd,
}: {
  groups: { key: TaskGroupKey; label: string; items: DuedTask[] }[]
  now: Date
  weekEnd: Date
}) {
  return (
    <>
      {groups.map(group => (
        <div key={group.key} role="group" aria-label={group.label}>
          <div className="px-4 py-0.5 bg-[#B7A486]/20 text-[10px] font-bold tracking-[0.1em] uppercase text-kk-muted">
            {group.label} · {group.items.length}
          </div>
          <div className="divide-y divide-[#171717]/15">
            {group.items.map(t => {
              const cfg = DUE_STATE_CONFIG[getDueState(t.due_at, now, weekEnd)]
              return (
                <Link
                  key={`task-${t.id}`}
                  href={`/tasks/${t.id}?returnTo=/today`}
                  className="flex items-center gap-3 px-4 py-2 hover:bg-[#B7A486]/25 transition-colors group"
                >
                  <PriorityDot priority={t.priority} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">
                      {t.title}
                    </span>
                  </div>
                  {cfg.label ? (
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${cfg.cls}`}>
                      {cfg.label}
                    </span>
                  ) : t.due_at ? (
                    <span className="text-xs text-kk-muted shrink-0">{formatShortDate(t.due_at)}</span>
                  ) : null}
                </Link>
              )
            })}
          </div>
        </div>
      ))}
    </>
  )
}
