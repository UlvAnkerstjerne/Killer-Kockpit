'use server'

import { revalidatePath } from 'next/cache'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canEditMeeting } from '@/lib/permissions'
import type { ActionResult } from '@/lib/types'

export async function createAgendaItem(
  meetingId: string,
  input: { title: string; description?: string; sortOrder?: number }
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: meeting } = await supabase
    .from('meetings')
    .select('id, status, owner_user_id')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found.' }
  if (!canEditMeeting(user.role, meeting.owner_user_id, user.id)) {
    return { error: 'You do not have permission to edit this meeting.' }
  }

  const serviceClient = createServiceClient()
  const { data: itemId, error } = await serviceClient.rpc('create_agenda_item_and_audit', {
    p_meeting_id: meetingId,
    p_title: input.title.trim(),
    p_description: input.description?.trim() || null,
    p_sort_order: input.sortOrder ?? 0,
    p_related_entity_type: null,
    p_related_entity_id: null,
    p_actor_user_id: user.id,
  })

  if (error) {
    console.error('[createAgendaItem]', error)
    return { error: 'Failed to create agenda item.' }
  }

  revalidatePath(`/meetings/${meetingId}`)
  return { data: { id: itemId as string } }
}

export async function updateAgendaItem(
  itemId: string,
  meetingId: string,
  input: { title?: string; description?: string; status?: string }
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: meeting } = await supabase
    .from('meetings')
    .select('id, status, owner_user_id')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found.' }
  if (!canEditMeeting(user.role, meeting.owner_user_id, user.id)) {
    return { error: 'You do not have permission to edit this meeting.' }
  }

  const { data: current } = await supabase
    .from('agenda_items')
    .select('title, description, status')
    .eq('id', itemId)
    .single()

  if (!current) return { error: 'Agenda item not found.' }

  const patch: Record<string, unknown> = {}
  const before: Record<string, unknown> = {}

  if (input.title !== undefined && input.title.trim() !== current.title) {
    patch.title = input.title.trim()
    before.title = current.title
  }
  if (input.description !== undefined && (input.description || null) !== current.description) {
    patch.description = input.description || null
    before.description = current.description
  }
  if (input.status !== undefined && input.status !== current.status) {
    patch.status = input.status
    before.status = current.status
  }

  if (Object.keys(patch).length === 0) return {}

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('update_agenda_item_and_audit', {
    p_agenda_item_id: itemId,
    p_actor_user_id: user.id,
    p_patch: patch,
    p_before: before,
  })

  if (error) return { error: 'Failed to update agenda item.' }

  revalidatePath(`/meetings/${meetingId}`)
  return {}
}

export async function reorderAgendaItems(
  meetingId: string,
  order: { id: string; sort_order: number }[]
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: meeting } = await supabase
    .from('meetings')
    .select('id, status, owner_user_id')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found.' }
  if (!canEditMeeting(user.role, meeting.owner_user_id, user.id)) {
    return { error: 'You do not have permission to edit this meeting.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('reorder_agenda_items', {
    p_meeting_id: meetingId,
    p_order: order,
    p_actor_user_id: user.id,
  })

  if (error) return { error: 'Failed to reorder agenda items.' }

  revalidatePath(`/meetings/${meetingId}`)
  return {}
}
