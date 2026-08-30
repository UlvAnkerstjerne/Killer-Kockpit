'use server'

/**
 * lib/actions/transcripts.ts
 *
 * Server actions for meeting transcript ingestion (Phase M5A).
 *
 * Capabilities
 * ─────────────
 *   addTranscript     — upload a new transcript to a meeting that has none
 *   replaceTranscript — swap the current transcript for a new one
 *   removeTranscript  — clear the transcript reference (source row preserved)
 *   getTranscriptSource — read the current transcript metadata for display
 *
 * Architecture
 * ─────────────
 * • Transcript sources are GLOBAL (source_account_user_id IS NULL), like
 *   Drive files.  The content belongs to the meeting, not to the uploader's
 *   personal Google account.
 * • sources.content stores the raw verbatim bytes of the uploaded file.
 *   Normalisation (stripping timestamps etc.) happens at AI generation time
 *   (Phase M5B); this action never transforms the content.
 * • entity_sources with relation = 'transcript' links every historical
 *   transcript source to the meeting, creating an immutable provenance trail.
 *   meetings.transcript_source_id always points to the current transcript.
 * • Replacing a transcript creates a NEW sources row + entity_sources link.
 *   The old sources row and its entity_sources row are preserved — never
 *   deleted.  Only meetings.transcript_source_id is updated.
 * • Removing a transcript clears meetings.transcript_source_id only.
 *   The entity_sources relationship is preserved for provenance.
 *
 * Supported formats: .vtt, .srt, .txt, .md, or manual paste (no file)
 * Max size: 5 MB (enforced here, not just in the UI)
 *
 * Security: sources is SUPER_ADMIN only in RLS. All writes use
 * createServiceClient() (service role). Content is never returned to
 * the browser — only metadata (fileName, format, attachedAt) is exposed.
 */

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import { canManageTranscript, canReadTranscript } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import { recordAuditEvent } from '@/lib/audit'
import { getGoogleOAuth2Client, hasMeetScope } from '@/lib/google/auth'
import { fetchGoogleMeetTranscript } from '@/lib/google/transcripts'
import type { ActionResult } from '@/lib/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const ALLOWED_EXTENSIONS = new Set(['vtt', 'srt', 'txt', 'md'])

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TranscriptSource {
  sourceId:    string
  fileName:    string | null  // null for paste and Google Meet transcripts
  format:      string         // 'vtt' | 'srt' | 'txt' | 'md' | 'text' | 'google_meet'
  provider:    'file_upload' | 'manual_paste' | 'google_meet'
  attachedAt:  string         // ISO timestamp from entity_sources.created_at
  byteSize:    number | null
  charCount:   number | null  // character count of the raw content
  wordCount:   number | null  // populated for Google Meet transcripts
  speakerCount: number | null // populated for Google Meet transcripts
  languageCode: string | null // populated for Google Meet transcripts
}

// ─── Google Meet check result ──────────────────────────────────────────────────

export type GoogleTranscriptCheckResult =
  | { status: 'attached';      source: TranscriptSource }
  | { status: 'already_attached' }
  | { status: 'conflict';      existingSource: TranscriptSource }
  | { status: 'processing' }
  | { status: 'not_found';     reason: string }
  | { status: 'ambiguous' }

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function getMeetingContext(meetingId: string): Promise<{
  ownerUserId: string | null
  status: string | null
  transcriptSourceId: string | null
}> {
  const db = createServiceClient()
  const { data } = await db
    .from('meetings')
    .select('owner_user_id, status, transcript_source_id')
    .eq('id', meetingId)
    .single()
  return {
    ownerUserId:        data?.owner_user_id ?? null,
    status:             data?.status ?? null,
    transcriptSourceId: data?.transcript_source_id ?? null,
  }
}

function getExtension(fileName: string | null): string {
  if (!fileName) return ''
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

// ─── getTranscriptSource ──────────────────────────────────────────────────────

/**
 * Returns metadata for the meeting's current transcript, or null if none.
 * Content is never returned.
 */
export async function getTranscriptSource(
  meetingId: string,
): Promise<TranscriptSource | null> {
  const db = createServiceClient()

  const { data: meeting } = await db
    .from('meetings')
    .select('transcript_source_id')
    .eq('id', meetingId)
    .single()

  const sourceId = meeting?.transcript_source_id
  if (!sourceId) return null

  // Fetch the source row (metadata only — no content column selected)
  const { data: source } = await db
    .from('sources')
    .select('id, file_name, metadata, created_at')
    .eq('id', sourceId)
    .single()

  if (!source) return null

  const meta = (source.metadata ?? {}) as Record<string, unknown>

  // Fetch the entity_sources row to get the attachedAt timestamp for this link
  const { data: link } = await db
    .from('entity_sources')
    .select('created_at')
    .eq('entity_type', 'meeting')
    .eq('entity_id', meetingId)
    .eq('source_id', sourceId)
    .eq('relation', 'transcript')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  // file_name is null for manual-paste and Google Meet transcripts
  const fileName = source.file_name ?? null
  const provider = (meta.provider as 'file_upload' | 'manual_paste' | 'google_meet' | undefined)
    ?? 'file_upload'
  // format stored in metadata is authoritative; fall back to extension or provider
  const format =
    provider === 'google_meet'
      ? 'google_meet'
      : (meta.format as string | undefined) ?? getExtension(fileName) ?? 'text'

  return {
    sourceId:    source.id,
    fileName,
    format,
    provider,
    attachedAt:  link?.created_at ?? source.created_at,
    byteSize:    (meta.byte_size    as number | null)  ?? null,
    charCount:   (meta.char_count   as number | null)  ?? null,
    wordCount:   (meta.word_count   as number | null)  ?? null,
    speakerCount:(meta.speaker_count as number | null) ?? null,
    languageCode:(meta.language_code as string | null) ?? null,
  }
}

// ─── addTranscript ────────────────────────────────────────────────────────────

/**
 * Attaches a new transcript to a meeting that currently has none.
 *
 * Accepts raw text content and an optional file name.
 * Pass fileName = null for manual paste (no file).
 * The caller (UI or API route) is responsible for reading the file
 * into a string before calling this action.
 *
 * Errors if the meeting already has a transcript — use replaceTranscript.
 */
export async function addTranscript(
  meetingId: string,
  fileName: string | null,
  content: string,
): Promise<ActionResult<TranscriptSource>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const { ownerUserId, status, transcriptSourceId } = await getMeetingContext(meetingId)

  if (!canManageTranscript(user.role, ownerUserId, user.id, status)) {
    return { error: 'You do not have permission to add a transcript to this meeting.' }
  }

  if (transcriptSourceId) {
    return { error: 'This meeting already has a transcript. Use replace to swap it.' }
  }

  const validation = validateTranscript(fileName, content)
  if (validation) return { error: validation }

  return insertTranscript(meetingId, fileName, content, user.id, null)
}

// ─── replaceTranscript ────────────────────────────────────────────────────────

/**
 * Replaces the current transcript with a new one.
 *
 * Creates a new sources row; old row is preserved in entity_sources for
 * provenance. meetings.transcript_source_id is updated to the new source.
 * Pass fileName = null for manual paste (no file).
 */
export async function replaceTranscript(
  meetingId: string,
  fileName: string | null,
  content: string,
): Promise<ActionResult<TranscriptSource>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const { ownerUserId, status, transcriptSourceId } = await getMeetingContext(meetingId)

  if (!canManageTranscript(user.role, ownerUserId, user.id, status)) {
    return { error: 'You do not have permission to replace the transcript for this meeting.' }
  }

  const validation = validateTranscript(fileName, content)
  if (validation) return { error: validation }

  return insertTranscript(meetingId, fileName, content, user.id, transcriptSourceId)
}

// ─── removeTranscript ─────────────────────────────────────────────────────────

/**
 * Clears the meeting's transcript reference.
 *
 * meetings.transcript_source_id is set to NULL.
 * The sources row and entity_sources relationship are preserved.
 */
export async function removeTranscript(
  meetingId: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const { ownerUserId, status, transcriptSourceId } = await getMeetingContext(meetingId)

  if (!canManageTranscript(user.role, ownerUserId, user.id, status)) {
    return { error: 'You do not have permission to remove the transcript from this meeting.' }
  }

  if (!transcriptSourceId) {
    return { error: 'This meeting has no transcript to remove.' }
  }

  const db = createServiceClient()

  // Fetch source metadata for audit before clearing
  const { data: source } = await db
    .from('sources')
    .select('file_name, metadata')
    .eq('id', transcriptSourceId)
    .single()

  const { error: updateErr } = await db
    .from('meetings')
    .update({ transcript_source_id: null })
    .eq('id', meetingId)

  if (updateErr) {
    console.error('[transcripts] Failed to clear transcript_source_id:', updateErr.message)
    return { error: 'Failed to remove transcript. Please try again.' }
  }

  const meta = (source?.metadata ?? {}) as Record<string, unknown>
  // file_name may be null for paste-sourced transcripts
  const fileName = source?.file_name ?? (meta.file_name as string | null | undefined) ?? null

  await recordAuditEvent({
    actorUserId: user.id,
    action:      'transcript_removed',
    entityType:  'meeting',
    entityId:    meetingId,
    beforeJson: {
      source_id: transcriptSourceId,
      file_name: fileName,
      provider:  (meta.provider as string | undefined) ?? 'file_upload',
    },
  })

  revalidatePath(`/meetings/${meetingId}`)

  return {}
}

// ─── Shared insert logic ──────────────────────────────────────────────────────

interface TranscriptInsertOptions {
  /** Stable external identifier — used for idempotency (e.g. Google transcript resource name). */
  externalId?:    string
  /** Override the default title derived from fileName. */
  title?:         string
  /** Override the default occurred_at (ISO timestamp). */
  occurredAt?:    string
  /** Provider — defaults to 'file_upload' or 'manual_paste' based on fileName. */
  provider?:      'file_upload' | 'manual_paste' | 'google_meet'
  /** Additional metadata fields merged into the sources.metadata jsonb. */
  extraMetadata?: Record<string, unknown>
}

async function insertTranscript(
  meetingId: string,
  fileName: string | null,
  content: string,
  actorUserId: string,
  previousSourceId: string | null,
  options?: TranscriptInsertOptions,
): Promise<ActionResult<TranscriptSource>> {
  const db = createServiceClient()

  const isPaste   = fileName === null
  const provider  = options?.provider ?? (isPaste ? 'manual_paste' : 'file_upload')
  const format    =
    provider === 'google_meet' ? 'google_meet' :
    isPaste                    ? 'text'         :
    (getExtension(fileName) || 'text')
  const byteSize  = Buffer.byteLength(content, 'utf8')
  const charCount = content.length
  const title     = options?.title ?? (fileName ?? 'Pasted transcript')

  // Insert new sources row with raw content
  const { data: newSource, error: insertErr } = await db
    .from('sources')
    .insert({
      source_type:            'meeting_transcript',
      source_account_user_id: null,
      external_id:            options?.externalId ?? null,
      title,
      file_name:              fileName,
      url:                    null,
      occurred_at:            options?.occurredAt ?? new Date().toISOString(),
      content,
      metadata: {
        format,
        provider,
        byte_size:  byteSize,
        char_count: charCount,
        ...(fileName ? { file_name: fileName } : {}),
        ...(options?.extraMetadata ?? {}),
      },
    })
    .select('id, created_at')
    .single()

  if (insertErr || !newSource) {
    console.error('[transcripts] Failed to insert source:', insertErr?.message)
    return { error: 'Failed to store transcript. Please try again.' }
  }

  // Insert entity_sources link (preserves provenance even after replacement)
  const { error: linkErr } = await db
    .from('entity_sources')
    .insert({
      entity_type: 'meeting',
      entity_id:   meetingId,
      source_id:   newSource.id,
      relation:    'transcript',
    })

  if (linkErr) {
    console.error('[transcripts] Failed to insert entity_source:', linkErr.message)
    return { error: 'Failed to link transcript to meeting. Please try again.' }
  }

  // Update meetings.transcript_source_id
  const { error: updateErr } = await db
    .from('meetings')
    .update({ transcript_source_id: newSource.id })
    .eq('id', meetingId)

  if (updateErr) {
    console.error('[transcripts] Failed to update transcript_source_id:', updateErr.message)
    return { error: 'Failed to update meeting transcript reference. Please try again.' }
  }

  const action = previousSourceId ? 'transcript_replaced' : 'transcript_attached'

  await recordAuditEvent({
    actorUserId,
    action,
    entityType: 'meeting',
    entityId:   meetingId,
    beforeJson: previousSourceId ? { source_id: previousSourceId } : null,
    afterJson: {
      source_id:   newSource.id,
      file_name:   fileName,
      format,
      provider,
      byte_size:   byteSize,
      external_id: options?.externalId ?? null,
    },
  })

  revalidatePath(`/meetings/${meetingId}`)

  const meta = options?.extraMetadata ?? {}
  return {
    data: {
      sourceId:    newSource.id,
      fileName,
      format,
      provider,
      attachedAt:  newSource.created_at,
      byteSize,
      charCount,
      wordCount:    (meta.word_count    as number | null) ?? null,
      speakerCount: (meta.speaker_count as number | null) ?? null,
      languageCode: (meta.language_code as string | null) ?? null,
    },
  }
}

// ─── getTranscriptContent ─────────────────────────────────────────────────────

/**
 * Returns the raw content of the meeting's current transcript.
 *
 * Separate from getTranscriptSource which returns only metadata — content is
 * only fetched on demand when the user explicitly requests to view it.
 *
 * Permission: canReadTranscript (SUPER_ADMIN, UM, meeting owner).
 * No status gate — published-meeting transcripts remain readable.
 *
 * Content is returned to the caller as a plain string; it is the caller's
 * responsibility not to render it as HTML (use whitespace-pre-wrap or similar).
 */
export async function getTranscriptContent(
  meetingId: string,
): Promise<{ content: string } | { error: string }> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const db = createServiceClient()

  const { data: meeting } = await db
    .from('meetings')
    .select('owner_user_id, transcript_source_id')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found.' }

  // Fast path: SUPER_ADMIN / UM / owner short-circuit without a DB round-trip.
  // MEMBER case: check meeting_attendees to honour the same visibility rule as
  // the rest of the meeting (attending members may view the transcript).
  if (!canReadTranscript(user.role, meeting.owner_user_id, user.id)) {
    const { data: attendeeRow } = await db
      .from('meeting_attendees')
      .select('id')
      .eq('meeting_id', meetingId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!canReadTranscript(user.role, meeting.owner_user_id, user.id, attendeeRow !== null)) {
      return { error: 'You do not have permission to view this transcript.' }
    }
  }

  if (!meeting.transcript_source_id) {
    return { error: 'No transcript is attached to this meeting.' }
  }

  // Select content column — service role bypasses RLS; content is never
  // sent to the browser except through this explicitly-permissioned path.
  const { data: source } = await db
    .from('sources')
    .select('content')
    .eq('id', meeting.transcript_source_id)
    .single()

  if (!source?.content) return { error: 'Transcript content is unavailable.' }

  return { content: source.content }
}

// ─── checkGoogleMeetTranscript ────────────────────────────────────────────────

/**
 * Retrieves the Google Meet transcript for a meeting and stores it through
 * the M5A sources architecture.
 *
 * Idempotency: sources.external_id uniquely identifies the Google transcript
 * resource.  Repeated calls with the same transcript return 'already_attached'
 * rather than creating duplicate rows.
 *
 * Conflict: if a DIFFERENT transcript is already current and replaceExisting
 * is false, returns 'conflict' so the UI can prompt the user to confirm.
 * Pass replaceExisting = true to proceed with the replacement.
 *
 * Credential routing: prefers the credential stored in calendar_synced_by_user_id
 * (the user who created the Calendar event / Meet conference) and falls back to
 * the requesting user's credential.
 *
 * Permission: same as canManageTranscript (owner, UM, SUPER_ADMIN on non-sealed meeting).
 */
export async function checkGoogleMeetTranscript(
  meetingId: string,
  replaceExisting = false,
): Promise<{ result: GoogleTranscriptCheckResult } | { error: string }> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const db = createServiceClient()

  // Read all required meeting fields in one query
  const { data: meetingRow } = await db
    .from('meetings')
    .select('owner_user_id, status, transcript_source_id, meet_space_name, calendar_synced_by_user_id, scheduled_start, scheduled_end')
    .eq('id', meetingId)
    .single()

  if (!meetingRow) return { error: 'Meeting not found.' }

  if (!canManageTranscript(user.role, meetingRow.owner_user_id as string | null, user.id, meetingRow.status as string | null)) {
    return { error: 'You do not have permission to manage transcripts for this meeting.' }
  }

  const meetSpaceName = meetingRow.meet_space_name as string | null
  if (!meetSpaceName) {
    return {
      error:
        'This meeting has no Google Meet conference. ' +
        'Enable Google Meet in Settings and sync to Calendar first.',
    }
  }

  // ── Credential routing ────────────────────────────────────────────────────
  // Prefer calendar_synced_by_user_id — that credential created the Meet space.
  // Fall back to the requesting user.

  const preferredUserId = (meetingRow.calendar_synced_by_user_id as string | null) ?? user.id
  let oauthClient = await getGoogleOAuth2Client(preferredUserId)

  if (!oauthClient && preferredUserId !== user.id) {
    oauthClient = await getGoogleOAuth2Client(user.id)
  }

  if (!oauthClient) {
    return {
      error:
        'Google is not connected. Please connect in Settings → Google Workspace.',
    }
  }

  const scopeString = typeof oauthClient.credentials.scope === 'string'
    ? oauthClient.credentials.scope
    : ''
  if (!hasMeetScope(scopeString.split(' ').filter(Boolean))) {
    return {
      error:
        'Google Meet is not authorised. Enable Google Meet in Settings → Google Workspace.',
    }
  }

  // ── Fetch transcript from Google Meet API ─────────────────────────────────
  const fetchResult = await fetchGoogleMeetTranscript(oauthClient, meetSpaceName, {
    scheduled_start: meetingRow.scheduled_start as string | null,
    scheduled_end:   meetingRow.scheduled_end   as string | null,
  })

  if (!fetchResult.ok) {
    switch (fetchResult.status) {
      case 'processing':
        return { result: { status: 'processing' } }
      case 'not_found':
        return { result: { status: 'not_found', reason: fetchResult.reason } }
      case 'ambiguous':
        return { result: { status: 'ambiguous' } }
      case 'error':
        return { error: fetchResult.error }
    }
  }

  const {
    transcriptResourceName,
    conferenceRecordStart,
    content,
    metadata,
  } = fetchResult

  const currentTranscriptId = meetingRow.transcript_source_id as string | null

  // ── Idempotency: check if this exact Google transcript already exists ──────
  const { data: existingGoogleSource } = await db
    .from('sources')
    .select('id')
    .eq('source_type', 'meeting_transcript')
    .eq('external_id', transcriptResourceName)
    .maybeSingle()

  if (existingGoogleSource) {
    if (existingGoogleSource.id === currentTranscriptId) {
      // Already attached and is the current transcript — no-op
      return { result: { status: 'already_attached' } }
    }

    // Source exists but is not the current transcript.
    // If a DIFFERENT transcript is currently attached and user hasn't confirmed replace → conflict.
    if (currentTranscriptId && existingGoogleSource.id !== currentTranscriptId && !replaceExisting) {
      const existingSource = await getTranscriptSource(meetingId)
      if (existingSource) {
        return { result: { status: 'conflict', existingSource } }
      }
    }

    // Re-link: the Google transcript source already exists — just update the pointer.
    // entity_sources may already have the link from a prior run; skip if so.
    const { data: existingLink } = await db
      .from('entity_sources')
      .select('id')
      .eq('entity_type', 'meeting')
      .eq('entity_id', meetingId)
      .eq('source_id', existingGoogleSource.id)
      .eq('relation', 'transcript')
      .maybeSingle()

    if (!existingLink) {
      await db.from('entity_sources').insert({
        entity_type: 'meeting',
        entity_id:   meetingId,
        source_id:   existingGoogleSource.id,
        relation:    'transcript',
      })
    }

    await db
      .from('meetings')
      .update({ transcript_source_id: existingGoogleSource.id })
      .eq('id', meetingId)

    const auditAction = currentTranscriptId
      ? 'transcript_replaced'
      : 'transcript_attached'

    await recordAuditEvent({
      actorUserId: user.id,
      action:      auditAction,
      entityType:  'meeting',
      entityId:    meetingId,
      beforeJson:  currentTranscriptId ? { source_id: currentTranscriptId } : null,
      afterJson: {
        source_id:    existingGoogleSource.id,
        provider:     'google_meet',
        external_id:  transcriptResourceName,
        meet_space:   meetSpaceName,
      },
    })

    revalidatePath(`/meetings/${meetingId}`)

    const source = await getTranscriptSource(meetingId)
    if (!source) return { error: 'Transcript attached but metadata could not be read.' }
    return { result: { status: 'attached', source } }
  }

  // ── No existing source — check for conflict with manual transcript ─────────
  if (currentTranscriptId && !replaceExisting) {
    const existingSource = await getTranscriptSource(meetingId)
    if (existingSource) {
      return { result: { status: 'conflict', existingSource } }
    }
  }

  // ── Insert new Google Meet transcript through M5A insertTranscript ─────────
  const insertResult = await insertTranscript(
    meetingId,
    null,                 // no file
    content,
    user.id,
    currentTranscriptId,  // null for new attach, prior source id for replace
    {
      externalId:    transcriptResourceName,
      title:         'Google Meet transcript',
      occurredAt:    conferenceRecordStart ?? new Date().toISOString(),
      provider:      'google_meet',
      extraMetadata: metadata as unknown as Record<string, unknown>,
    },
  )

  if (insertResult.error) return { error: insertResult.error }

  return { result: { status: 'attached', source: insertResult.data! } }
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** Returns an error string or null if valid. */
function validateTranscript(fileName: string | null, content: string): string | null {
  // File upload: validate extension
  if (fileName !== null) {
    const ext = getExtension(fileName)
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return `Unsupported file type ".${ext}". Please upload a .vtt, .srt, .md, or .txt file.`
    }
  }

  const byteSize = Buffer.byteLength(content, 'utf8')
  if (byteSize > MAX_BYTES) {
    const mb = (byteSize / 1024 / 1024).toFixed(1)
    return `Transcript is too large (${mb} MB). Maximum size is 5 MB.`
  }

  if (content.trim().length === 0) {
    return 'Transcript content is empty.'
  }

  return null
}
