import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const user = vi.fn()
  const queues: Record<string, { data: unknown[] | null; error: unknown }[]> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const query: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'gte', 'lte', 'order', 'range']) query[method] = (...args: unknown[]) => { calls.push({ table, method, args }); return query }
    query.then = (resolve: (value: unknown) => void) => Promise.resolve(queues[table]?.shift() ?? { data: [], error: null }).then(resolve)
    return query
  })
  return { user, from, queues, calls }
})
vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ from: mocks.from }) }))
import { getPaidPerformance } from '@/lib/actions/marketing/paid-performance'

const now = new Date('2026-09-17T12:00:00Z')
beforeEach(() => {
  vi.clearAllMocks(); mocks.calls.length = 0
  for (const table of Object.keys(mocks.queues)) delete mocks.queues[table]
  mocks.user.mockResolvedValue({ id: 'admin', role: 'SUPER_ADMIN', marketing_access: false })
})

describe('Paid read boundary', () => {
  it('never reads service data without authentication or workspace access', async () => {
    mocks.user.mockResolvedValue(null)
    expect((await getPaidPerformance('90', now)).allowed).toBe(false)
    expect(mocks.from).not.toHaveBeenCalled()
    mocks.user.mockResolvedValue({ id: 'u', role: 'MEMBER', marketing_access: false })
    expect((await getPaidPerformance('90', now)).allowed).toBe(false)
    expect(mocks.from).not.toHaveBeenCalled()
  })
  it('requires paid_manage and fails closed on permission query errors', async () => {
    mocks.user.mockResolvedValue({ id: 'u', role: 'MEMBER', marketing_access: true })
    expect((await getPaidPerformance('90', now)).allowed).toBe(false)
    mocks.queues.user_marketing_permissions = [{ data: [{ permission: 'paid_manage' }], error: { code: 'failed' } }]
    expect((await getPaidPerformance('90', now)).allowed).toBe(false)
    expect(mocks.from.mock.calls.every(([table]) => table === 'user_marketing_permissions')).toBe(true)
  })
  it('allows an authorized Marketing user and scopes both daily queries to the selected period', async () => {
    mocks.user.mockResolvedValue({ id: 'u', role: 'MEMBER', marketing_access: true })
    mocks.queues.user_marketing_permissions = [{ data: [{ permission: 'paid_manage' }], error: null }]
    const report = await getPaidPerformance('90', now)
    expect(report.allowed).toBe(true); expect(report.errors).toEqual([])
    for (const [table, column] of [['meta_campaign_insights', 'date_start'], ['google_ads_campaign_daily', 'date']]) {
      expect(mocks.calls).toContainEqual({ table, method: 'gte', args: [column, '2026-06-19'] })
      expect(mocks.calls).toContainEqual({ table, method: 'lte', args: [column, '2026-09-16'] })
    }
  })
  it('paginates even when the server caps a response below the requested 500 rows', async () => {
    mocks.queues.google_ads_accounts = [
      { data: [{ customer_id: 'a', name: 'First', currency_code: 'DKK', time_zone: 'Europe/Copenhagen' }], error: null },
      { data: [{ customer_id: 'b', name: 'Second', currency_code: 'DKK', time_zone: 'Europe/Copenhagen' }], error: null },
      { data: [], error: null },
    ]
    const report = await getPaidPerformance('28', now)
    expect(report.errors).toEqual([])
    expect(mocks.calls.filter(c => c.table === 'google_ads_accounts' && c.method === 'range').map(c => c.args)).toEqual([[0, 499], [1, 500], [2, 501]])
  })
  it('reports a failed provider without misrepresenting it as zero performance or discarding the other provider', async () => {
    mocks.queues.google_ads_campaign_daily = [{ data: null, error: { message: 'private server error' } }]
    const report = await getPaidPerformance('28', now)
    expect(report.allowed).toBe(true)
    expect(report.errors).toEqual([{ platform: 'google', message: 'Google Ads performance could not be loaded. Reload to try again.' }])
    expect(JSON.stringify(report)).not.toContain('private server error')
  })
})
