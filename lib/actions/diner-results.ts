'use server'

/**
 * lib/actions/diner-results.ts
 *
 * Server action for fetching checkpoint matrix data for the Mystery Diner
 * results dashboard. Uses service_role (after explicit auth check) because
 * diner_submissions/diner_responses have no authenticated RLS policies.
 *
 * Template-version safety: if submissions for a store span multiple template
 * versions, only the latest-template group is shown and an inconsistency note
 * is returned. Older audit columns are excluded rather than guessed.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import { computeDinerStatus } from '@/lib/diner/scoring'
import type { DinerStatus } from '@/lib/diner/scoring'

export interface DinerMatrixCheckpoint {
  id:             string
  order_index:    number
  section:        string
  label:          string
  type:           'scored' | 'gold_star' | 'waiting_time' | 'informational'
  is_critical:    boolean
  is_conditional: boolean
}

export interface DinerMatrixColumn {
  submissionId:        string
  submittedAt:         string
  dinerName:           string
  score_pct:           number | null
  critical_fail_count: number | null
  gold_star_count:     number | null
  waiting_time_band:   string | null
  final_status:        DinerStatus | null
  /** checkpoint_id → { result, notes } */
  responses: Record<string, { result: 'pass' | 'fail' | 'na' | null; notes: string | null }>
}

export type DinerStoreMatrixResult =
  | { ok: false; error: string }
  | {
      ok:                true
      consistent:        boolean
      inconsistencyNote?: string
      checkpoints:       DinerMatrixCheckpoint[]
      columns:           DinerMatrixColumn[]
    }

export async function fetchDinerStoreMatrix(locationId: string): Promise<DinerStoreMatrixResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  if (!canAccessQualityCheck(user.role)) return { ok: false, error: 'Not authorised' }

  const db = createServiceClient()

  // Step 1: Get submitted invitation IDs for this location
  const { data: invs, error: invErr } = await db
    .from('diner_invitations')
    .select('id, diner_name')
    .eq('location_id', locationId)
    .eq('status', 'submitted')

  if (invErr) return { ok: false, error: invErr.message }

  const invitationIds = (invs ?? []).map(i => i.id as string)
  if (invitationIds.length === 0) {
    return { ok: true, consistent: true, checkpoints: [], columns: [] }
  }

  const invMap = new Map((invs ?? []).map(i => [i.id as string, i.diner_name as string]))

  // Step 2: Submitted submissions for those invitations, oldest first for matrix columns
  const { data: subs, error: subErr } = await db
    .from('diner_submissions')
    .select('id, invitation_id, template_id, submitted_at, score_pct, critical_fail_count, gold_star_count, waiting_time_band, final_status')
    .in('invitation_id', invitationIds)
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: true })

  if (subErr) return { ok: false, error: subErr.message }
  if (!subs || subs.length === 0) {
    return { ok: true, consistent: true, checkpoints: [], columns: [] }
  }

  // Step 3: Template consistency check
  const templateIds = [...new Set(
    subs.map(s => s.template_id as string | null).filter((t): t is string => !!t)
  )]
  const consistent      = templateIds.length <= 1
  const activeTemplateId = (subs[subs.length - 1].template_id ?? templateIds[0]) as string | undefined

  if (!activeTemplateId) return { ok: true, consistent: true, checkpoints: [], columns: [] }

  const activeSubs = consistent ? subs : subs.filter(s => s.template_id === activeTemplateId)

  // Step 4: Checkpoints for the active template (exclude informational)
  const { data: checkpointRows, error: cpErr } = await db
    .from('diner_checkpoints')
    .select('id, order_index, section, label, type, is_critical, is_conditional')
    .eq('template_id', activeTemplateId)
    .neq('type', 'informational')
    .order('order_index', { ascending: true })

  if (cpErr) return { ok: false, error: cpErr.message }

  // Step 5: All responses for active submissions in one query
  const subIds = activeSubs.map(s => s.id as string)
  const { data: responses, error: rErr } = await db
    .from('diner_responses')
    .select('submission_id, checkpoint_id, result, notes')
    .in('submission_id', subIds)

  if (rErr) return { ok: false, error: rErr.message }

  // Step 6: Build lookup: submissionId → { checkpointId → { result, notes } }
  const bySubmission = new Map<string, Record<string, { result: 'pass' | 'fail' | 'na' | null; notes: string | null }>>()
  for (const r of responses ?? []) {
    const sid = r.submission_id as string
    const cid = r.checkpoint_id as string
    const map = bySubmission.get(sid) ?? {}
    map[cid] = {
      result: (r.result as 'pass' | 'fail' | 'na' | null) ?? null,
      notes:  (r.notes as string | null) ?? null,
    }
    bySubmission.set(sid, map)
  }

  const columns: DinerMatrixColumn[] = activeSubs.map(s => {
    const scorePct  = s.score_pct as number | null
    const critFails = (s.critical_fail_count as number | null) ?? 0
    const dbStatus  = s.final_status as DinerStatus | null
    const finalStatus = dbStatus ?? computeDinerStatus(scorePct, critFails)

    return {
      submissionId:        s.id as string,
      submittedAt:         s.submitted_at as string,
      dinerName:           invMap.get(s.invitation_id as string) ?? '—',
      score_pct:           scorePct,
      critical_fail_count: s.critical_fail_count as number | null,
      gold_star_count:     s.gold_star_count as number | null,
      waiting_time_band:   s.waiting_time_band as string | null,
      final_status:        finalStatus,
      responses:           bySubmission.get(s.id as string) ?? {},
    }
  })

  const checkpoints: DinerMatrixCheckpoint[] = (checkpointRows ?? []).map(c => ({
    id:             c.id as string,
    order_index:    c.order_index as number,
    section:        (c.section as string) ?? '',
    label:          c.label as string,
    type:           c.type as 'scored' | 'gold_star' | 'waiting_time' | 'informational',
    is_critical:    c.is_critical as boolean,
    is_conditional: c.is_conditional as boolean,
  }))

  const inconsistencyNote = consistent
    ? undefined
    : `${templateIds.length - 1} older visit version(s) excluded — checkpoint sets differ across template versions.`

  return { ok: true, consistent, inconsistencyNote, checkpoints, columns }
}
