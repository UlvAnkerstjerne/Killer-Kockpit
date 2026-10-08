import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  insert: vi.fn(),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
}))

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ notFound: mocks.notFound, redirect: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({ from: () => ({ insert: mocks.insert }) }),
  createServiceClient: vi.fn(),
}))

const user = (role: string) => ({ id: 'u1', role, display_name: 'U', email: 'u@x.dk', active: true })

beforeEach(() => { vi.clearAllMocks(); mocks.insert.mockResolvedValue({ error: null }) })

describe('addAiCredit', () => {
  const input = { amountUsd: 100, date: '2026-10-08', note: 'Anthropic credit claimed' }

  it.each(['UM', 'MEMBER'])('blocks %s', async (role) => {
    mocks.getCurrentUser.mockResolvedValue(user(role))
    const { addAiCredit } = await import('@/lib/actions/ai-usage')
    expect((await addAiCredit(input)).error).toMatch(/permission/)
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('blocks unauthenticated callers', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    const { addAiCredit } = await import('@/lib/actions/ai-usage')
    expect((await addAiCredit(input)).error).toBeTruthy()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN records a credit attributed to themselves (Copenhagen-midnight timestamp)', async () => {
    mocks.getCurrentUser.mockResolvedValue(user('SUPER_ADMIN'))
    const { addAiCredit } = await import('@/lib/actions/ai-usage')
    expect(await addAiCredit(input)).toEqual({})
    expect(mocks.insert).toHaveBeenCalledWith({
      provider: 'anthropic', amount_usd: 100, occurred_at: '2026-10-07T22:00:00.000Z',
      note: 'Anthropic credit claimed', created_by_user_id: 'u1',
    })
  })

  it.each([0, -5, NaN, 1e9])('rejects invalid amount %s', async (amountUsd) => {
    mocks.getCurrentUser.mockResolvedValue(user('SUPER_ADMIN'))
    const { addAiCredit } = await import('@/lib/actions/ai-usage')
    expect((await addAiCredit({ ...input, amountUsd })).error).toBeTruthy()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('rejects a malformed date and an over-long note', async () => {
    mocks.getCurrentUser.mockResolvedValue(user('SUPER_ADMIN'))
    const { addAiCredit } = await import('@/lib/actions/ai-usage')
    expect((await addAiCredit({ ...input, date: 'yesterday' })).error).toBeTruthy()
    expect((await addAiCredit({ ...input, note: 'x'.repeat(201) })).error).toBeTruthy()
  })

  it('does not auto-insert any credit anywhere in the code', () => {
    const migration = readFileSync(join(process.cwd(), 'supabase/migrations/20261008120000_ai_usage_tracking.sql'), 'utf8')
    expect(migration).not.toMatch(/INSERT INTO\s+(public\.)?ai_credit_events/i)
  })
})

describe('AI Usage page access', () => {
  it.each(['UM', 'MEMBER'])('%s gets a 404 before any data is read', async (role) => {
    mocks.getCurrentUser.mockResolvedValue(user(role))
    const { default: Page } = await import('@/app/(app)/settings/ai-usage/page')
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND')
    expect(mocks.notFound).toHaveBeenCalled()
  })

  it('unauthenticated gets a 404', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    const { default: Page } = await import('@/app/(app)/settings/ai-usage/page')
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND')
  })
})

describe('migration RLS', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261008120000_ai_usage_tracking.sql'), 'utf8')

  it('enables RLS on both tables and revokes broad access', () => {
    expect(sql).toMatch(/ALTER TABLE public\.ai_usage_events\s+ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE public\.ai_credit_events\s+ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/REVOKE ALL ON public\.ai_usage_events\s+FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/REVOKE ALL ON public\.ai_credit_events\s+FROM PUBLIC, anon, authenticated/)
  })

  it('only SUPER_ADMIN may read either table; only service_role may insert telemetry', () => {
    const policies = [...sql.matchAll(/CREATE POLICY[\s\S]*?;/g)].map(m => m[0])
    expect(policies).toHaveLength(3)
    for (const p of policies) expect(p).toContain("get_my_role() = 'SUPER_ADMIN'")
    expect(sql).toMatch(/GRANT SELECT ON public\.ai_usage_events\s+TO authenticated/)
    expect(sql).not.toMatch(/GRANT[^;]*INSERT[^;]*ai_usage_events[^;]*TO authenticated/)
    expect(sql).toMatch(/GRANT SELECT, INSERT ON public\.ai_usage_events\s+TO service_role/)
  })

  it('stores no content columns', () => {
    const table = sql.slice(sql.indexOf('CREATE TABLE public.ai_usage_events'), sql.indexOf('CREATE INDEX')).replace(/--.*$/gm, '')
    expect(table).not.toMatch(/\b(prompt|response|content|body|text_input|messages)\b/i)
    expect(table).toContain('numeric(12,8)')
  })
})
