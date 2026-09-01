'use server'

/**
 * lib/actions/marketing/morning-brief.ts
 *
 * Self-authenticating server actions for Morning Brief.
 *
 * Trust-boundary contract (identical to all other Marketing server actions):
 *   - Actor identity ALWAYS comes from getCurrentUser() — never from the caller.
 *   - canAccessMarketing() checked server-side.
 *   - Callers may supply only the brief date (for admin actions).
 *   - All DB access uses createServiceClient() (service_role, bypasses RLS).
 *
 * Actions:
 *   getLatestMorningBrief()        — read the most recent ready brief (or today's)
 *   triggerMorningBriefRegen()     — SUPER_ADMIN forced regeneration
 */

import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing } from '@/lib/permissions'
import { forcedRegenerateMorningBrief } from '@/lib/marketing/brief/generate-brief'
import type { ActionResult } from '@/lib/types'
import type { MorningBriefRow } from '@/lib/marketing/brief/types'

// ── Date helper ───────────────────────────────────────────────────────────────

/** Returns today's date in Europe/Copenhagen (YYYY-MM-DD). */
function copenhagenDateToday(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' })
    .format(new Date())
}

// ── getLatestMorningBrief ─────────────────────────────────────────────────────
//
// Returns:
//   - Today's brief row (any status) if it exists
//   - Otherwise, the most recent 'ready' brief
//   - null if no brief has ever been generated
//
// The page uses the returned row's status to decide what to render:
//   'ready'      → render the brief
//   'generating' → show in-progress state
//   'failed'     → try to show a previous ready brief (page handles this)
//   null         → no brief yet

export async function getLatestMorningBrief(): Promise<MorningBriefRow | null> {
  const user = await getCurrentUser()
  if (!user) return null
  if (!canAccessMarketing(user.role, user.marketing_access)) return null

  const db   = createServiceClient()
  const today = copenhagenDateToday()

  // Try today's row first
  const { data: todayRow } = await db
    .from('marketing_morning_briefs')
    .select(`
      id, brief_date, status, generation_started_at,
      overall_status, overall_reason, ai_summary, sections_json,
      data_window_start, data_window_end,
      source_freshness_json,
      generated_at, generation_duration_ms, ai_model, ai_prompt_version,
      error_message, created_at, updated_at
    `)
    .eq('brief_date', today)
    .maybeSingle()

  if (todayRow) {
    // If today's brief is failed or generating, also fetch last ready for fallback
    if (todayRow.status === 'ready') {
      return todayRow as unknown as MorningBriefRow
    }

    // Return the today row — the page will handle failed/generating state and
    // optionally show the last ready brief
    return todayRow as unknown as MorningBriefRow
  }

  // No row for today — return the most recent ready brief (may be from yesterday)
  const { data: lastReady } = await db
    .from('marketing_morning_briefs')
    .select(`
      id, brief_date, status, generation_started_at,
      overall_status, overall_reason, ai_summary, sections_json,
      data_window_start, data_window_end,
      source_freshness_json,
      generated_at, generation_duration_ms, ai_model, ai_prompt_version,
      error_message, created_at, updated_at
    `)
    .eq('status', 'ready')
    .order('brief_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (lastReady ?? null) as unknown as MorningBriefRow | null
}

// ── getLastReadyMorningBrief ──────────────────────────────────────────────────
//
// Returns the most recent 'ready' brief regardless of date.
// Used by the page when today's brief is failed/generating and a fallback is needed.

export async function getLastReadyMorningBrief(): Promise<MorningBriefRow | null> {
  const user = await getCurrentUser()
  if (!user) return null
  if (!canAccessMarketing(user.role, user.marketing_access)) return null

  const db = createServiceClient()
  const { data } = await db
    .from('marketing_morning_briefs')
    .select(`
      id, brief_date, status, generation_started_at,
      overall_status, overall_reason, ai_summary, sections_json,
      data_window_start, data_window_end,
      source_freshness_json,
      generated_at, generation_duration_ms, ai_model, ai_prompt_version,
      error_message, created_at, updated_at
    `)
    .eq('status', 'ready')
    .order('brief_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (data ?? null) as unknown as MorningBriefRow | null
}

// ── triggerMorningBriefRegen ──────────────────────────────────────────────────
//
// SUPER_ADMIN only. Forces regeneration for today's brief.
// Does NOT delete the existing brief first — if generation fails, the previous
// good brief is preserved intact (correction 7).

export async function triggerMorningBriefRegen(): Promise<ActionResult<{ message: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }
  if (user.role !== 'SUPER_ADMIN') {
    return { error: 'Only SUPER_ADMIN can force Morning Brief regeneration.' }
  }

  const briefDate = copenhagenDateToday()
  const result    = await forcedRegenerateMorningBrief(briefDate)

  if (!result.ok) {
    return { error: result.message }
  }

  return { data: { message: result.message } }
}
