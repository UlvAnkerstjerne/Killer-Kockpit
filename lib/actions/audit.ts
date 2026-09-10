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
