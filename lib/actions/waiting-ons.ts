'use server'

import { revalidatePath } from 'next/cache'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canEditWaitingOn, isAdminOverride } from '@/lib/permissions'
import type { WaitingStatus, ActionResult } from '@/lib/types'

type WaitingOnInput = {
  title: string
  owner_user_id?: string
  waiting_for_user_id?: string
  waiting_for_name?: string
  project_id?: string
  due_at?: string
  notes?: string
}

export async function createWaitingOn(
  input: WaitingOnInput
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const serviceClient = createServiceClient()

  const { data: waitingOnId, error } = await serviceClient.rpc('create_waiting_on_and_audit', {
    p_title:                 input.title.trim(),
    p_owner_user_id:         input.owner_user_id || user.id,
    p_waiting_for_user_id:   input.waiting_for_user_id || null,
    p_waiting_for_name:      input.waiting_for_name?.trim() || null,
    p_project_id:            input.project_id || null,
    p_due_at:                input.due_at || null,
    p_notes:                 input.notes?.trim() || null,
    p_actor_user_id:         user.id,
  })

  if (error) {
    console.error('[createWaitingOn]', error)
    return { error: 'Failed to create waiting on. Please try again.' }
  }

  revalidatePath('/waiting-ons')
  revalidatePath('/today')
  return { data: { id: waitingOnId as string } }
}

export async function updateWaitingOn(
  waitingOnId: string,
  input: Partial<WaitingOnInput>
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('waiting_ons')
    .select('*')
    .eq('id', waitingOnId)
    .single()

  if (fetchError || !current) return { error: 'Waiting on not found.' }

  if (!canEditWaitingOn(user.role, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to edit this waiting on.' }
  }

  const patch: Record<string, unknown> = {}
  const before: Record<string, unknown> = {}

  const fields = ['title', 'notes', 'waiting_for_user_id', 'waiting_for_name', 'project_id', 'due_at'] as const
  for (const field of fields) {
    if (input[field as keyof typeof input] !== undefined) {
      const newVal = field === 'title' || field === 'notes' || field === 'waiting_for_name'
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
    adminOverride ? 'update_waiting_on_and_audit_as_admin' : 'update_waiting_on_and_audit',
    {
      p_waiting_on_id: waitingOnId,
      p_actor_user_id: user.id,
      p_patch:         patch,
      p_before:        before,
      ...(adminOverride ? { p_override_note: 'Administrative override of waiting on' } : {}),
    }
  )

  if (error) {
    console.error('[updateWaitingOn]', error)
    return { error: 'Failed to save changes. Please try again.' }
  }

  revalidatePath('/waiting-ons')
  revalidatePath(`/waiting-ons/${waitingOnId}`)
  revalidatePath('/today')
  return {}
}

export async function fulfillWaitingOn(waitingOnId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('waiting_ons')
    .select('id, owner_user_id, status')
    .eq('id', waitingOnId)
    .single()

  if (fetchError || !current) return { error: 'Waiting on not found.' }

  if (!canEditWaitingOn(user.role, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to fulfil this waiting on.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('fulfill_waiting_on_and_audit', {
    p_waiting_on_id: waitingOnId,
    p_actor_user_id: user.id,
    p_before_status: current.status as WaitingStatus,
  })

  if (error) return { error: 'Failed to mark as fulfilled.' }

  revalidatePath('/waiting-ons')
  revalidatePath(`/waiting-ons/${waitingOnId}`)
  revalidatePath('/today')
  return {}
}

export async function cancelWaitingOn(waitingOnId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('waiting_ons')
    .select('id, owner_user_id, status')
    .eq('id', waitingOnId)
    .single()

  if (fetchError || !current) return { error: 'Waiting on not found.' }

  if (!canEditWaitingOn(user.role, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to cancel this waiting on.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('cancel_waiting_on_and_audit', {
    p_waiting_on_id: waitingOnId,
    p_actor_user_id: user.id,
    p_before_status: current.status as WaitingStatus,
  })

  if (error) return { error: 'Failed to cancel waiting on.' }

  revalidatePath('/waiting-ons')
  revalidatePath('/today')
  return {}
}

export async function reopenWaitingOn(waitingOnId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('waiting_ons')
    .select('id, owner_user_id, status')
    .eq('id', waitingOnId)
    .single()

  if (fetchError || !current) return { error: 'Waiting on not found.' }

  if (!canEditWaitingOn(user.role, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to reopen this waiting on.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('reopen_waiting_on_and_audit', {
    p_waiting_on_id: waitingOnId,
    p_actor_user_id: user.id,
    p_before_status: current.status,
  })

  if (error) return { error: 'Failed to reopen waiting on.' }

  revalidatePath('/waiting-ons')
  revalidatePath(`/waiting-ons/${waitingOnId}`)
  revalidatePath('/today')
  return {}
}
