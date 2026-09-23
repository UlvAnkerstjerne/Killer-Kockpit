import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gbpDb } from '../../helpers/gbp-db'
const mocks = vi.hoisted(() => ({ client: vi.fn(), accounts: vi.fn(), locations: vi.fn(), wildcardLocations: vi.fn(), metrics: vi.fn(), keywords: vi.fn(), reviews: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mocks.client() }))
vi.mock('@/lib/google/auth', () => ({ getGoogleOAuth2Client: vi.fn().mockResolvedValue({}), hasGbpScope: (scopes: string[]) => scopes.includes('business.manage') }))
vi.mock('@/lib/google/gbp-client', () => ({ fetchGbpAccounts: mocks.accounts, fetchGbpLocations: mocks.locations, fetchGbpLocationsWildcard: mocks.wildcardLocations, fetchLocationMetrics: mocks.metrics, fetchGbpSearchKeywords: mocks.keywords, safeGbpError: () => 'Safe Google API failure' }))
vi.mock('@/lib/gbp/reviews-sync', () => ({ syncLocationReviews: mocks.reviews, retryDraftForReview: vi.fn() }))
import { runGbpSync } from '@/lib/gbp/sync'
let db: ReturnType<typeof gbpDb>
const now = new Date('2026-09-17T10:00:00Z')
const location = { id: 'gbp-1', google_account_id: '1', google_location_id: '2', store_name: 'Internal name', store_short_name: 'Store', active: true, location_id: 'canonical-1', activation_date: '2026-09-01' }
const state = (name: string) => db.tables.integration_sync_state.find(row => row.integration === name)!
beforeEach(() => {
  vi.clearAllMocks(); db = gbpDb(); mocks.client.mockReturnValue(db)
  db.tables.google_oauth_tokens = [{ user_id: 'admin', scopes: ['business.manage'] }]
  db.tables.app_users = [{ id: 'admin', role: 'SUPER_ADMIN', active: true }]
  db.tables.gbp_locations = [{ ...location }]
  mocks.accounts.mockResolvedValue([{ name: 'accounts/1' }])
  mocks.locations.mockResolvedValue([{ name: 'locations/2', title: 'External Google name', websiteUri: 'https://killerkebab.com' }])
  mocks.wildcardLocations.mockResolvedValue([])
  mocks.metrics.mockImplementation(async (_client, _account, _location, start) => {
    const [year, month, day] = start.split('-').map(Number)
    return [{ dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [{ date: { year, month, day }, value: '7' }] } }]
  })
  mocks.keywords.mockResolvedValue([{ searchKeyword: 'kebab', insightsValue: { value: '100' } }])
  mocks.reviews.mockResolvedValue({ reviewsUpserted: 3, draftsGenerated: 0 })
})
describe('institutional GBP orchestrator', () => {
  it('backfills all stages with institutional checkpoints and preserves canonical mapping', async () => {
    const result = await runGbpSync(undefined, now)
    expect(result.ok).toBe(true); expect(result.locationsFound).toBe(1); expect(result.locationsMapped).toBe(1)
    expect(result.profilesRefreshed).toBe(1); expect(result.performanceRowsUpserted).toBeGreaterThan(500); expect(result.keywordRowsUpserted).toBe(18)
    expect(db.tables.gbp_locations[0]).toMatchObject({ store_name: 'Internal name', location_id: 'canonical-1', profile_title: 'External Google name', active: true })
    expect(db.tables.integration_sync_state.every(row => row.user_id === null)).toBe(true)
    expect(JSON.parse(state('gbp_metrics:1:2').cursor).backfillComplete).toBe(true)
    expect(mocks.reviews.mock.calls[0][3]).toBeNull()
  })
  it('reruns idempotently using 14 recent days and two completed months', async () => {
    await runGbpSync(undefined, now)
    const dailyCount = db.tables.gbp_location_metrics.length
    mocks.metrics.mockClear(); mocks.keywords.mockClear()
    const second = await runGbpSync(undefined, now)
    expect(second.ok).toBe(true); expect(second.performanceRowsUpserted).toBe(14); expect(second.keywordRowsUpserted).toBe(2)
    expect(db.tables.gbp_location_metrics).toHaveLength(dailyCount); expect(db.tables.gbp_search_keywords_monthly).toHaveLength(18)
    expect(mocks.metrics.mock.calls[0].slice(3)).toEqual(['2026-09-03', '2026-09-16'])
    expect(mocks.reviews.mock.calls[1][3]).toBe(now.toISOString())
  })
  it('never marks a failed performance backfill complete; keyword/review success survives', async () => {
    mocks.metrics.mockRejectedValueOnce(new Error('secret-token'))
    const result = await runGbpSync(undefined, now)
    expect(result.ok).toBe(false); expect(result.keywordRowsUpserted).toBe(18); expect(result.reviewsRefreshed).toBe(3)
    expect(state('gbp_metrics:1:2').status).toBe('failed'); expect(state('gbp_metrics:1:2').last_success_at).toBeUndefined()
    expect(state('gbp_keywords:1:2').status).toBe('synced'); expect(JSON.stringify(result)).not.toContain('secret-token')
    mocks.metrics.mockClear(); await runGbpSync(undefined, now)
    expect(mocks.metrics.mock.calls[0][3]).toBe('2025-03-17')
  })
  it('resumes a partial backfill at the last committed chunk', async () => {
    const impl = mocks.metrics.getMockImplementation()!
    mocks.metrics.mockImplementationOnce(impl).mockRejectedValueOnce(new Error('network'))
    await runGbpSync(undefined, now)
    expect(JSON.parse(state('gbp_metrics:1:2').cursor)).toMatchObject({ through: '2025-04-16' })
    mocks.metrics.mockClear(); await runGbpSync(undefined, now)
    expect(mocks.metrics.mock.calls[0][3]).toBe('2025-04-17')
  })
  it('does not replace a keyword month until every API page succeeded', async () => {
    await runGbpSync(undefined, now)
    const previous = structuredClone(db.tables.gbp_search_keywords_monthly)
    mocks.keywords.mockRejectedValueOnce(new Error('second page failed'))
    const result = await runGbpSync(undefined, now)
    expect(result.ok).toBe(false); expect(db.tables.gbp_search_keywords_monthly).toEqual(previous)
    expect(state('gbp_keywords:1:2').status).toBe('failed'); expect(state('gbp_metrics:1:2').status).toBe('synced')
  })
  it('does not advance checkpoints on a database error', async () => {
    db.failures['gbp_location_metrics:upsert'] = 1
    db.failures.rpc = 1
    const result = await runGbpSync(undefined, now)
    expect(result.ok).toBe(false); expect(state('gbp_metrics:1:2').cursor).toBeUndefined()
    expect(state('gbp_keywords:1:2').cursor).toBeUndefined(); expect(JSON.stringify(result)).not.toContain('secret-provider-error')
  })
  it('discovers unmapped profiles without syncing their performance/reviews or inferring identity', async () => {
    db.tables.gbp_locations = []
    const result = await runGbpSync(undefined, now)
    expect(result.ok).toBe(false); expect(result.unmappedLocations).toEqual([{ accountId: '1', locationId: '2', title: 'External Google name' }])
    expect(db.tables.gbp_locations[0]).toMatchObject({ location_id: null, active: false })
    expect(mocks.metrics).not.toHaveBeenCalled(); expect(mocks.reviews).not.toHaveBeenCalled()
  })
  it('excludes ambiguous persistent mappings and keeps unambiguous locations running', async () => {
    db.tables.gbp_locations.push({ ...location, id: 'gbp-2', google_location_id: '3' })
    const result = await runGbpSync(undefined, now)
    expect(result.ambiguousLocations).toEqual(['2', '3']); expect(result.ok).toBe(false); expect(mocks.reviews).not.toHaveBeenCalled()
  })
  it('excludes profiles Google explicitly marks as duplicates', async () => {
    mocks.locations.mockResolvedValue([{ name: 'locations/2', title: 'Killer', metadata: { duplicateLocation: 'locations/99' } }])
    const result = await runGbpSync(undefined, now)
    expect(result.ambiguousLocations).toEqual(['2']); expect(mocks.reviews).not.toHaveBeenCalled()
  })
  it('continues existing mapped location stages after profile discovery fails', async () => {
    mocks.locations.mockRejectedValueOnce(new Error('private-header'))
    const result = await runGbpSync(undefined, now)
    expect(result.ok).toBe(false); expect(result.profilesRefreshed).toBe(0); expect(result.reviewsRefreshed).toBe(3)
    expect(state('gbp_profiles').status).toBe('failed'); expect(JSON.stringify(result)).not.toContain('private-header')
  })
  it('does not call Google without a scope and active administrator', async () => {
    db.tables.google_oauth_tokens[0].scopes = []
    expect((await runGbpSync(undefined, now)).errors[0]).toContain('GBP_SCOPE_MISSING')
    expect(mocks.accounts).not.toHaveBeenCalled()
    db.tables.google_oauth_tokens[0].scopes = ['business.manage']; db.tables.app_users[0].active = false
    expect((await runGbpSync(undefined, now)).errors[0]).toContain('No active SUPER_ADMIN')
  })
  it('skips overlapping runs while the lease is held', async () => {
    db.tables.integration_sync_state = [{ id: 'lease', integration: 'gbp_foundation', user_id: null, status: 'syncing', last_attempt_at: now.toISOString() }]
    expect(await runGbpSync(undefined, now)).toMatchObject({ ok: true, skipped: true })
    expect(mocks.accounts).not.toHaveBeenCalled()
  })
  it('isolates review failure without reverting performance or keyword successes', async () => {
    mocks.reviews.mockRejectedValueOnce(new Error('private-token'))
    const result = await runGbpSync(undefined, now)
    expect(result.ok).toBe(false); expect(state('gbp_metrics:1:2').status).toBe('synced'); expect(state('gbp_keywords:1:2').status).toBe('synced')
    expect(state('gbp_reviews:1:2').status).toBe('failed'); expect(JSON.stringify(result)).not.toContain('private-token')
  })
})

describe('wildcard location discovery fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks(); db = gbpDb(); mocks.client.mockReturnValue(db)
    db.tables.google_oauth_tokens = [{ user_id: 'admin', scopes: ['business.manage'] }]
    db.tables.app_users = [{ id: 'admin', role: 'SUPER_ADMIN', active: true }]
    db.tables.gbp_locations = []
    mocks.accounts.mockResolvedValue([{ name: 'accounts/1' }])
    mocks.metrics.mockResolvedValue([{ dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [] } }])
    mocks.keywords.mockResolvedValue([])
    mocks.reviews.mockResolvedValue({ reviewsUpserted: 0, draftsGenerated: 0 })
  })

  it('skips wildcard when per-account discovery returns locations', async () => {
    mocks.locations.mockResolvedValue([{ name: 'locations/2', title: 'Direct Store' }])
    mocks.wildcardLocations.mockResolvedValue([{ name: 'locations/99', title: 'Wildcard Store' }])
    const result = await runGbpSync(undefined, now)
    expect(result.locationsFound).toBe(1)
    expect(result.unmappedLocations).toEqual([{ accountId: '1', locationId: '2', title: 'Direct Store' }])
    expect(mocks.wildcardLocations).not.toHaveBeenCalled()
  })

  it('falls back to wildcard and associates locations with the single account', async () => {
    mocks.locations.mockResolvedValue([])
    mocks.wildcardLocations.mockResolvedValue([
      { name: 'locations/77', title: 'Indirect Store A' },
      { name: 'locations/88', title: 'Indirect Store B' },
    ])
    const result = await runGbpSync(undefined, now)
    expect(result.locationsFound).toBe(2)
    expect(result.errors.filter(e => e.includes('WILDCARD'))).toHaveLength(0)
    expect(db.tables.gbp_locations.every((row: Record<string, unknown>) => row.google_account_id === '1')).toBe(true)
    expect(result.unmappedLocations.map(l => l.locationId)).toEqual(expect.arrayContaining(['77', '88']))
  })

  it('reports ambiguous error and does not insert locations when multiple accounts and wildcard finds profiles', async () => {
    mocks.accounts.mockResolvedValue([{ name: 'accounts/10' }, { name: 'accounts/20' }])
    mocks.locations.mockResolvedValue([])
    mocks.wildcardLocations.mockResolvedValue([
      { name: 'locations/444', title: 'Ambiguous Store X' },
      { name: 'locations/555', title: 'Ambiguous Store Y' },
    ])
    const result = await runGbpSync(undefined, now)
    expect(result.errors.some(e => e.includes('GBP_WILDCARD_AMBIGUOUS'))).toBe(true)
    expect(db.tables.gbp_locations).toHaveLength(0)
    expect(result.unmappedLocations.every(l => l.accountId === '(wildcard-ambiguous)')).toBe(true)
    expect(result.unmappedLocations.map(l => l.locationId)).toEqual(expect.arrayContaining(['444', '555']))
  })
})

it('loads one bounded set of voice examples and reuses it across locations', async () => {
  const from = vi.spyOn(db, 'from')
  db.tables.gbp_locations.push({ ...location, id: 'gbp-2', google_location_id: '3', location_id: 'canonical-2' })
  mocks.locations.mockResolvedValue([{ name: 'locations/2', title: 'Synthetic A' }, { name: 'locations/3', title: 'Synthetic B' }])
  db.tables.gbp_review_replies = [{ status: 'published', approved_by_user_id: 'admin', approved_at: '2026-09-16T00:00:00Z', draft_text: 'Generic thanks', approved_text: 'Great to hear the falafel hit the spot!', review: { star_rating: 5, review_text: 'Synthetic falafel praise' } }]
  await runGbpSync(undefined, now)
  expect(from.mock.calls.filter(([table]) => table === 'gbp_review_replies')).toHaveLength(1)
  expect(mocks.reviews).toHaveBeenCalledTimes(2)
  expect(mocks.reviews.mock.calls[0][6]).toBe(mocks.reviews.mock.calls[1][6])
  expect(mocks.reviews.mock.calls[0][6][0].approvedReply).toContain('falafel')
})
