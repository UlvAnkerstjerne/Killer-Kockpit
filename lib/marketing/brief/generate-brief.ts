/**
 * lib/marketing/brief/generate-brief.ts
 *
 * Morning Brief generation orchestrator.
 *
 * NOT a server action. Called from:
 *   - app/api/marketing/morning-brief/generate/route.ts (CRON endpoint)
 *   - lib/actions/marketing/morning-brief.ts (SUPER_ADMIN forced regen)
 *
 * Auth is enforced at the calling layer (CRON_SECRET or SUPER_ADMIN check).
 * This module receives only the brief date — no user session, no auth context.
 *
 * ── Idempotency (correction 6) ────────────────────────────────────────────────
 *
 * The unique `brief_date` constraint prevents duplicate rows. Status-based claiming:
 *   1. Attempt to INSERT a new 'generating' row.
 *   2. If CONFLICT (row exists): read current status.
 *      - 'ready':      return success immediately (idempotent).
 *      - 'generating': check generation_started_at for stuck detection (> 30 min).
 *                      If stuck: reclaim by UPDATE. If fresh: return skipped.
 *      - 'failed':     reclaim by UPDATE to 'generating'.
 *      - 'pending':    reclaim by UPDATE to 'generating'.
 *   3. Only the process that successfully claimed proceeds to call AI.
 *
 * This ensures two simultaneous cron invocations cannot both call Claude.
 *
 * ── Safe SUPER_ADMIN regeneration (correction 7) ─────────────────────────────
 *
 * The existing 'ready' brief is NEVER deleted or set to a non-ready state before
 * a replacement is confirmed successful. The approach:
 *   1. Run data collection + AI generation entirely in memory.
 *   2. Only write the new result to DB if generation succeeds.
 *   3. If generation fails, the existing 'ready' row is untouched.
 *   4. The failed attempt is logged but not written to the DB in a way that
 *      would replace the good brief.
 *
 * ── AI output validation ──────────────────────────────────────────────────────
 *
 * The AI response is validated by Zod inside lib/ai/morning-brief.ts before
 * being returned. If validation fails, the orchestrator receives { ok: false }
 * and the existing brief is preserved.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { collectBriefData } from './collect-data'
import { buildBriefUserMessage } from './build-prompt'
import { BRIEF_PROMPT_VERSION } from './build-prompt'
import { callMorningBriefAI } from '@/lib/ai/morning-brief'
import type {
  BriefInputData,
  MorningBriefSections,
  MorningBriefAIOutput,
  StoredPaidSection,
  StoredOrganicSection,
  StoredGbpSection,
  BriefMetricRow,
  OverallStatus,
} from './types'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minutes before a 'generating' status is considered stuck and can be reclaimed. */
const STUCK_GENERATION_MINUTES = 30

// ── Result types ──────────────────────────────────────────────────────────────

export type GenerateBriefOutcome =
  | { outcome: 'generated';        briefDate: string }
  | { outcome: 'already_ready';    briefDate: string }
  | { outcome: 'skipped_generating'; briefDate: string; reason: string }
  | { outcome: 'failed';           briefDate: string; error: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a number for display. */
function fmt(n: number | null, decimals = 0): string {
  if (n == null) return 'n/a'
  return n.toLocaleString('en-DK', { maximumFractionDigits: decimals })
}

function fmtCcy(n: number | null, ccy: string, decimals = 0): string {
  if (n == null) return 'n/a'
  return `${ccy} ${n.toLocaleString('en-DK', { maximumFractionDigits: decimals })}`
}

function pctStr(pct: number | null | undefined): string {
  if (pct == null) return 'n/a'
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

// ── Section assembly ──────────────────────────────────────────────────────────
//
// Combines deterministic computed data (from BriefInputData) with AI-written
// assessments (from MorningBriefAIOutput) into the stored section shapes.

function assemblePaidSection(data: BriefInputData, ai: MorningBriefAIOutput): StoredPaidSection {
  if (!data.paid) {
    return {
      assessment: ai.paid_assessment,
      anomalies: [],
      metrics: [],
      active_campaign_summaries: [],
      pending_review_count: data.needsReview.paid_recommendation,
    }
  }

  const anomalies = data.signals.paid_anomalies.map((a) =>
    `${a.campaign_name}: ${a.metric_label.toUpperCase()} ${a.direction === 'increase' ? 'up' : 'down'} ${Math.abs(a.change_pct).toFixed(1)}% yesterday vs 6-day baseline`
  )

  const metrics: BriefMetricRow[] = []
  if (data.paid.total_active_spend_7d != null) {
    metrics.push({ label: '7d spend (active)', value: fmtCcy(data.paid.total_active_spend_7d, data.currency) })
  }
  if (data.paid.total_active_impressions_7d != null) {
    metrics.push({ label: '7d impressions', value: fmt(data.paid.total_active_impressions_7d) })
  }
  // Per-campaign summary rows (universal metrics only)
  for (const c of data.paid.active_campaigns.slice(0, 5)) {
    if (c.spend_7d != null) {
      metrics.push({
        label: c.name,   // already truncated in collect-data.ts
        value: fmtCcy(c.spend_7d, data.currency),
        change: c.ctr_7d != null ? `CTR ${c.ctr_7d.toFixed(2)}%` : undefined,
        highlight: c.anomaly != null,
      })
    }
  }

  return {
    assessment: ai.paid_assessment,
    anomalies,
    metrics,
    active_campaign_summaries: data.paid.active_campaigns.slice(0, 8).map((c) => ({
      name:               c.name,
      status:             c.status,
      spend_7d_formatted: c.spend_7d != null ? fmtCcy(c.spend_7d, data.currency) : null,
      anomaly_flag:       c.anomaly != null,
    })),
    pending_review_count: data.needsReview.paid_recommendation,
  }
}

function assembleOrganicSection(data: BriefInputData, ai: MorningBriefAIOutput): StoredOrganicSection {
  const ig = data.organic.ig

  const igMetrics: BriefMetricRow[] = []
  if (ig.reach_7d != null) {
    const change = ig.reach_prior_7d != null && ig.reach_prior_7d > 0
      ? pctStr(((ig.reach_7d - ig.reach_prior_7d) / ig.reach_prior_7d) * 100)
      : undefined
    igMetrics.push({ label: '7d reach', value: fmt(ig.reach_7d), change, highlight: data.signals.organic_ig_drop_detected })
  }
  if (ig.accounts_engaged_7d != null) igMetrics.push({ label: '7d accounts engaged', value: fmt(ig.accounts_engaged_7d) })
  if (ig.followers_current != null) {
    const change = ig.followers_7d_delta != null ? `${ig.followers_7d_delta >= 0 ? '+' : ''}${ig.followers_7d_delta}` : undefined
    igMetrics.push({ label: 'Followers', value: fmt(ig.followers_current), change })
  }

  const igPosts = data.organic.ig_top_posts.map((p) => ({
    caption_truncated: p.caption_truncated,
    media_type:        p.media_type,
    published_at:      p.published_at,
    reach:             p.reach,
    performance_label: p.performance_vs_avg_pct != null
      ? `${pctStr(p.performance_vs_avg_pct)} vs 7d avg`
      : null,
  }))

  const fb = data.organic.fb
  const fbMetrics: BriefMetricRow[] = []
  if (data.organic.fb_available) {
    if (fb.views_7d != null)         fbMetrics.push({ label: '7d page views', value: fmt(fb.views_7d) })
    if (fb.engaged_users_7d != null) fbMetrics.push({ label: '7d page engagements', value: fmt(fb.engaged_users_7d) })
    if (fb.fan_count_current != null) {
      const change = fb.fan_count_7d_delta != null ? `${fb.fan_count_7d_delta >= 0 ? '+' : ''}${fb.fan_count_7d_delta}` : undefined
      fbMetrics.push({ label: 'Fans', value: fmt(fb.fan_count_current), change })
    }
  }

  return {
    assessment: ai.organic_assessment,
    ig: {
      metrics:      igMetrics,
      notable_posts: igPosts,
      avg_reach_7d: data.organic.ig_avg_reach_7d,
    },
    fb: {
      available:    data.organic.fb_available,
      metrics:      fbMetrics,
      recent_posts: data.organic.fb_recent_posts.map((p) => ({
        message_truncated: p.message_truncated,
        post_type:         p.post_type,
        published_at:      p.published_at,
        reactions_total:   p.reactions_total,
        clicks:            p.clicks,
      })),
    },
  }
}

function assembleGbpSection(data: BriefInputData, ai: MorningBriefAIOutput): StoredGbpSection {
  return {
    integration_kind:     data.gbp.integration_status.kind,
    assessment:           ai.gbp_assessment,
    new_reviews_yesterday: data.gbp.new_reviews_yesterday,
    pending_reply_count:  data.gbp.pending_reply_count,
    avg_star_rating_7d:   data.gbp.avg_star_rating_7d,
  }
}

function assembleSections(data: BriefInputData, ai: MorningBriefAIOutput): MorningBriefSections {
  return {
    paid:    assemblePaidSection(data, ai),
    organic: assembleOrganicSection(data, ai),
    gbp:     assembleGbpSection(data, ai),
    content: { status: 'placeholder' },
    needs_review: {
      total: data.needsReview.total,
      items: [
        data.needsReview.review_reply > 0 && {
          kind: 'review_reply',
          count: data.needsReview.review_reply,
          label: 'Review replies',
        },
        data.needsReview.paid_recommendation > 0 && {
          kind: 'paid_recommendation',
          count: data.needsReview.paid_recommendation,
          label: 'Paid recommendations',
        },
        data.needsReview.content_approval > 0 && {
          kind: 'content_approval',
          count: data.needsReview.content_approval,
          label: 'Content approvals',
        },
      ].filter(Boolean) as MorningBriefSections['needs_review']['items'],
    },
  }
}

// ── Core generation (shared between cron and forced regen) ────────────────────

interface GenerationPayload {
  overall_status:             OverallStatus
  overall_reason:             string
  ai_summary:                 string
  sections_json:              MorningBriefSections
  data_window_start:          string
  data_window_end:            string
  source_freshness_json:      BriefInputData['sourceFreshness']
  deterministic_signals_json: BriefInputData['signals']
  ai_model:                   string
  ai_prompt_version:          string
  generation_duration_ms:     number
}

async function runGenerationPipeline(briefDate: string): Promise<
  | { ok: true; payload: GenerationPayload }
  | { ok: false; error: string; errorDetail: string }
> {
  const startMs = Date.now()

  let data: BriefInputData
  try {
    data = await collectBriefData(briefDate)
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error in data collection'
    console.error('[generate-brief] Data collection failed:', detail)
    return { ok: false, error: 'Data collection failed.', errorDetail: detail }
  }

  const overallStatus = data.signals.computed_status
  const userMessage   = buildBriefUserMessage(data, overallStatus)
  const aiResult      = await callMorningBriefAI(userMessage)

  if (!aiResult.ok) {
    return { ok: false, error: aiResult.error, errorDetail: aiResult.errorDetail ?? aiResult.error }
  }

  const sections  = assembleSections(data, aiResult.output)
  const totalMs   = Date.now() - startMs

  return {
    ok: true,
    payload: {
      overall_status:             overallStatus,
      overall_reason:             aiResult.output.overall_reason,
      ai_summary:                 aiResult.output.ai_summary,
      sections_json:              sections,
      data_window_start:          data.dataWindowStart,
      data_window_end:            data.dataWindowEnd,
      source_freshness_json:      data.sourceFreshness,
      deterministic_signals_json: data.signals,
      ai_model:                   aiResult.model,
      ai_prompt_version:          BRIEF_PROMPT_VERSION,
      generation_duration_ms:     totalMs,
    },
  }
}

// ── Main: normal (cron) generation ────────────────────────────────────────────

/**
 * Generates the Morning Brief for the given date.
 *
 * Idempotent: if a 'ready' brief already exists for this date, returns immediately.
 * Concurrent-safe: uses status-based claiming to prevent two processes from
 * both running Claude for the same date.
 */
export async function generateMorningBrief(briefDate: string): Promise<GenerateBriefOutcome> {
  const db = createServiceClient()

  // ── Step 1: Try to insert a new 'generating' row (atomic claim) ──────────
  const { error: insertError } = await db
    .from('marketing_morning_briefs')
    .insert({
      brief_date:           briefDate,
      status:               'generating',
      generation_started_at: new Date().toISOString(),
    })

  if (insertError) {
    // Conflict means a row already exists for this date
    if (!insertError.code?.includes('23505') && !insertError.message?.includes('unique')) {
      // Unexpected error
      console.error('[generate-brief] Insert failed unexpectedly:', insertError.message)
      return { outcome: 'failed', briefDate, error: insertError.message }
    }

    // Row exists — read current status
    const { data: existing } = await db
      .from('marketing_morning_briefs')
      .select('id, status, generation_started_at')
      .eq('brief_date', briefDate)
      .single()

    if (!existing) {
      return { outcome: 'failed', briefDate, error: 'Row conflict but could not read existing row.' }
    }

    if (existing.status === 'ready') {
      return { outcome: 'already_ready', briefDate }
    }

    if (existing.status === 'generating') {
      // Check for stuck generation
      const startedAt = existing.generation_started_at
      if (startedAt) {
        const minutesElapsed = (Date.now() - new Date(startedAt).getTime()) / 60_000
        if (minutesElapsed < STUCK_GENERATION_MINUTES) {
          return {
            outcome: 'skipped_generating',
            briefDate,
            reason: `Generation in progress (started ${minutesElapsed.toFixed(1)} min ago)`,
          }
        }
        // Stuck — reclaim
        console.warn(`[generate-brief] Reclaiming stuck generation for ${briefDate} (${minutesElapsed.toFixed(1)} min)`)
      }

      // Update generation_started_at to reclaim
      await db
        .from('marketing_morning_briefs')
        .update({ generation_started_at: new Date().toISOString() })
        .eq('id', existing.id as string)
    } else {
      // 'failed' or 'pending' — reclaim
      await db
        .from('marketing_morning_briefs')
        .update({ status: 'generating', generation_started_at: new Date().toISOString() })
        .eq('id', existing.id as string)
    }
  }

  // ── Step 2: We own the generation slot — run the pipeline ────────────────
  const result = await runGenerationPipeline(briefDate)
  const now    = new Date().toISOString()

  if (result.ok) {
    await db
      .from('marketing_morning_briefs')
      .update({
        status:       'ready',
        generated_at: now,
        error_message: null,
        error_detail:  null,
        ...result.payload,
      })
      .eq('brief_date', briefDate)

    return { outcome: 'generated', briefDate }
  } else {
    await db
      .from('marketing_morning_briefs')
      .update({
        status:        'failed',
        error_message: result.error,
        error_detail:  result.errorDetail,
        generated_at:  now,
      })
      .eq('brief_date', briefDate)

    return { outcome: 'failed', briefDate, error: result.error }
  }
}

// ── SUPER_ADMIN forced regeneration ──────────────────────────────────────────
//
// Generates in memory without touching the existing 'ready' row until a successful
// replacement is available. A failed regeneration leaves the good brief intact.

export interface ForcedRegenResult {
  ok: boolean
  message: string
}

export async function forcedRegenerateMorningBrief(briefDate: string): Promise<ForcedRegenResult> {
  const db = createServiceClient()

  // Verify a row exists (may be 'ready', 'failed', etc.)
  const { data: existing } = await db
    .from('marketing_morning_briefs')
    .select('id, status')
    .eq('brief_date', briefDate)
    .maybeSingle()

  // Run pipeline entirely in memory — does not touch the existing row
  const result = await runGenerationPipeline(briefDate)
  const now    = new Date().toISOString()

  if (!result.ok) {
    // Generation failed — leave the existing row untouched
    console.error('[generate-brief] Forced regen failed:', result.errorDetail)
    return {
      ok: false,
      message: `Regeneration failed: ${result.error} The existing brief is unchanged.`,
    }
  }

  // Generation succeeded — now replace the row safely
  if (existing) {
    await db
      .from('marketing_morning_briefs')
      .update({
        status:        'ready',
        generated_at:  now,
        error_message: null,
        error_detail:  null,
        generation_started_at: null,
        ...result.payload,
      })
      .eq('id', existing.id as string)
  } else {
    // No row existed — insert a new ready row
    await db
      .from('marketing_morning_briefs')
      .insert({
        brief_date:    briefDate,
        status:        'ready',
        generated_at:  now,
        ...result.payload,
      })
  }

  return {
    ok: true,
    message: `Morning Brief for ${briefDate} regenerated successfully.`,
  }
}
