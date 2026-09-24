/**
 * scripts/backfill-organic-28d.ts
 *
 * One-time 28-day backfill for IG account daily and FB page daily metrics.
 * Self-contained — makes Meta API calls directly to avoid TS module resolution issues.
 *
 * Usage: node --experimental-strip-types scripts/backfill-organic-28d.ts
 */

import * as fs from 'fs'
import { createClient } from '@supabase/supabase-js'

// Load env
const envContent = fs.readFileSync('.env.local', 'utf8')
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/)
  if (m) process.env[m[1]] = m[2]
}

const META_TOKEN = process.env.META_SYSTEM_USER_TOKEN!
const IG_ID = process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID!
const PAGE_ID = process.env.META_FACEBOOK_PAGE_ID!
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY!

if (!META_TOKEN || !IG_ID || !PAGE_ID || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing required env vars')
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY)
const BASE = 'https://graph.facebook.com/v26.0'
const headers = { Authorization: `Bearer ${META_TOKEN}` }

function toDateStr(d: Date): string { return d.toISOString().slice(0, 10) }
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

async function apiFetch(url: string, hdrs: Record<string, string> = headers): Promise<any> {
  const r = await fetch(url, { headers: hdrs })
  const j = await r.json() as any
  if (j.error) throw new Error(j.error.message)
  return j
}

async function fetchIgDaily(date: string) {
  const ts = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000)
  const tsEnd = ts + 86400

  const result: Record<string, number | null | Record<string, number>> = {}

  // Reach (legacy period=day)
  try {
    const body = await apiFetch(`${BASE}/${IG_ID}/insights?metric=reach&period=day&since=${ts}&until=${tsEnd}`)
    for (const item of body.data ?? []) {
      const val = item.total_value?.value ?? item.values?.[0]?.value ?? null
      if (val !== null) result[item.name] = val
    }
  } catch (e) { console.warn(`    IG reach failed: ${(e as Error).message}`) }

  // total_value metrics (v26)
  try {
    const body = await apiFetch(`${BASE}/${IG_ID}/insights?metric=accounts_engaged,profile_views&metric_type=total_value&period=day&since=${ts}&until=${tsEnd}`)
    for (const item of body.data ?? []) {
      const val = item.total_value?.value ?? item.values?.[0]?.value ?? null
      if (val !== null) result[item.name] = val
    }
  } catch (e) { console.warn(`    IG total_value failed: ${(e as Error).message}`) }

  // followers_count from account object
  try {
    const body = await apiFetch(`${BASE}/${IG_ID}?fields=followers_count`)
    if (body.followers_count !== undefined) result.followers_count = body.followers_count
  } catch (e) { console.warn(`    IG followers failed: ${(e as Error).message}`) }

  return result
}

async function fetchFbDaily(date: string) {
  const result: Record<string, number | null | Record<string, number>> = {}

  // Page object: fan_count + page token
  let pageToken: string | null = null
  try {
    const body = await apiFetch(`${BASE}/${PAGE_ID}?fields=access_token,fan_count`)
    pageToken = body.access_token ?? null
    if (body.fan_count !== undefined) result.fan_count = body.fan_count
  } catch (e) { console.warn(`    FB page object failed: ${(e as Error).message}`) }

  if (!pageToken) return result

  // Page insights with page token
  try {
    const body = await apiFetch(
      `${BASE}/${PAGE_ID}/insights?metric=page_views_total,page_post_engagements,page_daily_follows&period=day&since=${date}&until=${date}`,
      { Authorization: `Bearer ${pageToken}` },
    )
    const metricMap: Record<string, string> = {
      page_views_total: 'views',
      page_post_engagements: 'engaged_users',
    }
    for (const item of body.data ?? []) {
      const val = item.values?.[0]?.value ?? null
      if (val === null) continue
      const col = metricMap[item.name]
      if (col) result[col] = val
    }
  } catch (e) { console.warn(`    FB insights failed: ${(e as Error).message}`) }

  // Note: page_impressions_unique (reach) is deprecated in v26 — not available
  return result
}

async function main() {
  const now = new Date().toISOString()
  const dates: string[] = []
  for (let i = 1; i <= 28; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    dates.push(toDateStr(d))
  }
  dates.reverse() // oldest first

  console.log(`Backfilling ${dates.length} days: ${dates[0]} → ${dates[dates.length - 1]}`)

  let igOk = 0, igFail = 0, fbOk = 0, fbFail = 0

  for (const date of dates) {
    // IG
    try {
      const m = await fetchIgDaily(date)
      const { error } = await db.from('meta_ig_account_daily').upsert({
        ig_account_id: IG_ID, date,
        reach: m.reach ?? null,
        accounts_engaged: m.accounts_engaged ?? null,
        profile_views: m.profile_views ?? null,
        followers_count: m.followers_count ?? null,
        other_metrics_json: null,
        synced_at: now,
      }, { onConflict: 'ig_account_id, date' })
      if (error) throw new Error(error.message)
      console.log(`  IG ${date}: reach=${m.reach ?? '—'} engaged=${m.accounts_engaged ?? '—'} pv=${m.profile_views ?? '—'}`)
      igOk++
    } catch (e) { console.warn(`  IG ${date}: FAILED - ${(e as Error).message}`); igFail++ }

    // FB
    try {
      const m = await fetchFbDaily(date)
      const { error } = await db.from('meta_fb_page_insights').upsert({
        page_id: PAGE_ID, date,
        views: m.views ?? null,
        reach: null, // page_impressions_unique deprecated in v26
        engaged_users: m.engaged_users ?? null,
        fan_count: m.fan_count ?? null,
        other_metrics_json: null,
      }, { onConflict: 'page_id, date' })
      if (error) throw new Error(error.message)
      console.log(`  FB ${date}: views=${m.views ?? '—'} engaged=${m.engaged_users ?? '—'} fans=${m.fan_count ?? '—'}`)
      fbOk++
    } catch (e) { console.warn(`  FB ${date}: FAILED - ${(e as Error).message}`); fbFail++ }

    await sleep(500)
  }

  console.log(`\nDone: IG ${igOk}/${dates.length} ok, ${igFail} fail | FB ${fbOk}/${dates.length} ok, ${fbFail} fail`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
