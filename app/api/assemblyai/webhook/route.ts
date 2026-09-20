/**
 * POST /api/assemblyai/webhook
 *
 * Receives AssemblyAI completion notifications for in-person recording
 * transcriptions.
 *
 * Security
 * ────────
 * Each transcription submission includes:
 *   webhook_auth_header_name:  "x-assemblyai-webhook-secret"
 *   webhook_auth_header_value: <ASSEMBLYAI_WEBHOOK_SECRET>
 *
 * Requests without the correct header value are rejected 401.
 * We do NOT use CRON_SECRET for this endpoint.
 *
 * Idempotency
 * ───────────
 * AssemblyAI may deliver the same webhook multiple times.
 * We guard with:
 *   1. The unique index on meeting_recordings.assemblyai_transcript_id ensures
 *      we always resolve to the same row.
 *   2. A completed/failed recording row is not re-processed.
 *   3. sources.external_id = transcript_id has a partial unique constraint,
 *      preventing duplicate source insertion.
 *
 * Payload
 * ───────
 * AssemblyAI sends: { transcript_id: string, status: "completed" | "error" }
 * We must fetch the full transcript separately to get utterances.
 *
 * Transcript storage
 * ──────────────────
 * Uses the existing sources / entity_sources / meetings.transcript_source_id
 * architecture — same as Google Meet and file-upload paths:
 *   • source_type = 'meeting_transcript'
 *   • external_id = assemblyai transcript ID (stable, for idempotency)
 *   • provider = 'assemblyai' in metadata
 *   • content = formatted speaker-attributed transcript string
 *   • Raw utterances preserved in metadata for speaker review / reprocessing
 *
 * Conflict with existing transcript
 * ──────────────────────────────────
 * If meetings.transcript_source_id is already set (e.g. a Google Meet
 * transcript was attached), we do NOT silently overwrite it.  Instead, we:
 *   1. Store the source and entity_sources link normally (for provenance).
 *   2. Set meeting_recordings.transcript_source_id.
 *   3. Leave meetings.transcript_source_id pointing to the existing transcript.
 *   4. Mark the recording as 'needs_speaker_review' or 'complete' so the UI
 *      can surface the conflict and let the owner decide.
 *
 * Response
 * ────────
 * 200 — always returned on successful processing (AssemblyAI stops retrying)
 * 401 — invalid webhook secret (AssemblyAI will retry)
 * 500 — unexpected error (AssemblyAI will retry)
 */

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getTranscript } from '@/lib/assemblyai/client'
import { buildTranscript } from '@/lib/assemblyai/transcript'

export async function POST(request: NextRequest) {
  // ── Authenticate webhook ──────────────────────────────────────────────────
  const webhookSecret = process.env.ASSEMBLYAI_WEBHOOK_SECRET
  if (!webhookSecret) {
    console.error('[webhook/assemblyai] ASSEMBLYAI_WEBHOOK_SECRET not configured')
    return NextResponse.json({ error: 'Misconfigured.' }, { status: 500 })
  }

  const providedSecret = request.headers.get('x-assemblyai-webhook-secret')
  if (!providedSecret || providedSecret !== webhookSecret) {
    console.warn('[webhook/assemblyai] Rejected request with invalid secret')
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
  }

  // ── Parse payload ─────────────────────────────────────────────────────────
  let payload: { transcript_id?: string; status?: string }
  try {
    payload = await request.json() as { transcript_id?: string; status?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const { transcript_id: transcriptId, status: webhookStatus } = payload

  if (!transcriptId) {
    console.warn('[webhook/assemblyai] Payload missing transcript_id')
    return NextResponse.json({ ok: true })
  }

  console.log(`[webhook/assemblyai] Received: ${transcriptId} status=${webhookStatus}`)

  const db = createServiceClient()

  // ── Resolve meeting_recordings row ────────────────────────────────────────
  const { data: recording, error: recErr } = await db
    .from('meeting_recordings')
    .select('id, meeting_id, status, speaker_mapping, expected_speakers, transcript_source_id')
    .eq('assemblyai_transcript_id', transcriptId)
    .maybeSingle()

  if (recErr) {
    console.error('[webhook/assemblyai] DB lookup error:', recErr.message)
    return NextResponse.json({ error: 'DB error.' }, { status: 500 })
  }

  if (!recording) {
    // Unknown transcript ID — not ours or already cleaned up. Accept and ignore.
    console.warn('[webhook/assemblyai] No recording row for transcript_id:', transcriptId)
    return NextResponse.json({ ok: true })
  }

  // Idempotency: already processed
  if (recording.status === 'complete' || recording.status === 'failed') {
    console.log('[webhook/assemblyai] Already processed, skipping:', recording.id)
    return NextResponse.json({ ok: true })
  }

  // ── Handle error status ───────────────────────────────────────────────────
  if (webhookStatus === 'error') {
    await db
      .from('meeting_recordings')
      .update({ status: 'failed', processing_error: 'AssemblyAI transcription failed.' })
      .eq('id', recording.id)

    await db.from('audit_events').insert({
      actor_user_id: null,
      actor_type:    'system',
      action:        'recording.transcription_failed',
      entity_type:   'meeting',
      entity_id:     recording.meeting_id,
      after_json:    { recording_id: recording.id, transcript_id: transcriptId },
    })

    return NextResponse.json({ ok: true })
  }

  // ── Fetch full transcript from AssemblyAI ─────────────────────────────────
  let aaiTranscript
  try {
    aaiTranscript = await getTranscript(transcriptId)
  } catch (err) {
    const msg = (err as Error).message
    console.error('[webhook/assemblyai] Failed to fetch transcript:', msg)
    await db
      .from('meeting_recordings')
      .update({ status: 'failed', processing_error: `Failed to retrieve transcript: ${msg}` })
      .eq('id', recording.id)
    return NextResponse.json({ error: 'Fetch failed.' }, { status: 500 })
  }

  if (aaiTranscript.status !== 'completed') {
    console.warn('[webhook/assemblyai] Unexpected transcript status:', aaiTranscript.status)
    return NextResponse.json({ ok: true })
  }

  const utterances = aaiTranscript.utterances ?? []

  // ── Build speaker-attributed transcript ───────────────────────────────────
  const speakerMapping = (recording.speaker_mapping as Record<string, string>) ?? {}
  const { content, speakerMapping: resolvedMapping, hasUnmappedSpeakers, wordCount, speakerCount } =
    buildTranscript(utterances, speakerMapping)

  // ── Idempotency: check for existing source with this external_id ──────────
  const { data: existingSource } = await db
    .from('sources')
    .select('id')
    .eq('source_type', 'meeting_transcript')
    .eq('external_id', transcriptId)
    .maybeSingle()

  let sourceId: string

  if (existingSource) {
    // Idempotency path: source already exists (prior webhook delivery)
    sourceId = existingSource.id as string
    console.log('[webhook/assemblyai] Source already exists, repairing links:', sourceId)
  } else {
    // Insert new source
    const byteSize = Buffer.byteLength(content, 'utf8')

    const metadata = {
      provider:           'assemblyai',
      format:             'assemblyai_diarized',
      assemblyai_id:      transcriptId,
      speech_model_used:  aaiTranscript.speech_model ?? null,   // actual model used
      language_code:      aaiTranscript.language_code ?? null,
      audio_duration:     aaiTranscript.audio_duration ?? null,
      speaker_count:      speakerCount,
      word_count:         wordCount,
      expected_speakers:  recording.expected_speakers ?? [],
      speaker_mapping:    resolvedMapping,
      has_unmapped_speakers: hasUnmappedSpeakers,
      processed_at:       new Date().toISOString(),
      byte_size:          byteSize,
      // Preserve raw utterances for speaker review and reprocessing
      utterances:         utterances,
    }

    const { data: newSource, error: insertErr } = await db
      .from('sources')
      .insert({
        source_type: 'meeting_transcript',
        external_id: transcriptId,
        title:       'In-person recording transcript',
        file_name:   null,
        url:         null,
        occurred_at: new Date().toISOString(),
        content,
        metadata,
      })
      .select('id')
      .single()

    if (insertErr || !newSource) {
      console.error('[webhook/assemblyai] Failed to insert source:', insertErr?.message)
      await db
        .from('meeting_recordings')
        .update({ status: 'failed', processing_error: 'Failed to store transcript.' })
        .eq('id', recording.id)
      return NextResponse.json({ error: 'Source insert failed.' }, { status: 500 })
    }

    sourceId = newSource.id as string

    // entity_sources link
    await db.from('entity_sources').insert({
      entity_type: 'meeting',
      entity_id:   recording.meeting_id,
      source_id:   sourceId,
      relation:    'transcript',
    })

    await db.from('audit_events').insert({
      actor_user_id: null,
      actor_type:    'system',
      action:        'recording.transcript_attached',
      entity_type:   'meeting',
      entity_id:     recording.meeting_id,
      after_json:    {
        recording_id:  recording.id,
        source_id:     sourceId,
        transcript_id: transcriptId,
        speaker_count: speakerCount,
        word_count:    wordCount,
      },
    })
  }

  // ── Update meetings.transcript_source_id (only if no existing transcript) ─
  const { data: meetingRow } = await db
    .from('meetings')
    .select('transcript_source_id')
    .eq('id', recording.meeting_id)
    .single()

  const meetingAlreadyHasTranscript = !!(meetingRow?.transcript_source_id)

  if (!meetingAlreadyHasTranscript) {
    // Safe to attach — no existing transcript
    await db
      .from('meetings')
      .update({ transcript_source_id: sourceId })
      .eq('id', recording.meeting_id)
  } else {
    // Conflict: existing transcript present. Log but do not overwrite.
    console.log(
      '[webhook/assemblyai] Meeting already has transcript — not overwriting.',
      'recording:', recording.id,
      'existing:', meetingRow.transcript_source_id,
    )
    await db.from('audit_events').insert({
      actor_user_id: null,
      actor_type:    'system',
      action:        'recording.transcript_conflict',
      entity_type:   'meeting',
      entity_id:     recording.meeting_id,
      after_json:    {
        recording_id:      recording.id,
        new_source_id:     sourceId,
        existing_source_id: meetingRow.transcript_source_id,
      },
    })
  }

  // ── Update recording row ──────────────────────────────────────────────────
  const newStatus = hasUnmappedSpeakers ? 'needs_speaker_review' : 'complete'

  await db
    .from('meeting_recordings')
    .update({
      status:              newStatus,
      transcript_source_id: sourceId,
      speaker_mapping:     resolvedMapping,
      processing_error:    null,
    })
    .eq('id', recording.id)

  console.log('[webhook/assemblyai] Processed successfully:', recording.id, '→', newStatus)

  return NextResponse.json({ ok: true })
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
