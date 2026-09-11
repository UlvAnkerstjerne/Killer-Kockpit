'use server'

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import type { ActionResult } from '@/lib/types'

export async function upsertAuditResponse(
  submissionId: string,
  checkpointId: string,
  result: 'pass' | 'fail' | 'na',
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessQualityCheck(user.role)) return { error: 'Not authorised' }

  const supabase = await createClient()

  const { error } = await supabase
    .from('audit_responses')
    .upsert(
      { submission_id: submissionId, checkpoint_id: checkpointId, result },
      { onConflict: 'submission_id,checkpoint_id' },
    )

  if (error) {
    console.error('[audit] upsertAuditResponse error:', error)
    return { error: error.message }
  }

  return {}
}

// Fields that can be patched one at a time while an audit is in progress
export type AuditFinalFieldPatch =
  | { field: 'final_done_well';        value: string }
  | { field: 'final_focus_next';       value: string }
  | { field: 'final_overall_comments'; value: string }
  | { field: 'final_mod_informed';     value: boolean | null }
  | { field: 'final_corrective_action'; value: string }
  | { field: 'follow_up_requested';    value: boolean }
  | { field: 'follow_up_date';         value: string | null }

export async function submitAudit(
  submissionId: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessQualityCheck(user.role)) return { error: 'Not authorised' }

  // SECURITY DEFINER RPC — must be called via service-role client.
  // The function validates the actor via p_actor_user_id before mutating anything.
  const supabase = createServiceClient()

  const { error } = await supabase.rpc('submit_audit', {
    p_submission_id: submissionId,
    p_actor_user_id: user.id,
  })

  if (error) {
    console.error('[audit] submitAudit error:', error)
    return { error: error.message }
  }

  return {}
}

export async function upsertTopAction(
  submissionId: string,
  sortOrder: 1 | 2 | 3,
  action: string,
  owner: string,
  deadline: string,
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessQualityCheck(user.role)) return { error: 'Not authorised' }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('audit_top_actions')
    .upsert(
      { submission_id: submissionId, sort_order: sortOrder, action, owner, deadline },
      { onConflict: 'submission_id,sort_order' },
    )
    .select('id')
    .single()

  if (error || !data) {
    console.error('[audit] upsertTopAction error:', error)
    return { error: error?.message ?? 'Failed to save action' }
  }

  return { data: { id: data.id } }
}

export async function deleteTopAction(
  submissionId: string,
  sortOrder: 1 | 2 | 3,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessQualityCheck(user.role)) return { error: 'Not authorised' }

  const supabase = await createClient()

  const { error } = await supabase
    .from('audit_top_actions')
    .delete()
    .eq('submission_id', submissionId)
    .eq('sort_order', sortOrder)

  if (error) {
    console.error('[audit] deleteTopAction error:', error)
    return { error: error.message }
  }

  return {}
}

export async function updateAuditFinalField(
  submissionId: string,
  patch: AuditFinalFieldPatch,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessQualityCheck(user.role)) return { error: 'Not authorised' }

  const supabase = await createClient()

  const update: Record<string, unknown> = { [patch.field]: patch.value }

  // Nullify follow_up_date when follow_up_requested is toggled off
  if (patch.field === 'follow_up_requested' && !patch.value) {
    update.follow_up_date = null
  }

  const { error } = await supabase
    .from('audit_submissions')
    .update(update)
    .eq('id', submissionId)

  if (error) {
    console.error('[audit] updateAuditFinalField error:', error)
    return { error: error.message }
  }

  return {}
}

export async function upsertSectionComment(
  submissionId: string,
  section: string,
  comment: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessQualityCheck(user.role)) return { error: 'Not authorised' }

  const supabase = await createClient()

  const { error } = await supabase
    .from('audit_section_comments')
    .upsert(
      { submission_id: submissionId, section, comment },
      { onConflict: 'submission_id,section' },
    )

  if (error) {
    console.error('[audit] upsertSectionComment error:', error)
    return { error: error.message }
  }

  return {}
}

// ── Store audit matrix ─────────────────────────────────────────────────────────

export interface MatrixCheckpoint {
  id: string
  sort_order: number
  section: string
  title: string
  is_core_standard: boolean
  is_red_flag: boolean
}

export interface MatrixColumn {
  submissionId: string
  submittedAt: string
  auditorName: string
  score_pct: number | null
  core_score_pct: number | null
  red_flag_count: number | null
  audit_status: string | null
  responses: Record<string, 'pass' | 'fail' | 'na'>
}

export type StoreAuditMatrixResult =
  | { ok: false; error: string }
  | { ok: true; consistent: boolean; inconsistencyNote?: string; checkpoints: MatrixCheckpoint[]; columns: MatrixColumn[] }

/**
 * Fetches all checkpoint definitions and responses for submitted audits at a
 * given location, structured for the checkpoint matrix view.
 *
 * Template versioning: if submissions span multiple template versions, only the
 * latest version group is returned and inconsistencyNote is set. Older audits
 * whose checkpoints differ are excluded rather than guessed.
 */
export async function fetchStoreAuditMatrix(locationId: string): Promise<StoreAuditMatrixResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  if (!canAccessQualityCheck(user.role)) return { ok: false, error: 'Not authorised' }

  const supabase = await createClient()

  // 1. Submitted audits for this location, oldest first
  const { data: subs, error: subErr } = await supabase
    .from('audit_submissions')
    .select(`
      id, template_id, submitted_at,
      score_pct, core_score_pct, red_flag_count, audit_status,
      app_users!auditor_user_id ( display_name )
    `)
    .eq('location_id', locationId)
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: true })

  if (subErr) return { ok: false, error: subErr.message }
  if (!subs || subs.length === 0) {
    return { ok: true, consistent: true, checkpoints: [], columns: [] }
  }

  // 2. Template consistency check
  const templateIds = [...new Set(subs.map(s => s.template_id as string))]
  const consistent = templateIds.length === 1

  // Latest template = template of the most recently submitted audit (last in asc sort)
  const activeTemplateId = subs[subs.length - 1].template_id as string
  const activeSubs = consistent ? subs : subs.filter(s => s.template_id === activeTemplateId)

  // 3. Checkpoints for the active template, in sort_order
  const { data: checkpoints, error: cpErr } = await supabase
    .from('audit_checkpoints')
    .select('id, sort_order, section, title, is_core_standard, is_red_flag')
    .eq('template_id', activeTemplateId)
    .order('sort_order', { ascending: true })

  if (cpErr) return { ok: false, error: cpErr.message }

  // 4. Responses for all active submissions in one query
  const subIds = activeSubs.map(s => s.id as string)
  const { data: responses, error: rErr } = await supabase
    .from('audit_responses')
    .select('submission_id, checkpoint_id, result')
    .in('submission_id', subIds)

  if (rErr) return { ok: false, error: rErr.message }

  // 5. Build response lookup: submissionId → { checkpointId → result }
  const bySubmission = new Map<string, Record<string, 'pass' | 'fail' | 'na'>>()
  for (const r of responses ?? []) {
    if (!r.result) continue
    const sid = r.submission_id as string
    const cid = r.checkpoint_id as string
    const map = bySubmission.get(sid) ?? {}
    map[cid] = r.result as 'pass' | 'fail' | 'na'
    bySubmission.set(sid, map)
  }

  const columns: MatrixColumn[] = activeSubs.map(s => ({
    submissionId:   s.id as string,
    submittedAt:    s.submitted_at as string,
    auditorName:    (s.app_users as unknown as { display_name: string } | null)?.display_name ?? '—',
    score_pct:      s.score_pct      as number | null,
    core_score_pct: s.core_score_pct as number | null,
    red_flag_count: s.red_flag_count as number | null,
    audit_status:   s.audit_status   as string | null,
    responses:      bySubmission.get(s.id as string) ?? {},
  }))

  const matrixCheckpoints: MatrixCheckpoint[] = (checkpoints ?? []).map(c => ({
    id:               c.id as string,
    sort_order:       c.sort_order as number,
    section:          (c.section as string) ?? '',
    title:            c.title as string,
    is_core_standard: c.is_core_standard as boolean,
    is_red_flag:      c.is_red_flag as boolean,
  }))

  const inconsistencyNote = consistent
    ? undefined
    : `${templateIds.length - 1} older audit version(s) not shown — checkpoint sets differ across template versions.`

  return { ok: true, consistent, inconsistencyNote, checkpoints: matrixCheckpoints, columns }
}

export async function startAudit(
  locationId: string,
  managerOnDuty: string,
): Promise<ActionResult<{ submissionId: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessQualityCheck(user.role)) return { error: 'Not authorised' }

  const trimmed = managerOnDuty.trim()
  if (!trimmed) return { error: 'Manager on Duty is required' }
  if (!locationId) return { error: 'Location is required' }

  const supabase = await createClient()

  // Resolve the published template
  const { data: template, error: tErr } = await supabase
    .from('audit_templates')
    .select('id')
    .eq('audit_key', 'operational_audit')
    .eq('status', 'published')
    .single()

  if (tErr || !template) return { error: 'No published Operational Audit template found' }

  // Verify location is active (belt-and-suspenders — RLS already filters, but
  // we want a clear error message rather than a silent empty result)
  const { data: location, error: lErr } = await supabase
    .from('locations')
    .select('id, active')
    .eq('id', locationId)
    .single()

  if (lErr || !location) return { error: 'Location not found' }
  if (!location.active) return { error: 'Only active locations may be audited' }

  // Create the submission — auditor is always the current user
  const { data: submission, error: sErr } = await supabase
    .from('audit_submissions')
    .insert({
      template_id: template.id,
      location_id: locationId,
      auditor_user_id: user.id,
      manager_on_duty: trimmed,
      status: 'in_progress',
    })
    .select('id')
    .single()

  if (sErr || !submission) {
    console.error('[audit] startAudit insert error:', sErr)
    return { error: 'Failed to create audit. Please try again.' }
  }

  return { data: { submissionId: submission.id } }
}
