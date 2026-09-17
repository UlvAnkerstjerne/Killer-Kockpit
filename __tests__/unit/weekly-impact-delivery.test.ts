import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ db: vi.fn(), generate: vi.fn(), send: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.db }))
vi.mock('@/lib/weekly-impact/generate', () => ({ generateWeeklyImpactPreview: mocks.generate }))
vi.mock('@/lib/weekly-impact/send-email', () => ({ sendWeeklyImpactEmail: mocks.send }))
import { runWeeklyImpactDispatch } from '@/lib/weekly-impact/dispatch'

const ulv = '5363b471-b4cb-4156-9e8e-3260d3ecb05e'
const other = '00000000-0000-4000-8000-000000000002'
const friday = new Date('2026-09-18T14:00:00Z')
type Row = Record<string, unknown>
let rows: Row[], failLookup: boolean, failPayload: boolean, failSentWrite: boolean
const users = [{ id: ulv, email: 'ulv@example.com', active: true }, { id: other, email: 'other@example.com', active: true }, { id: 'inactive', active: false }]

function database() {
  return { from(table: string) {
    let operation = 'select', patch: Row = {}
    const filters: Array<[string, unknown]> = []
    const run = () => {
      const matches = (row: Row) => filters.every(([key, value]) => row[key] === value)
      if (table === 'app_users') return { data: users.filter(matches), error: null }
      if (operation === 'select') {
        if (failLookup) return { data: null, error: { message: 'lookup unavailable' } }
        return { data: structuredClone(rows.find(matches) ?? null), error: null }
      }
      if (operation === 'insert') {
        if (rows.some(row => row.user_id === patch.user_id && row.week_start === patch.week_start)) return { data: null, error: { code: '23505' } }
        const row = { id: `delivery-${rows.length}`, status: 'generating', attempt_count: 1, ...patch }
        rows.push(row)
        return { data: { id: row.id }, error: null }
      }
      if (failPayload && patch.payload_json) return { data: null, error: { message: 'payload unavailable' } }
      if (failSentWrite && patch.status === 'sent') { failSentWrite = false; return { data: null, error: { message: 'write unavailable' } } }
      const row = rows.find(matches)
      if (!row) return { data: null, error: null }
      Object.assign(row, patch)
      return { data: { id: row.id }, error: null }
    }
    const query = {
      select: () => query, order: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
      insert: (value: Row) => { operation = 'insert'; patch = value; return query },
      update: (value: Row) => { operation = 'update'; patch = value; return query },
      maybeSingle: async () => run(), single: async () => run(),
      then: (resolve: (value: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
    }
    return query
  } }
}

beforeEach(() => {
  rows = []; failLookup = false; failPayload = false; failSentWrite = false
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(friday)
  vi.stubEnv('WEEKLY_IMPACT_DELIVERY_ENABLED', 'true')
  mocks.db.mockImplementation(database)
  mocks.generate.mockResolvedValue({ subject: 'Approved week', html: '<p>Approved</p>', text: 'Approved', evidence: { preserved: true }, brief: { preserved: true } })
  mocks.send.mockResolvedValue({ ok: true, id: 'provider-1' })
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

describe('Weekly Impact delivery safety', () => {
  it('keeps scheduled sends disabled by default', async () => {
    vi.stubEnv('WEEKLY_IMPACT_DELIVERY_ENABLED', '')
    expect((await runWeeklyImpactDispatch(friday)).status).toBe('disabled')
    expect(mocks.db).not.toHaveBeenCalled()
  })
  it('does not query users outside Friday 16:00 Copenhagen', async () => {
    expect((await runWeeklyImpactDispatch(new Date('2026-09-17T14:00:00Z'))).status).toBe('outside_window')
    expect(mocks.db).not.toHaveBeenCalled()
  })
  it('allows exactly the selected active test user while the team gate is disabled', async () => {
    vi.stubEnv('WEEKLY_IMPACT_DELIVERY_ENABLED', 'false')
    expect(await runWeeklyImpactDispatch(new Date('2026-09-17T14:00:00Z'), ulv)).toMatchObject({ users: 1, sent: 1 })
    expect(mocks.send.mock.calls[0]).toEqual([{ recipient: 'ulv@example.com', subject: 'Approved week', html: '<p>Approved</p>', text: 'Approved' }, `weekly-impact/${ulv}/2026-09-14`])
    expect(rows).toHaveLength(1)
  })
  it('rejects an empty target rather than falling back to the team', async () => {
    await expect(runWeeklyImpactDispatch(friday, '')).rejects.toThrow('single valid test user')
    expect(mocks.db).not.toHaveBeenCalled()
  })
  it('sends only active users and skips successful deliveries on another run', async () => {
    expect(await runWeeklyImpactDispatch(friday)).toMatchObject({ users: 2, sent: 2 })
    expect(await runWeeklyImpactDispatch(friday)).toMatchObject({ sent: 0, skipped: 2 })
    expect(mocks.send).toHaveBeenCalledTimes(2)
  })
  it('allows only one insertion to win simultaneous first delivery attempts', async () => {
    await Promise.all([runWeeklyImpactDispatch(friday, ulv), runWeeklyImpactDispatch(friday, ulv)])
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(rows).toHaveLength(1)
  })
  it('retries a rejected send with the frozen payload and same idempotency key', async () => {
    mocks.send.mockResolvedValueOnce({ ok: false, error: 'Rate limited', uncertain: false })
    expect((await runWeeklyImpactDispatch(friday, ulv)).failed).toBe(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].send_started_at).toBeNull()
    expect((await runWeeklyImpactDispatch(friday, ulv)).sent).toBe(1)
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    expect(mocks.send.mock.calls[1]).toEqual(mocks.send.mock.calls[0])
  })
  it('atomically claims a failed retry so competing runs cannot both send', async () => {
    mocks.send.mockResolvedValueOnce({ ok: false, error: 'Rate limited', uncertain: false })
    await runWeeklyImpactDispatch(friday, ulv)
    await Promise.all([runWeeklyImpactDispatch(friday, ulv), runWeeklyImpactDispatch(friday, ulv)])
    expect(mocks.send).toHaveBeenCalledTimes(2)
    expect(rows[0].attempt_count).toBe(2)
  })
  it('does not send when ledger lookup fails', async () => {
    failLookup = true
    expect((await runWeeklyImpactDispatch(friday, ulv)).failed).toBe(1)
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('does not send before its stable payload is persisted', async () => {
    failPayload = true
    expect((await runWeeklyImpactDispatch(friday, ulv)).failed).toBe(1)
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('reconciles an accepted provider receipt without resending after a ledger write failure', async () => {
    failSentWrite = true
    expect((await runWeeklyImpactDispatch(friday, ulv)).failed).toBe(1)
    expect(rows[0].resend_id).toBe('provider-1')
    expect((await runWeeklyImpactDispatch(friday, ulv)).skipped).toBe(1)
    expect(rows[0].status).toBe('sent')
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
  it('never blindly resends an uncertain attempt after provider idempotency expires', async () => {
    mocks.send.mockResolvedValueOnce({ ok: false, error: 'Connection lost', uncertain: true })
    await runWeeklyImpactDispatch(friday, ulv)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await runWeeklyImpactDispatch(new Date(friday.getTime() + 24 * 60 * 60 * 1000), ulv)).failed).toBe(1)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })
})
