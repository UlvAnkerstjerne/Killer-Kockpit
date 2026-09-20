'use server'

/**
 * lib/actions/recordings.ts
 *
 * Server actions for in-person meeting recording sessions.
 *
 * Architecture
 * ─────────────
 * All writes use createServiceClient() (service role) after explicit
 * application-level authorisation of the current user.
 *
 * The audio lifecycle:
 *   1. Browser calls POST /api/recordings/upload with the audio Blob
 *      → server uploads to Supabase Storage (private bucket)
 *      → creates/updates meeting_recordings row (status: uploaded)
 *      → generates a short-lived signed URL
 *      → submits to AssemblyAI
 *      → updates row (status: transcribing, assemblyai_transcript_id)
 *
 *   2. Webhook POST /api/assemblyai/webhook fires on completion
 *      → retrieves transcript, builds content, stores source, updates meeting
 *
 * This file handles:
 *   createRecordingSession — creates a meeting_recordings row for a session
 *   updateSpeakerMapping   — corrects speaker labels after review; rebuilds transcript
 *   retryTranscription     — resubmits a failed recording (reuses stored audio)
 *   getRecordingsForMeeting — fetches all recordings for a meeting (for display)
 */

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import { canManageTranscript } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import { recordAuditEvent } from '@/lib/audit'
import { submitTranscription } from '@/lib/assemblyai/client'
import { buildTranscript, applyMappingCorrection } from '@/lib/assemblyai/transcript'
import type { ActionResult } from '@/lib/types'
import type { SpeakerMapping } from '@/lib/assemblyai/transcript'
import type { AssemblyAIUtterance } from '@/lib/assemblyai/client'

// ─── Types ─────────────────────────────────────────────────────────────────

export type RecordingStatus =
  | 'recording'
  | 'uploaded'
  | 'transcribing'
  | 'needs_speaker_review'
  | 'complete'
  | 'failed'

export interface MeetingRecording {
  id:                          string
  meeting_id:                  string
  created_by_user_id:          string | null
  status:                      RecordingStatus
  started_at:                  string
  stopped_at:                  string | null
  duration_seconds:            number | null
  storage_path:                string | null
  mime_type:                   string | null
  byte_size:                   number | null
  consent_confirmed_at:        string | null
  consent_confirmed_by_user_id: string | null
  assemblyai_transcript_id:    string | null
  processing_error:            string | null
  speaker_mapping:             SpeakerMapping
  expected_speakers:           string[]
  transcript_source_id:        string | null
  created_at:                  string
  updated_at:                  string
}

// ─── getMeetingContext helper ──────────────────────────────────────────────

async function getMeetingContext(meetingId: string) {
  const db = createServiceClient()
  const { data } = await db
    .from('meetings')
    .select('owner_user_id, status, transcript_source_id')
    .eq('id', meetingId)
    .single()
  return {
    ownerUserId:        data?.owner_user_id as string | null ?? null,
    status:             data?.status as string | null ?? null,
    transcriptSourceId: data?.transcript_source_id as string | null ?? null,
  }
}

// ─── createRecordingSession ────────────────────────────────────────────────

/**
 * Creates a meeting_recordings row for a new session.
 * Called from the recorder UI when recording starts.
 * Returns the new recording ID so the client can track it.
 */
export async function createRecordingSession(
  meetingId: string,
  opts: {
    consentConfirmedAt:    string   // ISO timestamp from the browser
    expectedSpeakers:      string[] // confirmed attendee display names
  },
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const { ownerUserId, status } = await getMeetingContext(meetingId)

  if (!canManageTranscript(user.role, ownerUserId, user.id, status)) {
    return { error: 'You do not have permission to record this meeting.' }
  }

  const db = createServiceClient()

  const { data: row, error } = await db
    .from('meeting_recordings')
    .insert({
      meeting_id:                   meetingId,
      created_by_user_id:           user.id,
      status:                       'recording',
      started_at:                   new Date().toISOString(),
      consent_confirmed_at:         opts.consentConfirmedAt,
      consent_confirmed_by_user_id: user.id,
      expected_speakers:            opts.expectedSpeakers,
    })
    .select('id')
    .single()

  if (error || !row) {
    console.error('[recordings] createRecordingSession failed:', error?.message)
    return { error: 'Failed to start recording session.' }
  }

  await recordAuditEvent({
    actorUserId: user.id,
    action:      'recording.started',
    entityType:  'meeting',
    entityId:    meetingId,
    afterJson:   { recording_id: row.id, expected_speakers: opts.expectedSpeakers },
  })

  return { data: { id: row.id } }
}

// ─── updateSpeakerMapping ──────────────────────────────────────────────────

/**
 * Applies corrected speaker label → name mappings after the review screen.
 * Rebuilds the transcript content and updates the source row.
 * Updates the meeting_recordings row and the transcript source metadata.
 */
export async function updateSpeakerMapping(
  recordingId:       string,
  correctedMapping:  SpeakerMapping,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const db = createServiceClient()

  // Load the recording row
  const { data: recording, error: recErr } = await db
    .from('meeting_recordings')
    .select('id, meeting_id, status, transcript_source_id, speaker_mapping')
    .eq('id', recordingId)
    .single()

  if (recErr || !recording) return { error: 'Recording not found.' }

  const { ownerUserId, status: meetingStatus } = await getMeetingContext(recording.meeting_id as string)

  if (!canManageTranscript(user.role, ownerUserId, user.id, meetingStatus)) {
    return { error: 'You do not have permission to edit this recording.' }
  }

  if (!recording.transcript_source_id) {
    return { error: 'No transcript is attached to this recording yet.' }
  }

  // Load the raw utterances from the source metadata
  const { data: source, error: srcErr } = await db
    .from('sources')
    .select('metadata')
    .eq('id', recording.transcript_source_id)
    .single()

  if (srcErr || !source) return { error: 'Transcript source not found.' }

  const metadata = source.metadata as Record<string, unknown>
  const utterances = (metadata.utterances as AssemblyAIUtterance[] | null) ?? []

  if (utterances.length === 0) {
    return { error: 'No utterance data available for speaker correction.' }
  }

  // Rebuild transcript with corrected mapping
  const { content, speakerMapping, hasUnmappedSpeakers, wordCount } =
    applyMappingCorrection(utterances, correctedMapping)

  // Update source content + metadata
  const updatedMetadata = {
    ...metadata,
    speaker_mapping:  correctedMapping,
    word_count:       wordCount,
    speaker_count:    Object.keys(correctedMapping).length,
    has_unmapped_speakers: hasUnmappedSpeakers,
  }

  const { error: updateSrcErr } = await db
    .from('sources')
    .update({ content: content, metadata: updatedMetadata })
    .eq('id', recording.transcript_source_id)

  if (updateSrcErr) {
    console.error('[recordings] updateSpeakerMapping source update failed:', updateSrcErr.message)
    return { error: 'Failed to update transcript.' }
  }

  // Update recording row — new status if all speakers are now mapped
  const newStatus: RecordingStatus = hasUnmappedSpeakers ? 'needs_speaker_review' : 'complete'

  await db
    .from('meeting_recordings')
    .update({ speaker_mapping: correctedMapping, status: newStatus })
    .eq('id', recordingId)

  await recordAuditEvent({
    actorUserId: user.id,
    action:      'recording.speaker_mapping_corrected',
    entityType:  'meeting',
    entityId:    recording.meeting_id as string,
    afterJson:   { recording_id: recordingId, mapping: correctedMapping },
  })

  revalidatePath(`/meetings/${recording.meeting_id}`)
  return {}
}

// ─── retryTranscription ────────────────────────────────────────────────────

/**
 * Resubmits a failed recording to AssemblyAI without re-recording.
 * Reuses the stored audio file in Supabase Storage.
 * Does NOT create a new meeting_recordings row.
 */
export async function retryTranscription(
  recordingId: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const db = createServiceClient()

  const { data: recording, error: recErr } = await db
    .from('meeting_recordings')
    .select('id, meeting_id, status, storage_path, mime_type, expected_speakers')
    .eq('id', recordingId)
    .single()

  if (recErr || !recording) return { error: 'Recording not found.' }

  if (recording.status !== 'failed') {
    return { error: 'Only failed recordings can be retried.' }
  }

  const { ownerUserId, status: meetingStatus } = await getMeetingContext(recording.meeting_id as string)

  if (!canManageTranscript(user.role, ownerUserId, user.id, meetingStatus)) {
    return { error: 'You do not have permission to retry this transcription.' }
  }

  if (!recording.storage_path) {
    return { error: 'No audio file found for this recording.' }
  }

  // Generate a fresh signed URL for the stored audio
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey  = process.env.SUPABASE_SECRET_KEY!

  const signedUrlRes = await fetch(
    `${supabaseUrl}/storage/v1/object/sign/meeting-recordings/${encodeURIComponent(recording.storage_path as string)}`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    },
  )

  if (!signedUrlRes.ok) {
    return { error: 'Failed to generate audio URL for retry.' }
  }

  const { signedURL } = await signedUrlRes.json() as { signedURL: string }
  const audioUrl = `${supabaseUrl}/storage/v1${signedURL}`

  // Re-submit to AssemblyAI
  const webhookSecret = process.env.ASSEMBLYAI_WEBHOOK_SECRET
  if (!webhookSecret) {
    return { error: 'Webhook secret not configured.' }
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    return { error: 'App URL not configured.' }
  }

  const speakerNames = (recording.expected_speakers as string[]) ?? []

  let submitResult
  try {
    submitResult = await submitTranscription({
      audioUrl,
      speakerNames,
      speakerCount:   speakerNames.length > 0 ? speakerNames.length : null,
      languageConfig: { mode: 'detect' },  // use detection on retry for safety
      webhookUrl:     `${appUrl}/api/assemblyai/webhook`,
      webhookSecret,
    })
  } catch (err) {
    const msg = (err as Error).message
    console.error('[recordings] retryTranscription submit failed:', msg)
    await db
      .from('meeting_recordings')
      .update({ status: 'failed', processing_error: msg })
      .eq('id', recordingId)
    return { error: 'Failed to submit transcription. Please try again.' }
  }

  await db
    .from('meeting_recordings')
    .update({
      status:                   'transcribing',
      assemblyai_transcript_id: submitResult.transcriptId,
      processing_error:         null,
    })
    .eq('id', recordingId)

  await recordAuditEvent({
    actorUserId: user.id,
    action:      'recording.transcription_retried',
    entityType:  'meeting',
    entityId:    recording.meeting_id as string,
    afterJson:   { recording_id: recordingId, transcript_id: submitResult.transcriptId },
  })

  revalidatePath(`/meetings/${recording.meeting_id}`)
  return {}
}

// ─── getRecordingsForMeeting ───────────────────────────────────────────────

/**
 * Returns all recordings for a meeting, ordered newest first.
 * Used by the meeting detail page to show recording status.
 */
export async function getRecordingsForMeeting(
  meetingId: string,
): Promise<ActionResult<MeetingRecording[]>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const db = createServiceClient()

  const { data, error } = await db
    .from('meeting_recordings')
    .select('*')
    .eq('meeting_id', meetingId)
    .order('created_at', { ascending: false })

  if (error) {
    return { error: 'Failed to load recordings.' }
  }

  return { data: (data ?? []) as MeetingRecording[] }
}
