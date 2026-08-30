'use server'

import { revalidatePath } from 'next/cache'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canEditMeeting } from '@/lib/permissions'
import type { MeetingOutcomeKind, ActionResult } from '@/lib/types'

export async function createMeetingOutcome(
  meetingId: string,
  input: {
    kind: MeetingOutcomeKind
    title: string
    payload_json?: Record<string, unknown>
    sort_order?: number
  }
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
  if (meeting.status !== 'open' && meeting.status !== 'draft') {
    return { error: 'Outcomes can only be added to open or draft meetings.' }
  }

  const serviceClient = createServiceClient()
  const { data: outcomeId, error } = await serviceClient.rpc('create_meeting_outcome_and_audit', {
    p_meeting_id: meetingId,
    p_kind: input.kind,
    p_title: input.title.trim(),
    p_payload_json: input.payload_json ?? {},
    p_sort_order: input.sort_order ?? 0,
    p_proposed_by_user_id: user.id,
    p_actor_user_id: user.id,
  })

  if (error) {
    console.error('[createMeetingOutcome]', error)
    return { error: 'Failed to create outcome.' }
  }

  revalidatePath(`/meetings/${meetingId}`)
  return { data: { id: outcomeId as string } }
}

export async function updateMeetingOutcome(
  outcomeId: string,
  meetingId: string,
  input: { title?: string; payload_json?: Record<string, unknown> }
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
    .from('meeting_outcomes')
    .select('title, payload_json')
    .eq('id', outcomeId)
    .single()

  if (!current) return { error: 'Outcome not found.' }

  const patch: Record<string, unknown> = {}
  const before: Record<string, unknown> = {}

  if (input.title !== undefined && input.title.trim() !== current.title) {
    patch.title = input.title.trim()
    before.title = current.title
  }
  if (input.payload_json !== undefined) {
    patch.payload_json = JSON.stringify(input.payload_json)
    before.payload_json = JSON.stringify(current.payload_json)
  }

  if (Object.keys(patch).length === 0) return {}

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('update_meeting_outcome_and_audit', {
    p_outcome_id: outcomeId,
    p_actor_user_id: user.id,
    p_patch: patch,
    p_before: before,
  })

  if (error) return { error: 'Failed to update outcome.' }

  revalidatePath(`/meetings/${meetingId}`)
  return {}
}

export async function removeMeetingOutcome(
  outcomeId: string,
  meetingId: string
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
  const { error } = await serviceClient.rpc('remove_meeting_outcome_and_audit', {
    p_outcome_id: outcomeId,
    p_actor_user_id: user.id,
  })

  if (error) return { error: 'Failed to remove outcome.' }

  revalidatePath(`/meetings/${meetingId}`)
  return {}
}
