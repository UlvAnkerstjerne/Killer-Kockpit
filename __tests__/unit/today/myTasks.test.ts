import { describe, it, expect } from 'vitest'
import { buildMyTasks, classifyTaskGroup, compareDuedTasks } from '@/lib/today/myTasks'

// 7 Oct 2026 14:00 Copenhagen (CEST, UTC+2) = 12:00Z
const NOW = new Date('2026-10-07T12:00:00Z')

type T = { id: string; title: string; priority: number; due_at: string | null }
const task = (id: string, priority: number, due_at: string | null, title = id): T => ({ id, title, priority, due_at })

describe('classifyTaskGroup (Europe/Copenhagen, instant deadlines)', () => {
  it('past instants are overdue, including earlier the same day', () => {
    expect(classifyTaskGroup('2026-10-06T08:00:00Z', NOW)).toBe('overdue')
    expect(classifyTaskGroup('2026-10-07T07:00:00Z', NOW)).toBe('overdue') // 09:00 Copenhagen, already passed
  })

  it('later today is "today" up to Copenhagen midnight', () => {
    expect(classifyTaskGroup('2026-10-07T12:00:01Z', NOW)).toBe('today')
    expect(classifyTaskGroup('2026-10-07T21:59:59Z', NOW)).toBe('today') // 23:59:59 Copenhagen
  })

  it('Copenhagen midnight starts the next day (not UTC midnight)', () => {
    expect(classifyTaskGroup('2026-10-07T22:00:00Z', NOW)).toBe('upcoming') // 00:00 on 8 Oct Copenhagen
    expect(classifyTaskGroup('2026-10-09T10:00:00Z', NOW)).toBe('upcoming')
  })

  it('treats a UTC evening time that is already tomorrow in Copenhagen as upcoming', () => {
    expect(classifyTaskGroup('2026-10-07T23:30:00Z', NOW)).toBe('upcoming')
  })

  it('missing or invalid dates have no due date', () => {
    expect(classifyTaskGroup(null, NOW)).toBe('no_date')
    expect(classifyTaskGroup('not a date', NOW)).toBe('no_date')
  })
})

describe('compareDuedTasks', () => {
  it('orders Critical → Normal → Low → Background, then due time, then a stable tie-breaker', () => {
    const rows = [
      task('d', 4, '2026-10-01T00:00:00Z'),
      task('b', 2, '2026-10-02T00:00:00Z'),
      task('a2', 1, '2026-10-05T00:00:00Z'),
      task('a1', 1, '2026-10-03T00:00:00Z'),
      task('c', 3, '2026-10-02T00:00:00Z'),
    ]
    expect(rows.sort(compareDuedTasks).map(r => r.id)).toEqual(['a1', 'a2', 'b', 'c', 'd'])
  })

  it('is deterministic for identical priority and due time (title, then id)', () => {
    const rows = [task('z', 2, '2026-10-02T00:00:00Z', 'Same'), task('y', 2, '2026-10-02T00:00:00Z', 'Same'), task('x', 2, '2026-10-02T00:00:00Z', 'Alpha')]
    const asc = [...rows].sort(compareDuedTasks).map(r => r.id)
    const desc = [...rows].reverse().sort(compareDuedTasks).map(r => r.id)
    expect(asc).toEqual(['x', 'y', 'z'])
    expect(desc).toEqual(asc)
  })

  it('sorts unknown priorities after Background and undated rows after dated ones', () => {
    const rows = [task('u', 0, null), task('bg', 4, '2026-10-02T00:00:00Z'), task('nd', 4, null)]
    expect(rows.sort(compareDuedTasks).map(r => r.id)).toEqual(['bg', 'nd', 'u'])
  })
})

describe('buildMyTasks', () => {
  it('puts a Critical overdue task ahead of earlier-listed future tasks (the "11th row" case)', () => {
    const future = Array.from({ length: 10 }, (_, i) => task(`f${i}`, 2, `2026-10-0${8 + (i % 2)}T10:00:00Z`))
    const critical = task('sop', 1, '2026-10-06T10:00:00Z', 'Send list of photos needed for the bread SOP')
    const { groups } = buildMyTasks({ pendingReview: [], returned: [], tasks: [...future, critical], now: NOW })
    expect(groups[0].key).toBe('overdue')
    expect(groups[0].items[0].id).toBe('sop')
    expect(groups.map(g => g.key)).toEqual(['overdue', 'upcoming'])
  })

  it('orders groups Overdue → Due today → Upcoming → No due date and omits empty groups', () => {
    const { groups } = buildMyTasks({
      pendingReview: [], returned: [], now: NOW,
      tasks: [
        task('nd', 1, null),
        task('up', 1, '2026-10-09T10:00:00Z'),
        task('td', 1, '2026-10-07T15:00:00Z'),
        task('od', 4, '2026-10-01T10:00:00Z'),
      ],
    })
    expect(groups.map(g => [g.key, g.label])).toEqual([
      ['overdue', 'Overdue'], ['today', 'Due today'], ['upcoming', 'Upcoming'], ['no_date', 'No due date'],
    ])
  })

  it('count equals the rows rendered, and a task in several queries is shown and counted once', () => {
    // "Lufthavns actionplan": I requested it, it is pending my review, AND it is due this week.
    const review = { id: 'luft', title: 'Lufthavns actionplan', priority: 2 }
    const out = buildMyTasks({
      pendingReview: [review],
      returned: [{ id: 'ret' }],
      tasks: [task('luft', 2, '2026-10-07T20:00:00Z'), task('ret', 2, '2026-10-06T10:00:00Z'), task('a', 2, '2026-10-06T11:00:00Z')],
      now: NOW,
    })
    const rendered = out.review.length + out.returned.length + out.groups.reduce((n, g) => n + g.items.length, 0)
    expect(out.count).toBe(rendered)
    expect(out.count).toBe(3)
    expect(out.review.map(r => r.id)).toEqual(['luft'])
    expect(out.returned.map(r => r.id)).toEqual(['ret'])
    expect(out.groups.flatMap(g => g.items.map(i => i.id))).toEqual(['a'])
  })

  it('dedupes duplicate rows within a single list', () => {
    const out = buildMyTasks({ pendingReview: [], returned: [], tasks: [task('a', 2, null), task('a', 2, null)], now: NOW })
    expect(out.count).toBe(1)
  })

  it('handles only review items, and an empty list', () => {
    const only = buildMyTasks({ pendingReview: [{ id: 'r1' }, { id: 'r2' }], returned: [], tasks: [], now: NOW })
    expect(only.count).toBe(2)
    expect(only.groups).toEqual([])

    const empty = buildMyTasks({ pendingReview: [], returned: [], tasks: [], now: NOW })
    expect(empty).toEqual({ review: [], returned: [], groups: [], count: 0 })
  })

  it('is stable regardless of input order', () => {
    const rows = [task('a', 2, '2026-10-02T10:00:00Z'), task('b', 1, '2026-10-03T10:00:00Z'), task('c', 2, '2026-10-02T10:00:00Z')]
    const one = buildMyTasks({ pendingReview: [], returned: [], tasks: rows, now: NOW }).groups[0].items.map(i => i.id)
    const two = buildMyTasks({ pendingReview: [], returned: [], tasks: [...rows].reverse(), now: NOW }).groups[0].items.map(i => i.id)
    expect(one).toEqual(['b', 'a', 'c'])
    expect(two).toEqual(one)
  })
})
