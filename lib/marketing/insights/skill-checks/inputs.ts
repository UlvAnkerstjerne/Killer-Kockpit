import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'
import { strategyWindows } from '@/lib/marketing/paid-strategy/evidence'
import type { MetaChecksInput } from './facebook-ads'

type Db = ReturnType<typeof createServiceClient>
type Page = { data: unknown[] | null; error: unknown }

async function readPages<T>(query: (from: number, to: number) => PromiseLike<Page>, pageSize = 1000): Promise<T[]> {
  const rows: T[] = []
  for (;;) {
    const { data, error } = await query(rows.length, rows.length + pageSize - 1)
    if (error) throw new Error('insights_storage')
    if (!data?.length) return rows
    rows.push(...data as T[])
    if (data.length < pageSize) return rows
  }
}

/**
 * The stored Meta tables the checklist needs, read-only and with the same windows as Paid Strategy (completed days only).
 * Used when no Paid Strategy run is in hand (the SUPER_ADMIN capture button); a run reuses the inputs it already loaded.
 */
export async function loadMetaChecksInput(db: Db, now: Date): Promise<MetaChecksInput> {
  const w = strategyWindows(now)
  const since14 = new Date(`${w.current.end}T12:00:00Z`); since14.setUTCDate(since14.getUTCDate() - 13)
  const from14 = since14.toISOString().slice(0, 10)
  const [accounts, campaigns, adSets, ads, campaignInsights, adInsights] = await Promise.all([
    readPages<{ id: string; currency: string }>((a, b) => db.from('meta_ad_accounts').select('id,currency').order('id').range(a, b)),
    readPages<MetaChecksInput['campaigns'][number]>((a, b) => db.from('meta_ad_campaigns').select('id,name,status,objective,daily_budget').order('id').range(a, b)),
    readPages<MetaChecksInput['adSets'][number]>((a, b) => db.from('meta_ad_sets').select('id,campaign_id,name,status,daily_budget').order('id').range(a, b)),
    readPages<MetaChecksInput['ads'][number]>((a, b) => db.from('meta_ads').select('id,ad_set_id,name,status').order('id').range(a, b)),
    readPages<MetaChecksInput['campaignInsights'][number]>((a, b) => db.from('meta_campaign_insights').select('campaign_id,date_start,impressions,inline_link_clicks,spend')
      .gte('date_start', w.current.start).lte('date_start', w.current.end).order('date_start').order('campaign_id').range(a, b)),
    readPages<MetaChecksInput['adInsights'][number]>((a, b) => db.from('meta_ad_insights').select('ad_id,date_start,impressions,inline_link_clicks,spend')
      .gte('date_start', from14).lte('date_start', w.current.end).order('date_start').order('ad_id').range(a, b)),
  ])
  return { now, currency: accounts[0]?.currency ?? 'DKK', campaigns, adSets, ads, campaignInsights, adInsights }
}
