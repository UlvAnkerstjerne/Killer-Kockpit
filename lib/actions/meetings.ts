'use server'

import { revalidatePath } from 'next/cache'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canCreateMeeting, canEditMeeting } from '@/lib/permissions'
import { resyncMeetingCalendar, syncMeetingToCalendarForUser } from '@/lib/google/sync'
import { wallToUtc } from '@/lib/time'
import type { MeetingStatus, ActionResult } from '@/lib/types'

type MeetingInput = {
  title: string
  owner_user_id?: string
  project_id?: string
  scheduled_start?: string
  scheduled_end?: string
  context?: string
  location?: string
}

export async function createMeeting(input: MeetingInput): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canCreateMeeting(user.role)) {
    return { error: 'You do not have permission to create meetings.' }
  }

  const serviceClient = createServiceClient()
  const { data: meetingId, error } = await serviceClient.rpc('create_meeting_and_audit', {
    p_title: input.title.trim(),
    p_owner_user_id: input.owner_user_id || user.id,
    p_project_id: input.project_id || null,
    p_scheduled_start: input.scheduled_start ? wallToUtc(input.scheduled_start) : null,
    p_scheduled_end:   input.scheduled_end   ? wallToUtc(input.scheduled_end)   : null,
    p_context: input.context?.trim() || null,
    p_location: input.location?.trim() || null,
    p_created_by_user_id: user.id,
    p_actor_user_id: user.id,
  })

  if (error) {
    console.error('[createMeeting]', error)
    return { error: 'Failed to create meeting. Please try again.' }
  }

  revalidatePath('/meetings')
  revalidatePath('/today')
  return { data: { id: meetingId as string } }
}

// ─── createMeetingWithSetup ────────────────────────────────────────────────────
//
// One-shot creation: meeting + attendees + agenda items + Google Calendar/Meet sync.
// Called from the new meeting form so users never need to visit the meeting detail
// just to add attendees or agenda items.
//
// Failure strategy:
//   • Meeting creation failure → hard error (nothing created).
//   • Attendee / agenda failures → logged, skipped; meeting still created.
//   • Calendar sync failure → meeting created; warning returned in result.
//     The detail page CalendarSection allows retry.

type SetupAttendee = {
  userId?:       string
  externalName?: string
  externalEmail?: string
}

type SetupAgendaItem = {
  title:        string
  description?: string
}

export async function createMeetingWithSetup(input: {
  title:           string
  owner_user_id?:  string
  project_id?:     string
  scheduled_start?: string
  scheduled_end?:   string
  context?:        string
  location?:       string
  attendees:       SetupAttendee[]
  agendaItems:     SetupAgendaItem[]
}): Promise<ActionResult<{ id: string; calendarWarning?: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canCreateMeeting(user.role)) {
    return { error: 'You do not have permission to create meetings.' }
  }

  const serviceClient = createServiceClient()

  // 1. Create the meeting
  const { data: meetingId, error: createError } = await serviceClient.rpc('create_meeting_and_audit', {
    p_title:              input.title.trim(),
    p_owner_user_id:      input.owner_user_id || user.id,
    p_project_id:         input.project_id || null,
    p_scheduled_start:    input.scheduled_start ? wallToUtc(input.scheduled_start) : null,
    p_scheduled_end:      input.scheduled_end   ? wallToUtc(input.scheduled_end)   : null,
    p_context:            input.context?.trim() || null,
    p_location:           input.location?.trim() || null,
    p_created_by_user_id: user.id,
    p_actor_user_id:      user.id,
  })

  if (createError) {
    console.error('[createMeetingWithSetup] create:', createError)
    return { error: 'Failed to create meeting. Please try again.' }
  }

  const id = meetingId as string

  // 2. Add attendees (best-effort; individual failures don't fail the operation)
  for (const att of input.attendees) {
    if (!att.userId && !att.externalName && !att.externalEmail) continue
    const { error: attErr } = await serviceClient.rpc('add_meeting_attendee', {
      p_meeting_id:    id,
      p_user_id:       att.userId       || null,
      p_external_name: att.externalName || null,
      p_external_email: att.externalEmail || null,
      p_actor_user_id: user.id,
    })
    if (attErr) console.error('[createMeetingWithSetup] attendee:', attErr.message)
  }

  // 3. Add agenda items (best-effort; individual failures don't fail the operation)
  for (let i = 0; i < input.agendaItems.length; i++) {
    const item = input.agendaItems[i]
    if (!item.title.trim()) continue
    const { error: itemErr } = await serviceClient.rpc('create_agenda_item_and_audit', {
      p_meeting_id:          id,
      p_title:               item.title.trim(),
      p_description:         item.description?.trim() || null,
      p_sort_order:          i,
      p_related_entity_type: null,
      p_related_entity_id:   null,
      p_actor_user_id:       user.id,
    })
    if (itemErr) console.error('[createMeetingWithSetup] agenda item:', itemErr.message)
  }

  // 4. Google Calendar + Meet sync — only when a scheduled time is provided
  let calendarWarning: string | undefined
  if (input.scheduled_start && input.scheduled_end) {
    const syncResult = await syncMeetingToCalendarForUser(id, user.id)
    if (!syncResult.ok) {
      calendarWarning = syncResult.error
    } else if (syncResult.meetWarning) {
      calendarWarning = syncResult.meetWarning
    }
  }

  revalidatePath('/meetings')
  revalidatePath('/today')
  return { data: { id, calendarWarning } }
}

export async function updateMeeting(
  meetingId: string,
  input: Partial<MeetingInput> & { working_notes?: string }
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('meetings')
    .select('*')
    .eq('id', meetingId)
    .single()

  if (fetchError || !current) return { error: 'Meeting not found.' }
  if (!canEditMeeting(user.role, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to edit this meeting.' }
  }

  // working_notes editable while open or in draft (review stage)
  if (input.working_notes !== undefined && current.status !== 'open' && current.status !== 'draft') {
    return { error: 'Working notes can only be edited while the meeting is open or in draft.' }
  }

  const patch: Record<string, unknown> = {}
  const before: Record<string, unknown> = {}

  const fields = ['title', 'context', 'working_notes', 'owner_user_id', 'project_id', 'scheduled_start', 'scheduled_end', 'location'] as const
  for (const field of fields) {
    const val = input[field as keyof typeof input]
    if (val !== undefined) {
      // Datetime fields: convert wall-clock input to UTC and compare by epoch ms
      // to avoid spurious updates caused by format differences (e.g. Z vs +00:00).
      if (field === 'scheduled_start' || field === 'scheduled_end') {
        const newVal: string | null = (val as string) ? wallToUtc(val as string) : null
        const newMs  = newVal ? new Date(newVal).getTime() : null
        const curMs  = current[field] ? new Date(current[field] as string).getTime() : null
        if (newMs !== curMs) {
          patch[field]  = newVal
          before[field] = current[field]
        }
        continue
      }

      const newVal = field === 'title' || field === 'context' || field === 'location'
        ? (val as string)?.trim() || null
        : val || null
      if (newVal !== current[field]) {
        patch[field]  = newVal
        before[field] = current[field]
      }
    }
  }

  if (Object.keys(patch).length === 0) return {}

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('update_meeting_and_audit', {
    p_meeting_id: meetingId,
    p_actor_user_id: user.id,
    p_patch: patch,
    p_before: before,
  })

  if (error) {
    console.error('[updateMeeting]', error)
    return { error: 'Failed to save changes. Please try again.' }
  }

  // If scheduling or location changed and a Calendar event exists, resync it.
  // Failures are captured in calendar_sync_status — they don't block this response.
  const schedulingChanged = patch.scheduled_start !== undefined || patch.scheduled_end !== undefined || patch.location !== undefined
  if (schedulingChanged && current.calendar_event_id) {
    await resyncMeetingCalendar(meetingId)
  }

  revalidatePath('/meetings')
  revalidatePath(`/meetings/${meetingId}`)
  return {}
}

export async function openMeeting(meetingId: string): Promise<ActionResult> {
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
    return { error: 'You do not have permission to open this meeting.' }
  }
  if (meeting.status !== 'scheduled') {
    return { error: 'Only scheduled meetings can be opened.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('open_meeting_and_audit', {
    p_meeting_id: meetingId,
    p_actor_user_id: user.id,
    p_actual_start: new Date().toISOString(),
  })

  if (error) return { error: 'Failed to open meeting.' }

  revalidatePath(`/meetings/${meetingId}`)
  revalidatePath('/today')
  return {}
}

export async function closeMeeting(meetingId: string): Promise<ActionResult> {
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
    return { error: 'You do not have permission to close this meeting.' }
  }
  if (meeting.status !== 'open') {
    return { error: 'Only open meetings can be closed to draft.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('close_meeting_and_audit', {
    p_meeting_id: meetingId,
    p_actor_user_id: user.id,
    p_actual_end: new Date().toISOString(),
  })

  if (error) return { error: 'Failed to close meeting.' }

  revalidatePath(`/meetings/${meetingId}`)
  return {}
}

export async function cancelMeeting(meetingId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: meeting } = await supabase
    .from('meetings')
    .select('id, status, owner_user_id, calendar_event_id')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found.' }
  if (!canEditMeeting(user.role, meeting.owner_user_id, user.id)) {
    return { error: 'You do not have permission to cancel this meeting.' }
  }
  if (meeting.status === 'published' || meeting.status === 'cancelled') {
    return { error: 'This meeting cannot be cancelled.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('cancel_meeting_and_audit', {
    p_meeting_id: meetingId,
    p_actor_user_id: user.id,
    p_before_status: meeting.status,
  })

  if (error) return { error: 'Failed to cancel meeting.' }

  revalidatePath('/meetings')
  revalidatePath(`/meetings/${meetingId}`)
  revalidatePath('/today')
  return {}
}

export async function publishMeeting(meetingId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canCreateMeeting(user.role)) {
    return { error: 'You do not have permission to publish meetings.' }
  }

  const supabase = await createClient()
  const { data: meeting } = await supabase
    .from('meetings')
    .select('id, status, owner_user_id')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found.' }
  if (!canEditMeeting(user.role, meeting.owner_user_id, user.id)) {
    return { error: 'You do not have permission to publish this meeting.' }
  }
  if (meeting.status !== 'draft') {
    return { error: 'Only draft meetings can be published.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('publish_meeting_and_audit', {
    p_meeting_id: meetingId,
    p_actor_user_id: user.id,
  })

  if (error) {
    console.error('[publishMeeting]', error)
    return { error: 'Failed to publish meeting. Please try again.' }
  }

  revalidatePath('/meetings')
  revalidatePath(`/meetings/${meetingId}`)
  revalidatePath('/today')
  revalidatePath('/tasks')
  revalidatePath('/waiting-ons')
  revalidatePath('/decisions')
  return {}
}

export async function addMeetingCorrection(
  meetingId: string,
  input: { body: string; reason?: string }
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
    return { error: 'You do not have permission to add corrections to this meeting.' }
  }
  if (meeting.status !== 'published') {
    return { error: 'Corrections can only be added to published meetings.' }
  }

  const body = input.body.trim()
  if (!body) return { error: 'Correction text is required.' }

  const serviceClient = createServiceClient()
  const { data: correctionId, error } = await serviceClient.rpc('add_meeting_correction_and_audit', {
    p_meeting_id: meetingId,
    p_body: body,
    p_reason: input.reason?.trim() || null,
    p_actor_user_id: user.id,
  })

  if (error) {
    console.error('[addMeetingCorrection]', error)
    return { error: 'Failed to add correction. Please try again.' }
  }

  revalidatePath(`/meetings/${meetingId}`)
  return { data: { id: correctionId as string } }
}

export async function addMeetingAttendee(
  meetingId: string,
  opts: { userId?: string; externalName?: string; externalEmail?: string }
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: meeting } = await supabase
    .from('meetings')
    .select('id, status, owner_user_id, calendar_event_id')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found.' }
  if (!canEditMeeting(user.role, meeting.owner_user_id, user.id)) {
    return { error: 'You do not have permission to edit this meeting.' }
  }

  const serviceClient = createServiceClient()
  const { data: attendeeId, error } = await serviceClient.rpc('add_meeting_attendee', {
    p_meeting_id: meetingId,
    p_user_id: opts.userId || null,
    p_external_name: opts.externalName || null,
    p_external_email: opts.externalEmail || null,
    p_actor_user_id: user.id,
  })

  if (error) return { error: 'Failed to add attendee.' }

  // Resync Calendar if this meeting already has a linked event (uses stored credential)
  if (meeting.calendar_event_id) {
    await resyncMeetingCalendar(meetingId)
  }

  revalidatePath(`/meetings/${meetingId}`)
  return { data: { id: attendeeId as string } }
}

export async function removeMeetingAttendee(
  meetingId: string,
  attendeeId: string
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: meeting } = await supabase
    .from('meetings')
    .select('id, status, owner_user_id, calendar_event_id')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found.' }
  if (!canEditMeeting(user.role, meeting.owner_user_id, user.id)) {
    return { error: 'You do not have permission to edit this meeting.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('remove_meeting_attendee', {
    p_attendee_id: attendeeId,
    p_meeting_id: meetingId,
    p_actor_user_id: user.id,
  })

  if (error) return { error: 'Failed to remove attendee.' }

  // Resync Calendar if this meeting already has a linked event (uses stored credential)
  if (meeting.calendar_event_id) {
    await resyncMeetingCalendar(meetingId)
  }

  revalidatePath(`/meetings/${meetingId}`)
  return {}
}

export async function reopenMeeting(meetingId: string): Promise<ActionResult> {
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
    return { error: 'You do not have permission to reopen this meeting.' }
  }
  if (meeting.status !== 'cancelled') {
    return { error: 'Only cancelled meetings can be reopened.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('reopen_meeting_and_audit', {
    p_meeting_id: meetingId,
    p_actor_user_id: user.id,
    p_before_status: meeting.status,
  })

  if (error) return { error: 'Failed to reopen meeting.' }

  revalidatePath('/meetings')
  revalidatePath(`/meetings/${meetingId}`)
  revalidatePath('/today')
  return {}
}
