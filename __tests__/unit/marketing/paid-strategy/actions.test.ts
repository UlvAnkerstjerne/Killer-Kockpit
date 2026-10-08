import { beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from '../../../helpers/paid-strategy'

const mocks = vi.hoisted(() => ({ user: vi.fn(), permissions: vi.fn(), client: vi.fn(), service: vi.fn(), generate: vi.fn(), revalidate: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/actions/marketing/permissions', () => ({ getUserMarketingPermissions: mocks.permissions }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client, createServiceClient: mocks.service }))
vi.mock('@/lib/marketing/paid-strategy/generate', () => ({ generatePaidStrategy: mocks.generate }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
import { generatePaidStrategyAnalysis, getPaidStrategy } from '@/lib/actions/marketing/paid-strategy'

type Result = { data?: unknown; error?: unknown }
/** Chainable query double: awaiting it or calling maybeSingle() both yield `result`. */
function chain(result: Result) {
  const q: Record<string, unknown> = {}
  for (const name of ['select', 'eq', 'order', 'limit']) q[name] = vi.fn(() => q)
  q.maybeSingle = vi.fn(async () => result)
  q.then = (resolve: (r: Result) => unknown) => Promise.resolve(result).then(resolve)
  return q
}
function database(latest: Result, history: Result, attempt: Result) {
  const queries = [chain(latest), chain(history), chain(attempt)]
  const from = vi.fn()
  queries.forEach(q => from.mockReturnValueOnce(q))
  mocks.client.mockResolvedValue({ from })
  return { from, queries }
}

beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue(null); mocks.permissions.mockResolvedValue([]) })

describe('generatePaidStrategyAnalysis authorization', () => {
  it('rejects unauthenticated and non-SUPER_ADMIN callers before the service client exists', async () => {
    expect((await generatePaidStrategyAnalysis()).ok).toBe(false)
    for (const role of ['UM', 'MEMBER']) {
      mocks.user.mockResolvedValue({ id: 'u', role, marketing_access: true })
      mocks.permissions.mockResolvedValue(['paid_manage', 'paid_approve'])
      expect((await generatePaidStrategyAnalysis()).error).toContain('SUPER_ADMIN')
    }
    expect(mocks.service).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })
  it('authorizes the current admin, passes its own identity and revalidates the Brain route', async () => {
    mocks.user.mockResolvedValue({ id: 'current-admin', role: 'SUPER_ADMIN', marketing_access: false })
    mocks.service.mockReturnValue({ server: true }); mocks.generate.mockResolvedValue({ ok: true, recommendationCount: 3 })
    expect(await generatePaidStrategyAnalysis()).toEqual({ ok: true, recommendationCount: 3 })
    expect(mocks.generate).toHaveBeenCalledWith({ server: true }, 'current-admin')
    expect(mocks.revalidate).toHaveBeenCalledWith('/marketing/brain')
  })
  it('accepts no input from the browser: identity and options are server-side only', () => {
    expect(generatePaidStrategyAnalysis.length).toBe(0)
  })
})

describe('getPaidStrategy', () => {
  it('requires workspace access and paid_manage independently, without touching the database', async () => {
    for (const [marketing_access, permissions] of [[false, ['paid_manage']], [true, []], [true, ['paid_approve']]] as const) {
      mocks.user.mockResolvedValue({ id: 'u', role: 'MEMBER', marketing_access })
      mocks.permissions.mockResolvedValue(permissions)
      expect(await getPaidStrategy()).toMatchObject({ allowed: false, canGenerate: false, latest: null })
    }
    expect((await getPaidStrategy()).allowed).toBe(false)
    expect(mocks.client).not.toHaveBeenCalled()
    expect(mocks.service).not.toHaveBeenCalled()
  })
  it('lets a paid_manage reader read but not generate, using the user session and no AI', async () => {
    mocks.user.mockResolvedValue({ id: 'reader', role: 'MEMBER', marketing_access: true }); mocks.permissions.mockResolvedValue(['paid_manage'])
    const latest = run({ id: 'new' })
    const older = run({ id: 'old', generated_at: '2026-09-01T10:00:00Z' })
    const db = database({ data: latest }, { data: [latest, older] }, { data: { status: 'completed', error: null } })
    const data = await getPaidStrategy()
    expect(data).toMatchObject({ allowed: true, canGenerate: false, error: null })
    expect(data.latest?.id).toBe('new')
    expect(data.previous.map(r => r.id)).toEqual(['old'])
    expect(db.from).toHaveBeenCalledTimes(3)
    expect(db.from).toHaveBeenCalledWith('marketing_paid_strategy_runs')
    expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled()
  })
  it('lists previous runs without the heavy evidence column and only completed runs', async () => {
    mocks.user.mockResolvedValue({ id: 'a', role: 'SUPER_ADMIN', marketing_access: false })
    const db = database({ data: null }, { data: [] }, { data: null })
    const data = await getPaidStrategy()
    expect(data).toMatchObject({ allowed: true, canGenerate: true, latest: null, previous: [] })
    const [latestQ, historyQ] = db.queries
    expect(latestQ.select).toHaveBeenCalledWith('*')
    expect(historyQ.select).toHaveBeenCalledWith(expect.not.stringContaining('evidence'))
    expect(historyQ.eq).toHaveBeenCalledWith('status', 'completed')
    expect(latestQ.order).toHaveBeenCalledWith('generated_at', { ascending: false })
  })
  it('distinguishes storage failure from a genuinely empty first state', async () => {
    mocks.user.mockResolvedValue({ id: 'a', role: 'SUPER_ADMIN' })
    database({ data: null, error: { code: '42P01' } }, { data: [] }, { data: null })
    expect((await getPaidStrategy()).error).toContain('storage is unavailable')
  })
})
