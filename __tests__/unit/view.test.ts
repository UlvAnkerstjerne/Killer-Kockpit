import { describe, it, expect } from 'vitest'
import { resolveView, ownedBy } from '@/lib/view'

describe('resolveView', () => {
  it.each(['MEMBER', 'UM', 'SUPER_ADMIN'] as const)('%s defaults to personal (no automatic Management)', (role) => {
    expect(resolveView(role, undefined)).toBe('personal')
    expect(resolveView(role, null)).toBe('personal')
    expect(resolveView(role, '')).toBe('personal')
    expect(resolveView(role, 'personal')).toBe('personal')
    expect(resolveView(role, 'bogus')).toBe('personal')
  })

  it('Management needs an explicit request AND a management role', () => {
    expect(resolveView('UM', 'management')).toBe('management')
    expect(resolveView('SUPER_ADMIN', 'management')).toBe('management')
    expect(resolveView('MEMBER', 'management')).toBe('personal')
  })
})

describe('ownedBy', () => {
  const lydia = 'lydia-id'
  it('drops other users\' tasks and to-dos (RLS lets managers read them)', () => {
    const tasks = [
      { id: 't1', owner_user_id: lydia },
      { id: 't2', owner_user_id: 'sara-id' },
      { id: 't3', owner_user_id: null },
    ]
    expect(ownedBy(tasks, lydia, 'owner_user_id').map(t => t.id)).toEqual(['t1'])
    const todos = [
      { id: 'a', user_id: 'sara-id', recurrence_rule: 'daily' },
      { id: 'b', user_id: lydia, recurrence_rule: 'weekly' },
      { id: 'c', user_id: lydia, recurrence_rule: null },
    ]
    expect(ownedBy(todos, lydia, 'user_id').map(t => t.id)).toEqual(['b', 'c'])
  })

  it('returns an empty list when nothing is owned', () => {
    expect(ownedBy([{ id: 'x', user_id: 'other' }], lydia, 'user_id')).toEqual([])
    expect(ownedBy([], lydia, 'user_id')).toEqual([])
  })
})
