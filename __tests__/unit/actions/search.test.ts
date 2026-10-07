import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  orCalls: [] as string[],
  neqCols: [] as string[],
  results: {} as Record<string, { data: unknown[] | null; error: unknown }>,
}))

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      for (const m of ['select', 'is', 'ilike', 'eq', 'order']) chain[m] = self
      // Record columns used for filtering so a non-existent column is caught (meetings has no cancelled_at).
      chain.neq = (col: string) => { mocks.neqCols.push(`${table}.${col}`); return chain }
      chain.or = (f: string) => { mocks.orCalls.push(f); return chain }
      chain.limit = () => Promise.resolve(mocks.results[table] ?? { data: [], error: null })
      return chain
    },
  }),
}))

const USER = { id: 'u1', role: 'MEMBER', display_name: 'U', email: 'u@x.dk', active: true }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.orCalls.length = 0
  mocks.neqCols.length = 0
  mocks.results = {}
  mocks.getCurrentUser.mockResolvedValue(USER)
})

describe('globalSearch', () => {
  it('returns matching tasks', async () => {
    mocks.results.tasks = { data: [{ id: 't1', title: 'Lufthavns actionplan', status: 'pending_review' }], error: null }
    const { globalSearch } = await import('@/lib/actions/search')
    const r = await globalSearch('Lufthavns')
    expect(r.tasks).toEqual([
      { kind: 'task', id: 't1', title: 'Lufthavns actionplan', subtitle: 'pending review', href: '/tasks/t1' },
    ])
  })

  it('returns empty groups (not an error) when nothing matches', async () => {
    const { globalSearch } = await import('@/lib/actions/search')
    const r = await globalSearch('zzz')
    expect(Object.values(r).every(g => g.length === 0)).toBe(true)
  })

  it('throws when a query fails, so the UI shows a failure instead of "No results"', async () => {
    mocks.results.projects = { data: null, error: { message: 'db down' } }
    const { globalSearch } = await import('@/lib/actions/search')
    await expect(globalSearch('Lufthavns')).rejects.toThrow('Search failed')
  })

  it('quotes the pattern so commas, parentheses and quotes are data, not filter syntax', async () => {
    const { globalSearch } = await import('@/lib/actions/search')
    await globalSearch('a, b) "c"')
    expect(mocks.orCalls.length).toBeGreaterThan(0)
    for (const f of mocks.orCalls) expect(f).toContain('ilike."%a, b) \\"c\\"%"')
  })

  it('excludes cancelled meetings via status (the meetings table has no cancelled_at column)', async () => {
    const { globalSearch } = await import('@/lib/actions/search')
    await globalSearch('x')
    expect(mocks.neqCols).toContain('meetings.status')
  })

  it('returns nothing for unauthenticated callers', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    const { globalSearch } = await import('@/lib/actions/search')
    const r = await globalSearch('x')
    expect(r.tasks).toEqual([])
  })
})
