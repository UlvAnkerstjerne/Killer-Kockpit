'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import {
  getGoogleConnectionStatus,
  deleteGoogleTokens,
  type GoogleConnectionStatus,
} from '@/lib/google/auth'
import { syncMeetingToCalendarForUser } from '@/lib/google/sync'
import { canEditMeeting } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import type { ActionResult } from '@/lib/types'

/** Returns safe Google connection metadata for the current user. No tokens. */
export async function getMyGoogleConnectionStatus(): Promise<GoogleConnectionStatus> {
  const user = await getCurrentUser()
  if (!user) return { connected: false }
  return getGoogleConnectionStatus(user.id)
}

/** Removes stored tokens — disconnects Google Calendar for the current user. */
export async function disconnectGoogleCalendar(): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  await deleteGoogleTokens(user.id)
  revalidatePath('/settings')
  return {}
}

/**
 * User-triggered: create or update the Google Calendar event for a meeting.
 * Requires the current user to have Google connected and edit permission.
 */
export async function syncMeetingToCalendar(
  meetingId: string
): Promise<ActionResult<{ eventId: string; meetWarning?: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  // Verify permission
  const serviceClient = createServiceClient()
  const { data: meeting } = await serviceClient
    .from('meetings')
    .select('owner_user_id, scheduled_start, scheduled_end')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found.' }
  if (!canEditMeeting(user.role, meeting.owner_user_id, user.id)) {
    return { error: 'You do not have permission to sync this meeting.' }
  }
  if (!meeting.scheduled_start || !meeting.scheduled_end) {
    return { error: 'Add a scheduled start and end time before sending to Calendar.' }
  }

  const result = await syncMeetingToCalendarForUser(meetingId, user.id)

  revalidatePath(`/meetings/${meetingId}`)

  if (result.ok) return { data: { eventId: result.eventId, meetWarning: result.meetWarning } }
  return { error: result.error }
}
