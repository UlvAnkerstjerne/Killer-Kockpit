import Link from 'next/link'
import { firstName, type TeamPerson } from '@/lib/tasks/tasks-url'

/**
 * Row of team-member name pills shared by /tasks and /todos. Server-renderable (plain links).
 * The selected person is visually active. Wraps on narrow screens — never scrolls horizontally.
 */
export default function PersonPills({
  people,
  selectedId,
  hrefFor,
}: {
  people: TeamPerson[]
  selectedId: string
  hrefFor: (personId: string) => string
}) {
  return (
    <nav aria-label="Team member" className="flex flex-wrap gap-1 mb-3">
      {people.map(p => {
        const active = p.id === selectedId
        return (
          <Link
            key={p.id}
            href={hrefFor(p.id)}
            aria-current={active ? 'page' : undefined}
            className={[
              'text-xs px-3 py-1.5 rounded-lg transition-colors',
              active
                ? 'bg-[#171717] text-kraft-light font-semibold'
                : 'text-kk-muted hover:bg-[#B7A486]/25 hover:text-kk-ink',
            ].join(' ')}
          >
            {firstName(p.display_name)}
          </Link>
        )
      })}
    </nav>
  )
}
