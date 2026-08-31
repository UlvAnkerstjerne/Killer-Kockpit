/**
 * lib/meta/sync.ts
 *
 * Meta sync orchestration. NOT a server action — called from the cron endpoint
 * and the SUPER_ADMIN trigger action. All DB access uses the service client.
 *
 * Integration sync keys (all institutional: user_id IS NULL):
 *   'meta_ads_daily'        — cursor = last rolling-window date processed ('YYYY-MM-DD')
 *   'meta_ads_backfill'     — cursor = last historical date completed ('YYYY-MM-DD')
 *                             status = 'synced' means backfill is complete
 *   'meta_ig_account_daily' — cursor = last date synced
 *   'meta_ig_organic_deep'  — cursor = ISO timestamp of last deep sync
 *   'meta_fb_page_daily'    — cursor = last date synced
 *   'meta_fb_organic_deep'  — cursor = ISO timestamp of last deep sync
 *
 * Paid backfill strategy:
 *   Meta supports up to 37 months of ad insights history.
 *   Backfill processes one 30-day chunk per sync invocation, oldest-first.
 *   When the backfill cursor reaches today − 8 days (where the rolling window
 *   takes over), backfill is marked complete (status='synced').
 *   Rate limit check after each chunk; backs off on ≥ 75 score.
 *
 * Daily paid sync:
 *   Re-fetches last 7 days of ad + campaign insights on every run.
 *   Handles Meta's 24–72 h attribution window (yesterday is NOT final).
 *
 * Deep organic sync (weekly):
 *   Runs when last_success_at is null or more than 6 days ago.
 *   Discovers new posts and fetches insights for recent content (last 90 days).
 *
 * Idempotency:
 *   All writes use INSERT ... ON CONFLICT ... DO UPDATE.
 *   Crash-and-restart is safe — the backfill cursor prevents reprocessing
 *   of already-completed chunks.
 *
 * Institutional sync state:
 *   Cannot use the standard upsert(onConflict: 'integration, user_id') because
 *   PostgreSQL treats NULL as non-equal, so ON CONFLICT never fires for NULL rows.
 *   upsertInstitutionalSyncState() uses a manual select → update or insert pattern.
 *   The partial unique index in migration 019 prevents concurrent duplicates.
 */

import { createServiceClient } from '@/lib/supabase/server'
import {
  fetchAdAccounts,
  fetchCampaigns,
  fetchAdSets,
  fetchAds,
  fetchAdInsights,
  fetchCampaignInsights,
  MetaRateLimitError,
  type MetaInsightRow,
} from './client'
import { fetchIgMedia, fetchIgMediaInsights, fetchIgAccountDailyInsights } from './ig-client'
import { fetchPageDailyInsights, fetchFbPosts, fetchFbPostInsights, fetchLinkedIgAccountId } from './fb-client'
import { hasMetaCredentials } from './auth'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MetaSyncResult {
  ok:         boolean
  errors:     string[]
  summary:    string
}

type Db = ReturnType<typeof createServiceClient>

// ── Sync state helpers for institutional rows (user_id IS NULL) ────────────────
//
// Standard .upsert(onConflict: 'integration, user_id') does not work when
// user_id IS NULL because PostgreSQL treats NULL != NULL in UNIQUE constraints.
// These helpers use a manual select + update/insert pattern instead.

async function getInstitutionalSyncState(
  db: Db,
  integration: string,
): Promise<{ id: string; status: string; cursor: string | null; last_success_at: string | null } | null> {
  const { data } = await db
    .from('integration_sync_state')
    .select('id, status, cursor, last_success_at')
    .eq('integration', integration)
    .is('user_id', null)
    .maybeSingle()
  return data ?? null
}

async function upsertInstitutionalSyncState(
  db: Db,
  integration: string,
  patch: {
    status:           string
    cursor?:          string
    last_success_at?: string
    last_attempt_at:  string
    last_error?:      string | null
  },
): Promise<void> {
  const existing = await getInstitutionalSyncState(db, integration)
  if (existing) {
    await db
      .from('integration_sync_state')
      .update(patch)
      .eq('id', existing.id)
  } else {
    await db
      .from('integration_sync_state')
      .insert({ integration, user_id: null, ...patch })
  }
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(base: Date, n: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + n)
  return d
}

function daysAgo(n: number): Date {
  return addDays(new Date(), -n)
}

// 7-day rolling window for paid insights (handles 24–72h attribution delay)
function rollingWindowStart(): string { return toDateStr(daysAgo(7)) }
function rollingWindowEnd():   string { return toDateStr(new Date()) }

// Maximum backfill start: 37 months (Meta API limit)
function maxBackfillStart(): string {
  const d = new Date()
  d.setMonth(d.getMonth() - 37)
  return toDateStr(d)
}

// Backfill is complete when the cursor has reached the rolling window start
function backfillComplete(cursor: string): boolean {
  return cursor >= toDateStr(daysAgo(8))
}

// ── Insight row → DB row mapping ───────────────────────────────────────────────

function insightToAdRow(row: MetaInsightRow): Record<string, unknown> | null {
  if (!row.ad_id) return null
  return {
    ad_id:               row.ad_id,
    date_start:          row.date_start,
    impressions:         row.impressions     != null ? Number(row.impressions)    : null,
    reach:               row.reach           != null ? Number(row.reach)          : null,
    clicks:              row.clicks          != null ? Number(row.clicks)          : null,
    inline_link_clicks:  row.inline_link_clicks != null ? Number(row.inline_link_clicks) : null,
    spend:               row.spend           ?? null,   // stored as-is (exact decimal string)
    cpm:                 row.cpm             ?? null,
    cpc:                 row.cpc             ?? null,
    ctr:                 row.ctr             ?? null,
    actions_json:        row.actions         ?? null,
    cost_per_action_json: row.cost_per_action_type ?? null,
    action_values_json:  row.action_values   ?? null,
  }
}

function insightToCampaignRow(row: MetaInsightRow): Record<string, unknown> | null {
  if (!row.campaign_id) return null
  return {
    campaign_id:         row.campaign_id,
    date_start:          row.date_start,
    impressions:         row.impressions     != null ? Number(row.impressions)    : null,
    reach:               row.reach           != null ? Number(row.reach)          : null,
    clicks:              row.clicks          != null ? Number(row.clicks)          : null,
    inline_link_clicks:  row.inline_link_clicks != null ? Number(row.inline_link_clicks) : null,
    spend:               row.spend           ?? null,
    cpm:                 row.cpm             ?? null,
    cpc:                 row.cpc             ?? null,
    ctr:                 row.ctr             ?? null,
    frequency:           row.frequency       ?? null,
    actions_json:        row.actions         ?? null,
    cost_per_action_json: row.cost_per_action_type ?? null,
    action_values_json:  row.action_values   ?? null,
  }
}

// ── Ad structure sync ──────────────────────────────────────────────────────────

async function syncAdStructure(db: Db, adAccountId: string): Promise<void> {
  const campaigns = await fetchCampaigns(adAccountId)

  // Upsert campaigns
  if (campaigns.length > 0) {
    const campaignRows = campaigns.map((c) => ({
      id:              c.id,
      ad_account_id:   c.ad_account_id,
      name:            c.name,
      status:          c.status,
      objective:       c.objective ?? null,
      daily_budget:    c.daily_budget ?? null,
      lifetime_budget: c.lifetime_budget ?? null,
      created_at_meta: c.created_time ?? null,
      synced_at:       new Date().toISOString(),
    }))
    await db.from('meta_ad_campaigns').upsert(campaignRows, { onConflict: 'id' })
  }

  // Upsert ad sets and ads for each campaign
  for (const campaign of campaigns) {
    const adSets = await fetchAdSets(campaign.id)
    if (adSets.length > 0) {
      await db.from('meta_ad_sets').upsert(
        adSets.map((s) => ({
          id:           s.id,
          campaign_id:  s.campaign_id,
          name:         s.name,
          status:       s.status,
          daily_budget: s.daily_budget ?? null,
          synced_at:    new Date().toISOString(),
        })),
        { onConflict: 'id' },
      )
    }

    for (const adSet of adSets) {
      const ads = await fetchAds(adSet.id)
      if (ads.length > 0) {
        await db.from('meta_ads').upsert(
          ads.map((a) => ({
            id:        a.id,
            ad_set_id: a.adset_id,
            name:      a.name,
            status:    a.status,
            synced_at: new Date().toISOString(),
          })),
          { onConflict: 'id' },
        )
      }
    }
  }
}

// ── Insights upsert helpers ────────────────────────────────────────────────────

async function upsertAdInsights(db: Db, rows: MetaInsightRow[]): Promise<void> {
  const dbRows = rows.map(insightToAdRow).filter(Boolean)
  if (dbRows.length === 0) return
  await db.from('meta_ad_insights').upsert(dbRows as Record<string, unknown>[], {
    onConflict: 'ad_id, date_start',
  })
}

async function upsertCampaignInsights(db: Db, rows: MetaInsightRow[]): Promise<void> {
  const dbRows = rows.map(insightToCampaignRow).filter(Boolean)
  if (dbRows.length === 0) return
  await db.from('meta_campaign_insights').upsert(dbRows as Record<string, unknown>[], {
    onConflict: 'campaign_id, date_start',
  })
}

// ── Paid daily sync (rolling 7-day window) ─────────────────────────────────────

async function syncPaidDaily(db: Db, adAccountId: string, now: string): Promise<void> {
  const start = rollingWindowStart()
  const end   = rollingWindowEnd()

  await upsertInstitutionalSyncState(db, 'meta_ads_daily', {
    status: 'syncing', last_attempt_at: now,
  })

  try {
    const [adInsights, campaignInsights] = await Promise.all([
      fetchAdInsights(adAccountId, start, end),
      fetchCampaignInsights(adAccountId, start, end),
    ])

    await upsertAdInsights(db, adInsights)
    await upsertCampaignInsights(db, campaignInsights)

    await upsertInstitutionalSyncState(db, 'meta_ads_daily', {
      status:          'synced',
      cursor:          end,
      last_success_at: now,
      last_attempt_at: now,
      last_error:      null,
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error'
    await upsertInstitutionalSyncState(db, 'meta_ads_daily', {
      status: 'failed', last_attempt_at: now, last_error: error,
    })
    throw err
  }
}

// ── Paid backfill (one 30-day chunk per invocation) ────────────────────────────

async function syncPaidBackfillChunk(db: Db, adAccountId: string, now: string): Promise<void> {
  const backfillState = await getInstitutionalSyncState(db, 'meta_ads_backfill')

  // Already complete
  if (backfillState?.status === 'synced') return

  // Determine next chunk start date
  const chunkStart = backfillState?.cursor
    ? toDateStr(addDays(new Date(backfillState.cursor), 1))  // day after last completed
    : maxBackfillStart()                                      // first run: start from max history

  // If we've already reached the rolling window, mark complete
  if (backfillComplete(chunkStart)) {
    await upsertInstitutionalSyncState(db, 'meta_ads_backfill', {
      status: 'synced', cursor: chunkStart, last_success_at: now, last_attempt_at: now, last_error: null,
    })
    return
  }

  // Process one 30-day chunk
  const chunkEndDate = addDays(new Date(chunkStart), 29)
  const chunkEnd     = toDateStr(chunkEndDate)

  await upsertInstitutionalSyncState(db, 'meta_ads_backfill', {
    status: 'syncing', last_attempt_at: now,
  })

  try {
    const [adInsights, campaignInsights] = await Promise.all([
      fetchAdInsights(adAccountId, chunkStart, chunkEnd),
      fetchCampaignInsights(adAccountId, chunkStart, chunkEnd),
    ])

    await upsertAdInsights(db, adInsights)
    await upsertCampaignInsights(db, campaignInsights)

    const newComplete = backfillComplete(chunkEnd)
    await upsertInstitutionalSyncState(db, 'meta_ads_backfill', {
      status:          newComplete ? 'synced' : 'syncing',
      cursor:          chunkEnd,
      last_success_at: now,
      last_attempt_at: now,
      last_error:      null,
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error'
    await upsertInstitutionalSyncState(db, 'meta_ads_backfill', {
      status: 'failed', last_attempt_at: now, last_error: error,
    })
    throw err
  }
}

// ── IG account daily ───────────────────────────────────────────────────────────

async function syncIgAccountDaily(db: Db, igAccountId: string, now: string): Promise<void> {
  const yesterday = toDateStr(daysAgo(1))

  await upsertInstitutionalSyncState(db, 'meta_ig_account_daily', {
    status: 'syncing', last_attempt_at: now,
  })

  try {
    const metrics = await fetchIgAccountDailyInsights(igAccountId, yesterday)

    await db.from('meta_ig_account_daily').upsert(
      {
        ig_account_id:      igAccountId,
        date:               yesterday,
        reach:              metrics.reach               ?? null,
        accounts_engaged:   metrics.accounts_engaged   ?? null,
        profile_views:      metrics.profile_views      ?? null,
        followers_count:    metrics.followers_count    ?? null,
        other_metrics_json: metrics.other_metrics_json ?? null,
        synced_at:          now,
      },
      { onConflict: 'ig_account_id, date' },
    )

    await upsertInstitutionalSyncState(db, 'meta_ig_account_daily', {
      status:          'synced',
      cursor:          yesterday,
      last_success_at: now,
      last_attempt_at: now,
      last_error:      null,
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error'
    await upsertInstitutionalSyncState(db, 'meta_ig_account_daily', {
      status: 'failed', last_attempt_at: now, last_error: error,
    })
    throw err
  }
}

// ── FB page daily ──────────────────────────────────────────────────────────────

async function syncFbPageDaily(db: Db, pageId: string, now: string): Promise<void> {
  const yesterday = toDateStr(daysAgo(1))

  await upsertInstitutionalSyncState(db, 'meta_fb_page_daily', {
    status: 'syncing', last_attempt_at: now,
  })

  try {
    const metrics = await fetchPageDailyInsights(pageId, yesterday)

    await db.from('meta_fb_page_insights').upsert(
      {
        page_id:           pageId,
        date:              yesterday,
        views:             metrics.views         ?? null,
        reach:             metrics.reach         ?? null,
        engaged_users:     metrics.engaged_users ?? null,
        fan_count:         metrics.fan_count     ?? null,
        other_metrics_json: metrics.other_metrics_json ?? null,
      },
      { onConflict: 'page_id, date' },
    )

    await upsertInstitutionalSyncState(db, 'meta_fb_page_daily', {
      status:          'synced',
      cursor:          yesterday,
      last_success_at: now,
      last_attempt_at: now,
      last_error:      null,
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error'
    await upsertInstitutionalSyncState(db, 'meta_fb_page_daily', {
      status: 'failed', last_attempt_at: now, last_error: error,
    })
    throw err
  }
}

// ── Deep organic sync (weekly) ─────────────────────────────────────────────────

const DEEP_SYNC_INTERVAL_DAYS = 6  // run if last success > 6 days ago
const ORGANIC_INSIGHTS_LOOKBACK_DAYS = 90  // fetch insights for content in last 90 days

function isDeepSyncDue(lastSuccessAt: string | null): boolean {
  if (!lastSuccessAt) return true
  const last = new Date(lastSuccessAt)
  const daysSince = (Date.now() - last.getTime()) / (1000 * 60 * 60 * 24)
  return daysSince >= DEEP_SYNC_INTERVAL_DAYS
}

async function syncIgOrganicDeep(db: Db, igAccountId: string, now: string): Promise<void> {
  const state = await getInstitutionalSyncState(db, 'meta_ig_organic_deep')
  if (!isDeepSyncDue(state?.last_success_at ?? null)) return

  await upsertInstitutionalSyncState(db, 'meta_ig_organic_deep', {
    status: 'syncing', last_attempt_at: now,
  })

  try {
    // Incremental: only fetch media published since last cursor
    const since = state?.cursor
      ? Math.floor(new Date(state.cursor).getTime() / 1000)
      : undefined

    const media = await fetchIgMedia(igAccountId, since)
    const insightsCutoff = toDateStr(daysAgo(ORGANIC_INSIGHTS_LOOKBACK_DAYS))

    for (const item of media) {
      const publishedAt = item.published_at ?? null

      // Upsert media identity row
      await db.from('meta_ig_media').upsert(
        {
          id:           item.id,
          ig_account_id: igAccountId,
          media_type:   item.media_type,
          caption:      item.caption,
          permalink:    item.permalink,
          published_at: publishedAt,
          synced_at:    now,
          // Insight columns will be updated below if within lookback window
        },
        { onConflict: 'id' },
      )

      // Only fetch insights for recent content
      if (publishedAt && publishedAt >= insightsCutoff) {
        const insights = await fetchIgMediaInsights(item.id, item.media_type)
        if (insights) {
          await db.from('meta_ig_media').update({
            reach:               insights.reach               ?? null,
            plays:               insights.plays               ?? null,
            saved:               insights.saved               ?? null,
            likes:               insights.likes               ?? null,
            comments_count:      insights.comments            ?? null,
            shares:              insights.shares              ?? null,
            total_interactions:  insights.total_interactions  ?? null,
            other_metrics_json:  insights.other_metrics_json  ?? null,
            synced_at:           now,
          }).eq('id', item.id)
        }
      }
    }

    await upsertInstitutionalSyncState(db, 'meta_ig_organic_deep', {
      status:          'synced',
      cursor:          now,
      last_success_at: now,
      last_attempt_at: now,
      last_error:      null,
    })
  } catch (err) {
    if (err instanceof MetaRateLimitError) {
      console.warn('[meta/sync] Rate limit hit during IG deep sync — will retry next run')
    }
    const error = err instanceof Error ? err.message : 'Unknown error'
    await upsertInstitutionalSyncState(db, 'meta_ig_organic_deep', {
      status: 'failed', last_attempt_at: now, last_error: error,
    })
    throw err
  }
}

async function syncFbOrganicDeep(db: Db, pageId: string, now: string): Promise<void> {
  const state = await getInstitutionalSyncState(db, 'meta_fb_organic_deep')
  if (!isDeepSyncDue(state?.last_success_at ?? null)) return

  await upsertInstitutionalSyncState(db, 'meta_fb_organic_deep', {
    status: 'syncing', last_attempt_at: now,
  })

  try {
    // Incremental: only fetch posts published since last cursor
    const since = state?.cursor
      ? toDateStr(new Date(state.cursor))
      : undefined

    const posts = await fetchFbPosts(pageId, since)
    const insightsCutoff = toDateStr(daysAgo(ORGANIC_INSIGHTS_LOOKBACK_DAYS))

    for (const post of posts) {
      // Upsert post identity
      await db.from('meta_fb_posts').upsert(
        {
          id:           post.id,
          page_id:      pageId,
          post_type:    post.post_type,
          message:      post.message,
          permalink:    post.permalink,
          published_at: post.published_at,
          synced_at:    now,
        },
        { onConflict: 'id' },
      )

      // Fetch insights for recent posts
      if (post.published_at >= insightsCutoff) {
        const insights = await fetchFbPostInsights(post.id)
        if (insights) {
          await db.from('meta_fb_post_insights').upsert(
            {
              post_id:           post.id,
              views:             insights.views           ?? null,
              reach:             insights.reach           ?? null,
              engaged_users:     insights.engaged_users   ?? null,
              reactions_total:   insights.reactions_total ?? null,
              comments:          insights.comments        ?? null,
              shares:            insights.shares          ?? null,
              clicks:            insights.clicks          ?? null,
              other_metrics_json: insights.other_metrics_json ?? null,
              synced_at:         now,
            },
            { onConflict: 'post_id' },
          )
        }
      }
    }

    await upsertInstitutionalSyncState(db, 'meta_fb_organic_deep', {
      status:          'synced',
      cursor:          now,
      last_success_at: now,
      last_attempt_at: now,
      last_error:      null,
    })
  } catch (err) {
    if (err instanceof MetaRateLimitError) {
      console.warn('[meta/sync] Rate limit hit during FB deep sync — will retry next run')
    }
    const error = err instanceof Error ? err.message : 'Unknown error'
    await upsertInstitutionalSyncState(db, 'meta_fb_organic_deep', {
      status: 'failed', last_attempt_at: now, last_error: error,
    })
    throw err
  }
}

// ── Main export: runMetaSync ───────────────────────────────────────────────────

/**
 * Runs the full Meta sync for one invocation.
 *
 * Work performed each run:
 *   Always: ad structure + 7-day paid insights + account daily metrics
 *   If backfill incomplete: one 30-day historical chunk
 *   If deep organic sync due (>6 days since last): IG + FB organic content
 *
 * Individual section failures are captured and reported but do not abort
 * remaining sections — paid sync failure does not block organic sync, etc.
 *
 * Returns a MetaSyncResult summarising success/failure per section.
 * Does not throw.
 */
export async function runMetaSync(): Promise<MetaSyncResult> {
  if (!hasMetaCredentials()) {
    return {
      ok:      false,
      errors:  ['META_SYSTEM_USER_TOKEN not configured'],
      summary: 'Meta credentials missing. Set META_SYSTEM_USER_TOKEN and other required env vars.',
    }
  }

  const adAccountId = process.env.META_AD_ACCOUNT_ID
  const pageId      = process.env.META_FACEBOOK_PAGE_ID
  const igAccountId = process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID

  if (!adAccountId) {
    return {
      ok:      false,
      errors:  ['META_AD_ACCOUNT_ID not configured'],
      summary: 'Run discoverMetaAssets() as SUPER_ADMIN to find the ad account ID.',
    }
  }

  const db  = createServiceClient()
  const now = new Date().toISOString()
  const errors: string[] = []

  // ── 1. Ad structure (full re-fetch) ─────────────────────────────────────────
  try {
    // Upsert ad account record (currency discovery)
    const accounts = await fetchAdAccounts()
    const account  = accounts.find((a) => a.id === adAccountId || `act_${a.id}` === adAccountId)
    if (account) {
      await db.from('meta_ad_accounts').upsert(
        {
          id:             account.id,
          name:           account.name,
          currency:       account.currency,
          account_status: account.account_status,
          synced_at:      now,
        },
        { onConflict: 'id' },
      )
    }

    await syncAdStructure(db, adAccountId)
  } catch (err) {
    const msg = `Ad structure sync failed: ${err instanceof Error ? err.message : err}`
    console.error(`[meta/sync] ${msg}`)
    errors.push(msg)
  }

  // ── 2. Paid daily insights (rolling 7 days) ──────────────────────────────────
  try {
    await syncPaidDaily(db, adAccountId, now)
  } catch (err) {
    const msg = `Paid daily sync failed: ${err instanceof Error ? err.message : err}`
    console.error(`[meta/sync] ${msg}`)
    errors.push(msg)
  }

  // ── 3. Paid backfill (one 30-day chunk if not complete) ──────────────────────
  try {
    await syncPaidBackfillChunk(db, adAccountId, now)
  } catch (err) {
    const msg = `Paid backfill chunk failed: ${err instanceof Error ? err.message : err}`
    console.error(`[meta/sync] ${msg}`)
    errors.push(msg)
    // Backfill failure is non-blocking — continue to organic sync
  }

  // ── 4. IG account daily ──────────────────────────────────────────────────────
  if (igAccountId) {
    try {
      await syncIgAccountDaily(db, igAccountId, now)
    } catch (err) {
      const msg = `IG account daily sync failed: ${err instanceof Error ? err.message : err}`
      console.error(`[meta/sync] ${msg}`)
      errors.push(msg)
    }

    // ── 5. IG organic deep (weekly) ──────────────────────────────────────────
    try {
      await syncIgOrganicDeep(db, igAccountId, now)
    } catch (err) {
      const msg = `IG deep organic sync failed: ${err instanceof Error ? err.message : err}`
      console.error(`[meta/sync] ${msg}`)
      errors.push(msg)
    }
  }

  // ── 6. FB page daily ─────────────────────────────────────────────────────────
  if (pageId) {
    try {
      await syncFbPageDaily(db, pageId, now)
    } catch (err) {
      const msg = `FB page daily sync failed: ${err instanceof Error ? err.message : err}`
      console.error(`[meta/sync] ${msg}`)
      errors.push(msg)
    }

    // ── 7. FB organic deep (weekly) ──────────────────────────────────────────
    try {
      await syncFbOrganicDeep(db, pageId, now)
    } catch (err) {
      const msg = `FB deep organic sync failed: ${err instanceof Error ? err.message : err}`
      console.error(`[meta/sync] ${msg}`)
      errors.push(msg)
    }
  }

  const ok      = errors.length === 0
  const summary = ok
    ? 'Meta sync complete.'
    : `Meta sync completed with ${errors.length} error(s).`

  return { ok, errors, summary }
}

// ── Asset discovery ────────────────────────────────────────────────────────────

/**
 * Discovers accessible Meta assets for the system user token.
 * Used once during initial setup to identify the Killer Kebab ad account
 * and confirm the Instagram account linked to the Facebook Page.
 *
 * Does not write to the database — returns raw discovered data for the
 * SUPER_ADMIN to review before storing IDs in env.
 */
export async function discoverMetaAssets(): Promise<{
  ok: boolean
  data?: { adAccounts: unknown[]; linkedIgAccountId: string | null }
  error?: string
}> {
  if (!hasMetaCredentials()) {
    return { ok: false, error: 'META_SYSTEM_USER_TOKEN not configured.' }
  }

  try {
    const adAccounts = await fetchAdAccounts()

    let linkedIgAccountId: string | null = null
    const pageId = process.env.META_FACEBOOK_PAGE_ID
    if (pageId) {
      linkedIgAccountId = await fetchLinkedIgAccountId(pageId)
    }

    return {
      ok:   true,
      data: { adAccounts, linkedIgAccountId },
    }
  } catch (err) {
    return {
      ok:    false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}
