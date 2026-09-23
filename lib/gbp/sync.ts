import 'server-only'
import type { Auth } from 'googleapis'
import { createServiceClient } from '@/lib/supabase/server'
import { getGoogleOAuth2Client, hasGbpScope } from '@/lib/google/auth'
import { fetchGbpAccounts, fetchGbpLocations, fetchGbpLocationsWildcard, fetchLocationMetrics, fetchGbpSearchKeywords, safeGbpError, type GbpAccount, type GbpLocation } from '@/lib/google/gbp-client'
import { GbpDataError, addDays, dateChunks, dailyPerformanceRows, gbpDateRange, gbpKeywordMonths, googleId, keywordRows, mappingIssues, profileSnapshot, type StoredGbpLocation } from './data'
import { claimGbpRun, finishGbpRun, readGbpState, writeGbpState, type GbpDb } from './state'
import { syncLocationReviews } from './reviews-sync'
import { loadReviewReplyExamples } from './reply-examples'
export { retryDraftForReview } from './reviews-sync'

export interface LocationSyncResult {
  locationId: string; accountId: string; storeName: string; canonicalLocationId: string | null; ok: boolean
  reviewsUpserted: number; draftsGenerated: number; metricsUpserted: number; keywordsUpserted: number; profileRefreshed: boolean
  dailyRange?: { start: string; end: string }; keywordMonths?: string[]; metricsReturned?: string[]; errors: string[]; error?: string
}
export interface SyncRunResult {
  ok: boolean; skipped: boolean; locations: LocationSyncResult[]; totalOk: number; totalFail: number
  locationsFound: number; locationsMapped: number; profilesRefreshed: number; performanceRowsUpserted: number; keywordRowsUpserted: number; reviewsRefreshed: number
  unmappedLocations: Array<{ accountId: string; locationId: string; title: string }>
  ambiguousLocations: string[]; errors: string[]
}
const safeError = (error: unknown) => error instanceof GbpDataError ? error.message : safeGbpError(error)
type Cursor = { version: 1; backfillComplete?: boolean; through?: string }
function parseCursor(cursor: string | null | undefined): Cursor {
  try { const parsed = JSON.parse(cursor ?? '{}'); return parsed.version === 1 ? parsed : { version: 1 } }
  catch { return { version: 1 } }
}
async function credentialOwner(db: GbpDb, preferred?: string): Promise<string> {
  const { data, error } = await db.from('google_oauth_tokens').select('user_id,scopes').order('user_id')
  if (error) throw new GbpDataError('Could not read GBP connection metadata.')
  const ids = (data ?? []).filter(row => hasGbpScope(row.scopes ?? []) && (!preferred || row.user_id === preferred)).map(row => row.user_id)
  if (!ids.length) throw new GbpDataError('GBP_SCOPE_MISSING: Connect Google Business Profile at /api/google/connect/gbp with the account managing Killer Kebab.')
  const { data: users, error: userError } = await db.from('app_users').select('id').in('id', ids).eq('role', 'SUPER_ADMIN').eq('active', true).order('id')
  if (userError || !users?.length) throw new GbpDataError('No active SUPER_ADMIN owns the GBP-authorized connection.')
  return users[0].id
}
async function storedLocations(db: GbpDb): Promise<StoredGbpLocation[]> {
  const rows: StoredGbpLocation[] = []
  for (let offset = 0; ; ) {
    const { data, error } = await db.from('gbp_locations').select('id,google_account_id,google_location_id,location_id,store_name,store_short_name,activation_date,active').order('id').range(offset, offset + 499)
    if (error) throw new GbpDataError('Could not read persistent GBP location mappings.')
    if (!data?.length) return rows
    rows.push(...data as StoredGbpLocation[]); offset += data.length
  }
}

/**
 * Discovers GBP location profiles across all accounts.
 *
 * Per-account fetch first; falls back to the wildcard endpoint
 * (accounts/-/locations) when all accounts return zero locations.
 * Wildcard account association is safe only when there is a single account —
 * with multiple accounts ownership is ambiguous and google_account_id is never
 * fabricated.
 *
 * Exported for unit testing.
 */
export async function discoverGbpProfiles(
  client: Auth.OAuth2Client,
  accounts: GbpAccount[],
  checkDeadline: () => void,
): Promise<{
  discovered: Array<{ accountId: string; profile: GbpLocation }>
  errors: string[]
  ambiguous: Array<{ accountId: string; locationId: string; title: string }>
}> {
  const discovered: Array<{ accountId: string; profile: GbpLocation }> = []
  const errors: string[] = []
  const ambiguous: Array<{ accountId: string; locationId: string; title: string }> = []

  for (const account of accounts) {
    checkDeadline()
    const accountId = googleId(account.name, 'accounts')
    try {
      const profiles = await fetchGbpLocations(client, accountId)
      for (const profile of profiles) discovered.push({ accountId, profile })
    } catch (error) {
      errors.push(`Account ${accountId} profile discovery: ${safeError(error)}`)
    }
  }

  if (!discovered.length) {
    checkDeadline()
    try {
      const wildcardProfiles = await fetchGbpLocationsWildcard(client)
      if (wildcardProfiles.length > 0) {
        if (accounts.length === 1) {
          const singleAccountId = googleId(accounts[0].name, 'accounts')
          for (const profile of wildcardProfiles) discovered.push({ accountId: singleAccountId, profile })
        } else {
          errors.push(
            `GBP_WILDCARD_AMBIGUOUS: ${wildcardProfiles.length} location(s) found via accounts/-/locations ` +
            `but account ownership is ambiguous across ${accounts.length} accounts. ` +
            `Assign google_account_id manually in gbp_locations to proceed.`,
          )
          for (const profile of wildcardProfiles) {
            try {
              ambiguous.push({ accountId: '(wildcard-ambiguous)', locationId: googleId(profile.name, 'locations'), title: profile.title })
            } catch { /* skip entries with invalid resource names */ }
          }
        }
      }
    } catch (error) {
      errors.push(`Wildcard location discovery: ${safeError(error)}`)
    }
  }

  return { discovered, errors, ambiguous }
}

/** One institutional orchestrator, shared by both routes and the existing manual action.
 * Profile discovery never changes canonical mapping, activation cutoff or active flags.
 * A failure in one stage cannot advance another stage's watermark or erase its data. */
export async function runGbpSync(syncUserId?: string, now = new Date()): Promise<SyncRunResult> {
  const db = createServiceClient()
  const startedAt = now.toISOString()
  const deadline = Date.now() + 20 * 60_000 // Always less than the 30-minute lease.
  const checkDeadline = () => { if (Date.now() >= deadline) throw new GbpDataError('GBP sync time budget reached; saved checkpoints will resume on retry.') }
  const result: SyncRunResult = { ok: false, skipped: false, locations: [], totalOk: 0, totalFail: 0, locationsFound: 0, locationsMapped: 0,
    profilesRefreshed: 0, performanceRowsUpserted: 0, keywordRowsUpserted: 0, reviewsRefreshed: 0, unmappedLocations: [], ambiguousLocations: [], errors: [] }
  let lease: string | null = null
  try {
    lease = await claimGbpRun(db, now)
    if (!lease) return { ...result, ok: true, skipped: true }
    const owner = await credentialOwner(db, syncUserId)
    const client = await getGoogleOAuth2Client(owner)
    if (!client) throw new GbpDataError('GBP OAuth connection is unavailable.')
    const previousLocations = await storedLocations(db)
    const discovered: Array<{ accountId: string; profile: GbpLocation }> = []
    const profileErrors = new Map<string, string>()
    const wildcardAmbiguous: Array<{ accountId: string; locationId: string; title: string }> = []
    const discoveryKey = 'gbp_profiles'
    try {
      await writeGbpState(db, discoveryKey, { status: 'syncing', last_attempt_at: startedAt, last_error: null })
      const accounts = await fetchGbpAccounts(client)
      if (!accounts.length) throw new GbpDataError('No GBP accounts are visible to the connected administrator.')
      const { discovered: newDiscovered, errors: discoveryErrors, ambiguous } = await discoverGbpProfiles(client, accounts, checkDeadline)
      for (const d of newDiscovered) discovered.push(d)
      for (const e of discoveryErrors) result.errors.push(e)
      wildcardAmbiguous.push(...ambiguous)
      for (const { accountId, profile } of discovered) {
        checkDeadline()
        const locationId = googleId(profile.name, 'locations')
        try {
          const existing = previousLocations.find(row => row.google_account_id === accountId && row.google_location_id === locationId)
          const snapshot = profileSnapshot(profile, startedAt)
          const write = existing
            ? await db.from('gbp_locations').update(snapshot).eq('id', existing.id)
            : await db.from('gbp_locations').insert({ google_account_id: accountId, google_location_id: locationId, store_name: profile.title,
              store_short_name: profile.title, active: false, location_id: null, ...snapshot })
          if (write.error) throw new GbpDataError('Could not save GBP profile snapshot.')
          result.profilesRefreshed++
        } catch (error) {
          const message = safeError(error)
          profileErrors.set(`${accountId}:${locationId}`, message)
          result.errors.push(`Profile ${locationId}: ${message}`)
        }
      }
      if (!discovered.length && !result.errors.length) result.errors.push('No GBP profiles are visible to the connected administrator.')
      await writeGbpState(db, discoveryKey, { status: result.errors.length ? 'failed' : 'synced',
        last_error: result.errors.join('; ') || null, ...(result.errors.length ? {} : { last_success_at: startedAt }) })
    } catch (error) {
      const message = safeError(error); result.errors.push(message)
      await writeGbpState(db, discoveryKey, { status: 'failed', last_attempt_at: startedAt, last_error: message })
    }
    const locations = await storedLocations(db)
    const ambiguous = mappingIssues(locations)
    const googleDuplicates = new Set(discovered.filter(row => typeof row.profile.metadata?.duplicateLocation === 'string' && row.profile.metadata.duplicateLocation).map(row => googleId(row.profile.name, 'locations')))
    for (const location of locations) if (googleDuplicates.has(location.google_location_id)) ambiguous.add(location.id)
    result.locationsFound = new Set(discovered.map(row => row.profile.name)).size
    result.ambiguousLocations = locations.filter(row => ambiguous.has(row.id)).map(row => row.google_location_id)
    const found = new Set(discovered.map(row => `${row.accountId}:${googleId(row.profile.name, 'locations')}`))
    result.locationsMapped = locations.filter(row => row.location_id && !ambiguous.has(row.id) && found.has(`${row.google_account_id}:${row.google_location_id}`)).length
    result.unmappedLocations = discovered.filter(row => !locations.some(location => location.google_account_id === row.accountId && location.google_location_id === googleId(row.profile.name, 'locations') && location.location_id))
      .map(row => ({ accountId: row.accountId, locationId: googleId(row.profile.name, 'locations'), title: row.profile.title }))
    result.unmappedLocations.push(...wildcardAmbiguous)
    if (ambiguous.size) result.errors.push('Ambiguous GBP mappings found; affected profiles were excluded from performance, keyword and review sync.')
    const targets = locations.filter(row => row.active && row.location_id && !ambiguous.has(row.id))
    if (!targets.length) result.errors.push('No active GBP profiles have an unambiguous canonical Kockpit location mapping.')
    const reviewExamples = await loadReviewReplyExamples(db, now)
    for (const location of targets) {
      const accountId = location.google_account_id, locationId = location.google_location_id
      const key = `${accountId}:${locationId}`
      const item: LocationSyncResult = { accountId, locationId, storeName: location.store_name, canonicalLocationId: location.location_id, ok: false,
        reviewsUpserted: 0, draftsGenerated: 0, metricsUpserted: 0, keywordsUpserted: 0, profileRefreshed: found.has(key) && !profileErrors.has(key), errors: [] }
      if (!item.profileRefreshed) item.errors.push('Current profile snapshot could not be refreshed; previous profile data retained.')
      // Each stage owns its own persisted success and resumable backfill cursor.
      const stage = async (name: string, work: (cursor: Cursor, lastSuccess: string | null, checkpoint: (cursor: Cursor) => Promise<void>) => Promise<Cursor>) => {
        const integration = `gbp_${name}:${key}`
        try {
          checkDeadline()
          const state = await readGbpState(db, integration)
          await writeGbpState(db, integration, { status: 'syncing', last_attempt_at: startedAt, last_error: null })
          const cursor = await work(parseCursor(state?.cursor), state?.last_success_at ?? null,
            async progress => { checkDeadline(); await writeGbpState(db, integration, { cursor: JSON.stringify(progress) }) })
          await writeGbpState(db, integration, { status: 'synced', cursor: JSON.stringify(cursor), last_success_at: startedAt, last_error: null })
        } catch (error) {
          const message = safeError(error); item.errors.push(`${name}: ${message}`)
          try { await writeGbpState(db, integration, { status: 'failed', last_attempt_at: startedAt, last_error: message }) }
          catch { item.errors.push(`${name}: Could not record the failed sync attempt.`) }
        }
      }
      await stage('metrics', async (cursor, _success, checkpoint) => {
        const range = gbpDateRange(now, !cursor.backfillComplete)
        if (!cursor.backfillComplete && cursor.through && cursor.through >= range.start) range.start = addDays(cursor.through, 1)
        item.dailyRange = range
        const returned = new Set<string>()
        for (const chunk of dateChunks(range)) {
          checkDeadline()
          const series = await fetchLocationMetrics(client, accountId, locationId, chunk.start, chunk.end)
          const rows = dailyPerformanceRows(location.id, series, chunk, startedAt)
          const { error } = await db.from('gbp_location_metrics').upsert(rows, { onConflict: 'location_id,date' })
          if (error) throw new GbpDataError('Could not save GBP daily performance.')
          item.metricsUpserted += rows.length
          for (const metric of series) if (metric.timeSeries.datedValues?.length) returned.add(metric.dailyMetric)
          await checkpoint({ version: 1, backfillComplete: cursor.backfillComplete, through: chunk.end })
        }
        item.metricsReturned = [...returned]
        return { version: 1, backfillComplete: true, through: range.end }
      })
      await stage('keywords', async (cursor, _success, checkpoint) => {
        const months = gbpKeywordMonths(now, !cursor.backfillComplete).filter(month => cursor.backfillComplete || !cursor.through || month > cursor.through)
        item.keywordMonths = months
        for (const month of months) {
          checkDeadline()
          const rows = keywordRows(await fetchGbpSearchKeywords(client, locationId, month))
          const { error } = await db.rpc('replace_gbp_keyword_month', { p_location_id: location.id, p_month: month, p_rows: rows, p_synced_at: startedAt })
          if (error) throw new GbpDataError('Could not save the complete GBP keyword month.')
          item.keywordsUpserted += rows.length
          await checkpoint({ version: 1, backfillComplete: cursor.backfillComplete, through: month })
        }
        return { version: 1, backfillComplete: true, through: months.at(-1) ?? cursor.through }
      })
      await stage('reviews', async (_cursor, lastSuccess) => {
        const reviews = await syncLocationReviews(db, location, client, lastSuccess, checkDeadline, (reviews, drafts) => { item.reviewsUpserted = reviews; item.draftsGenerated = drafts }, reviewExamples)
        item.reviewsUpserted = reviews.reviewsUpserted; item.draftsGenerated = reviews.draftsGenerated
        return { version: 1, backfillComplete: true, through: startedAt }
      })
      item.ok = !item.errors.length
      if (!item.ok) item.error = item.errors.join('; ')
      result.locations.push(item)
    }
    result.totalOk = result.locations.filter(row => row.ok).length
    result.totalFail = result.locations.filter(row => !row.ok).length
    result.performanceRowsUpserted = result.locations.reduce((sum, row) => sum + row.metricsUpserted, 0)
    result.keywordRowsUpserted = result.locations.reduce((sum, row) => sum + row.keywordsUpserted, 0)
    result.reviewsRefreshed = result.locations.reduce((sum, row) => sum + row.reviewsUpserted, 0)
    result.ok = !result.errors.length && !result.totalFail
  } catch (error) { result.errors.push(safeError(error)); result.ok = false }
  if (lease) {
    try { await finishGbpRun(db, lease, startedAt, result.ok, [...result.errors, ...result.locations.flatMap(row => row.errors)].join('; ') || null) }
    catch { result.errors.push('Could not record GBP run completion.'); result.ok = false }
  }
  return result
}
