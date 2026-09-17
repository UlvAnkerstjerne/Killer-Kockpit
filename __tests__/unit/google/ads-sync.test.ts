import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ db: vi.fn(), probe: vi.fn(), client: vi.fn(), search: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.db }))
vi.mock('@/lib/google/auth', () => ({ getGoogleOAuth2Client: mocks.client, hasGoogleAdsScope: (scopes: string[]) => scopes.includes('ads') }))
vi.mock('@/lib/google/ads', () => ({ probeGoogleAds: mocks.probe }))
vi.mock('@/lib/google/ads-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/google/ads-client')>()
  return { ...actual, searchGoogleAds: mocks.search }
})
import { runGoogleAdsSync } from '@/lib/google/ads-sync'
import { GoogleAdsReportingError } from '@/lib/google/ads-client'

type RecordRow = Record<string, unknown>
const customerId = '8582465933'
const now = new Date('2026-09-17T06:00:00Z')
let state: RecordRow | null
let failTable: string | undefined
let loseClaim: boolean
let writes: Array<{ table: string; rows: RecordRow[]; options: unknown }>

class Query {
  operation = 'select'; patch: RecordRow = {}; rows: RecordRow[] = []; options: unknown
  filters: Array<[string, unknown]> = []; singleRow = false
  constructor(readonly table: string) {}
  select() { return this }
  order() { return this }
  range() { return this }
  gte() { return this }
  lte() { return this }
  in() { return this }
  eq(key: string, value: unknown) { this.filters.push([key, value]); return this }
  is(key: string, value: unknown) { return this.eq(key, value) }
  maybeSingle() { this.singleRow = true; return this }
  single() { this.singleRow = true; return this }
  insert(patch: RecordRow) { this.operation = 'insert'; this.patch = patch; return this }
  update(patch: RecordRow) { this.operation = 'update'; this.patch = patch; return this }
  upsert(rows: RecordRow[], options: unknown) { this.operation = 'upsert'; this.rows = rows; this.options = options; return this }
  async then(resolve: (value: { data: unknown; error: unknown }) => unknown) {
    if (this.table === failTable) return resolve({ data: null, error: { code: 'XX000' } })
    if (this.table === 'integration_sync_state') {
      if (this.operation === 'select') return resolve({ data: state ? { ...state } : null, error: null })
      if (loseClaim && (this.operation === 'insert' || this.patch.status === 'syncing')) {
        return resolve({ data: null, error: this.operation === 'insert' ? { code: '23505' } : null })
      }
      if (this.operation === 'insert') state = { id: 'state', cursor: null, last_success_at: null, ...this.patch }
      else if (state && this.filters.every(([key, value]) => state![key] === value)) state = { ...state, ...this.patch }
      else return resolve({ data: null, error: { code: 'NOT_FOUND' } })
      return resolve({ data: { id: state!.id }, error: null })
    }
    if (this.operation === 'upsert') { writes.push({ table: this.table, rows: this.rows, options: this.options }); return resolve({ data: null, error: null }) }
    const data = this.table === 'google_oauth_tokens' ? [{ user_id: 'admin', scopes: ['ads'] }]
      : this.table === 'app_users' ? [{ id: 'admin' }] : []
    return resolve({ data, error: null })
  }
}

beforeEach(() => {
  vi.clearAllMocks(); state = null; failTable = undefined; loseClaim = false; writes = []
  mocks.db.mockReturnValue({ from: (table: string) => new Query(table) })
  mocks.probe.mockResolvedValue({ ok: true, customerIds: [customerId] })
  mocks.client.mockResolvedValue({})
  mocks.search.mockImplementation(async (_client, _id, query: string) => {
    if (query.endsWith('FROM customer')) return [{ customer: { id: customerId, currencyCode: 'DKK', timeZone: 'Europe/Copenhagen' } }]
    if (query.includes('FROM conversion_action')) return [{ conversionAction: { resourceName: `customers/${customerId}/conversionActions/2`, id: '2', name: 'Lead form', status: 'ENABLED', type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM', primaryForGoal: true } }]
    if (query.includes('FROM campaign_conversion_goal')) return [{ campaignConversionGoal: { campaign: `customers/${customerId}/campaigns/1`, category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', biddable: true } }]
    if (query.includes('FROM conversion_goal_campaign_config')) return []
    if (query.includes('segments.conversion_action')) return []
    if (query.includes('segments.date')) return [{ campaign: { id: '1' }, segments: { date: '2026-09-16' }, metrics: { costMicros: '84000000', conversions: '1.5' } }]
    return [{ campaign: { id: '1', name: 'Source name', status: 'ENABLED', advertisingChannelType: 'SEARCH' } }]
  })
})

describe('institutional Google Ads sync', () => {
  it('backfills 90 days and saves source goals, currency and daily upserts before advancing the cursor', async () => {
    const result = await runGoogleAdsSync(now)
    expect(result).toMatchObject({ ok: true, isBackfill: true, dailyRows: 1, dateRange: { start: '2026-06-19', end: '2026-09-16' } })
    expect(writes.find(w => w.table === 'google_ads_accounts')?.rows[0]).toMatchObject({ currency_code: 'DKK', time_zone: 'Europe/Copenhagen' })
    expect(writes.find(w => w.table === 'google_ads_campaigns')?.rows[0]).toMatchObject({ name: 'Source name', goal_config_level: null, conversion_goals: [{ category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', biddable: true }] })
    expect(writes.find(w => w.table === 'google_ads_campaign_daily')?.options).toEqual({ onConflict: 'customer_id,campaign_id,date' })
    expect(state).toMatchObject({ user_id: null, status: 'synced', cursor: '2026-09-16' })
    expect(state?.last_success_at).toBeTruthy()
  })
  it('uses 14 days only after a successful backfill', async () => {
    await runGoogleAdsSync(now)
    const result = await runGoogleAdsSync(new Date('2026-09-18T06:00:00Z'))
    expect(result).toMatchObject({ ok: true, isBackfill: false, dateRange: { start: '2026-09-04', end: '2026-09-17' } })
  })
  it('records the real production access failure and retries the full backfill after access is fixed', async () => {
    mocks.search.mockRejectedValueOnce(new GoogleAdsReportingError('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION'))
    const failed = await runGoogleAdsSync(now)
    expect(failed.ok).toBe(false); expect(failed.errors[0]).toContain('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION')
    expect(writes).toEqual([]); expect(state).toMatchObject({ status: 'failed', last_success_at: null, cursor: null })
    expect(await runGoogleAdsSync(new Date('2026-09-17T07:00:00Z'))).toMatchObject({ ok: true, isBackfill: true })
  })
  it('does not advance a cursor when a data write fails', async () => {
    failTable = 'google_ads_campaign_daily'
    expect((await runGoogleAdsSync(now)).ok).toBe(false)
    expect(state).toMatchObject({ status: 'failed', last_success_at: null, cursor: null })
  })
  it('fails closed on a sync-state lookup failure', async () => {
    failTable = 'integration_sync_state'
    expect((await runGoogleAdsSync(now)).ok).toBe(false)
    expect(mocks.probe).not.toHaveBeenCalled()
  })
  it('skips overlapping jobs and lost atomic claims before calling Google', async () => {
    state = { id: 'state', status: 'syncing', last_success_at: null, last_attempt_at: now.toISOString() }
    expect(await runGoogleAdsSync(now)).toMatchObject({ ok: true, skipped: true })
    state = null; loseClaim = true
    expect(await runGoogleAdsSync(now)).toMatchObject({ ok: true, skipped: true })
    expect(mocks.probe).not.toHaveBeenCalled()
  })
  it('does not ingest another account just because the OAuth user can access it', async () => {
    mocks.probe.mockResolvedValue({ ok: true, customerIds: ['1234567890'] })
    expect((await runGoogleAdsSync(now)).ok).toBe(false); expect(mocks.search).not.toHaveBeenCalled()
  })
})
