'use server'

import { revalidatePath } from 'next/cache'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canCreateDecision, canEditDecision, canApproveDecision, isAdminOverride } from '@/lib/permissions'
import type { DecisionStatus, ActionResult } from '@/lib/types'

type DecisionInput = {
  title: string
  decision_text: string
  rationale?: string
  project_id?: string
  decided_at?: string
  status?: DecisionStatus
}

export async function createDecision(
  input: DecisionInput & { supersedes_decision_id?: string }
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  if (!canCreateDecision(user.role)) {
    return { error: 'You do not have permission to record decisions.' }
  }

  const serviceClient = createServiceClient()

  const { data: decisionId, error } = await serviceClient.rpc('create_decision_and_audit', {
    p_title:                  input.title.trim(),
    p_decision_text:          input.decision_text.trim(),
    p_rationale:              input.rationale?.trim() || null,
    p_owner_user_id:          user.id,
    p_project_id:             input.project_id || null,
    p_decided_at:             input.decided_at || null,
    p_status:                 input.status || 'proposed',
    p_supersedes_decision_id: input.supersedes_decision_id || null,
    p_actor_user_id:          user.id,
  })

  if (error) {
    console.error('[createDecision]', error)
    return { error: 'Failed to create decision. Please try again.' }
  }

  revalidatePath('/decisions')
  if (input.project_id) revalidatePath(`/projects/${input.project_id}`)
  return { data: { id: decisionId as string } }
}

export async function updateDecision(
  decisionId: string,
  input: Partial<DecisionInput>
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('decisions')
    .select('*')
    .eq('id', decisionId)
    .single()

  if (fetchError || !current) return { error: 'Decision not found.' }

  // Only the owner or SUPER_ADMIN may edit an existing decision.
  if (!canEditDecision(user.role, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to edit this decision.' }
  }

  const patch: Record<string, unknown> = {}
  const before: Record<string, unknown> = {}

  const fields = ['title', 'decision_text', 'rationale', 'project_id', 'decided_at', 'status'] as const
  for (const field of fields) {
    if (input[field as keyof typeof input] !== undefined) {
      const newVal = field === 'title' || field === 'decision_text' || field === 'rationale'
        ? (input[field as keyof typeof input] as string)?.trim() ?? null
        : input[field as keyof typeof input]

      if (newVal !== current[field]) {
        patch[field] = newVal
        before[field] = current[field]
      }
    }
  }

  if (Object.keys(patch).length === 0) return {}

  const adminOverride = isAdminOverride(user.role, current.owner_user_id, user.id)
  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc(
    adminOverride ? 'update_decision_and_audit_as_admin' : 'update_decision_and_audit',
    {
      p_decision_id:   decisionId,
      p_actor_user_id: user.id,
      p_patch:         patch,
      p_before:        before,
      ...(adminOverride ? { p_override_note: 'Administrative override of decision' } : {}),
    }
  )

  if (error) {
    console.error('[updateDecision]', error)
    return { error: 'Failed to save changes. Please try again.' }
  }

  revalidatePath('/decisions')
  revalidatePath(`/decisions/${decisionId}`)
  if (current.project_id) revalidatePath(`/projects/${current.project_id}`)
  return {}
}

export async function approveDecision(decisionId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  if (!canApproveDecision(user.role)) {
    return { error: 'You do not have permission to approve decisions.' }
  }

  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('decisions')
    .select('id, status, project_id')
    .eq('id', decisionId)
    .single()

  if (fetchError || !current) return { error: 'Decision not found.' }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('approve_decision_and_audit', {
    p_decision_id:          decisionId,
    p_actor_user_id:        user.id,
    p_approved_by_user_id:  user.id,
    p_before_status:        current.status as DecisionStatus,
  })

  if (error) return { error: 'Failed to approve decision.' }

  revalidatePath('/decisions')
  revalidatePath(`/decisions/${decisionId}`)
  if (current.project_id) revalidatePath(`/projects/${current.project_id}`)
  return {}
}
