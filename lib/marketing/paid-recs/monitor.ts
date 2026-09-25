/**
 * lib/marketing/paid-recs/monitor.ts
 *
 * Resolves paid recommendations whose monitoring window has ended.
 * Called from the paid-recommendations cron after generation completes.
 *
 * For each in-motion recommendation past its monitor_end:
 *   1. Fetch the campaign's current 7d metrics
 *   2. Compare against the stored baseline
 *   3. Set outcome: improved / unchanged / needs_attention
 *   4. Transition execution_status to completed or needs_attention
 */

import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import type { PaidRecExecutionResult, PaidRecMonitoringResult } from './types'

type Db = ReturnType<typeof createServiceClient>

interface InMotionRow {
  id: string
  platform: string
  campaign_id: string
  execution_result: PaidRecExecutionResult | null
}

/**
 * Resolves all in-motion recommendations whose monitoring window has ended.
 * Returns the number of recommendations resolved.
 */
export async function resolveCompletedMonitoring(now = new Date()): Promise<number> {
  const db = createServiceClient()
  const nowIso = now.toISOString()

  // Find in-motion recommendations with monitoring that has ended
  const { data: candidates, error } = await db
    .from('paid_recommendations')
    .select('id, platform, campaign_id, execution_result')
    .eq('execution_status', 'in_motion')

  if (error || !candidates) return 0

  const rows = (candidates as InMotionRow[]).filter(r => {
    const monitoring = r.execution_result?.monitoring
    return monitoring?.monitor_end && monitoring.monitor_end <= nowIso
  })

  if (rows.length === 0) return 0

  let resolved = 0
  for (const row of rows) {
    const monitoring = row.execution_result!.monitoring!
    const latest = await fetchCurrentMetrics(db, row.platform, row.campaign_id)
    const outcome = determineOutcome(monitoring.baseline, latest)

    const updatedResult: PaidRecExecutionResult = {
      ...row.execution_result!,
      monitoring: { ...monitoring, latest, outcome },
    }

    const executionStatus = outcome === 'improved' ? 'completed' : 'needs_attention'

    await db.from('paid_recommendations').update({
      execution_status: executionStatus,
      execution_completed_at: nowIso,
      execution_result: updatedResult,
    }).eq('id', row.id).eq('execution_status', 'in_motion')

    resolved++
  }

  if (resolved > 0) {
    console.log(`[paid-recs/monitor] Resolved ${resolved} monitoring window(s).`)
  }
  return resolved
}

// ── Fetch current campaign metrics ──────────────────────────────────────────

async function fetchCurrentMetrics(
  db: Db,
  platform: string,
  campaignId: string,
): Promise<{ spend_7d: number | null; result_count_7d: number | null; cpr_7d: number | null }> {
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date()
  start.setDate(start.getDate() - 7)
  const startStr = start.toISOString().slice(0, 10)
  const endStr = end.toISOString().slice(0, 10)

  if (platform === 'meta') {
    const { data } = await db
      .from('meta_campaign_insights')
      .select('spend, actions_json')
      .eq('campaign_id', campaignId)
      .gte('date_start', startStr)
      .lte('date_start', endStr)

    if (!data?.length) return { spend_7d: null, result_count_7d: null, cpr_7d: null }

    const spend = data.reduce((a, r) => a + Number(r.spend ?? 0), 0)
    // Count primary result actions (offsite_conversion.fb_pixel_lead, etc.)
    let results = 0
    for (const row of data) {
      const actions = row.actions_json as Array<{ action_type: string; value: string }> | null
      if (actions) {
        for (const action of actions) {
          if (action.action_type.startsWith('offsite_conversion') || action.action_type === 'lead') {
            results += Number(action.value ?? 0)
          }
        }
      }
    }
    return { spend_7d: spend, result_count_7d: results, cpr_7d: results > 0 ? spend / results : null }
  }

  if (platform === 'google') {
    const { data } = await db
      .from('google_ads_campaign_daily')
      .select('cost, conversions')
      .eq('campaign_id', campaignId)
      .gte('date', startStr)
      .lte('date', endStr)

    if (!data?.length) return { spend_7d: null, result_count_7d: null, cpr_7d: null }

    const spend = data.reduce((a, r) => a + Number(r.cost ?? 0), 0)
    const results = data.reduce((a, r) => a + Number(r.conversions ?? 0), 0)
    return { spend_7d: spend, result_count_7d: results, cpr_7d: results > 0 ? spend / results : null }
  }

  return { spend_7d: null, result_count_7d: null, cpr_7d: null }
}

// ── Outcome determination ───────────────────────────────────────────────────

export function determineOutcome(
  baseline: { spend_7d: number | null; result_count_7d: number | null; cpr_7d: number | null },
  latest: { spend_7d: number | null; result_count_7d: number | null; cpr_7d: number | null },
): 'improved' | 'unchanged' | 'needs_attention' {
  // If baseline had zero results and now there are results → improved
  if ((baseline.result_count_7d === null || baseline.result_count_7d === 0) && (latest.result_count_7d ?? 0) > 0) {
    return 'improved'
  }

  // If baseline had results but now there are none → needs_attention
  if ((baseline.result_count_7d ?? 0) > 0 && (latest.result_count_7d === null || latest.result_count_7d === 0)) {
    return 'needs_attention'
  }

  // Compare CPR if both available
  if (baseline.cpr_7d != null && baseline.cpr_7d > 0 && latest.cpr_7d != null && latest.cpr_7d > 0) {
    const change = (latest.cpr_7d - baseline.cpr_7d) / baseline.cpr_7d
    if (change <= -0.15) return 'improved'      // CPR improved by ≥15%
    if (change >= 0.15) return 'needs_attention' // CPR worsened by ≥15%
    return 'unchanged'
  }

  return 'unchanged'
}
