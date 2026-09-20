/**
 * POST /api/recordings/finalize
 *
 * Step 2 of the two-step direct-upload flow.
 *
 * Called by the browser after it has PUT audio directly to Supabase Storage
 * via the signed URL from /api/recordings/init.
 *
 * Flow
 * ────
 * 1. Authenticate current user.
 * 2. Load the recording row — the storage path was written by init (not by
 *    the client), so no path injection is possible.
 * 3. Update recording row: status=uploaded, byte_size, stopped_at.
 * 4. Generate a short-lived signed READ URL for the stored object.
 * 5. Submit transcription job to AssemblyAI (server-side; API key never leaves
 *    the server).
 * 6. Update recording row: status=transcribing, assemblyai_transcript_id.
 * 7. Return { ok: true }.
 *
 * On any failure after the storage upload, the recording row is set to
 * status=failed so the UI can offer a retry via retryTranscription().
 *
 * Idempotency / retry
 * ───────────────────
 * If finalize is called a second time for an already-transcribing or
 * complete recording, it returns 200 immediately without re-submitting.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { canManageTranscript } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import { submitTranscription } from '@/lib/assemblyai/client'
import { recordAuditEvent } from '@/lib/audit'

type LanguageMode = 'detect' | 'da' | 'en'

export async function POST(request: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: { recordingId?: string; byteSize?: number; durationMs?: number; languageMode?: LanguageMode }
  try {
    body = await request.json() as { recordingId?: string; byteSize?: number; durationMs?: number; languageMode?: LanguageMode }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const { recordingId, byteSize, durationMs, languageMode = 'detect' } = body

  if (!recordingId) {
    return NextResponse.json({ error: 'Missing recordingId.' }, { status: 400 })
  }

  const db = createServiceClient()

  // ── Load recording row ────────────────────────────────────────────────────
  const { data: recording, error: recErr } = await db
    .from('meeting_recordings')
    .select('id, meeting_id, status, storage_path, mime_type, created_by_user_id, expected_speakers, duration_seconds')
    .eq('id', recordingId)
    .single()

  if (recErr || !recording) {
    return NextResponse.json({ error: 'Recording session not found.' }, { status: 400 })
  }

  // Only the session creator or SUPER_ADMIN may finalize
  if (recording.created_by_user_id !== user.id && user.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 401 })
  }

  // Idempotency: already in transcribing/complete/failed
  if (recording.status === 'transcribing' || recording.status === 'complete' || recording.status === 'needs_speaker_review') {
    return NextResponse.json({ ok: true })
  }

  // Must have a storage path (set by init)
  if (!recording.storage_path) {
    return NextResponse.json({ error: 'Storage path not set. Call /api/recordings/init first.' }, { status: 400 })
  }

  // ── Verify meeting-level permission ───────────────────────────────────────
  const { data: meeting } = await db
    .from('meetings')
    .select('owner_user_id, status')
    .eq('id', recording.meeting_id as string)
    .single()

  if (!canManageTranscript(user.role, (meeting?.owner_user_id as string | null) ?? null, user.id, (meeting?.status as string | null) ?? null)) {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 401 })
  }

  // ── Update recording row: uploaded ────────────────────────────────────────
  const durationSeconds = durationMs && durationMs > 0
    ? Math.round(durationMs / 1000)
    : (recording.duration_seconds as number | null)

  await db
    .from('meeting_recordings')
    .update({
      status:           'uploaded',
      byte_size:        byteSize ?? null,
      stopped_at:       new Date().toISOString(),
      duration_seconds: durationSeconds,
    })
    .eq('id', recordingId)

  await recordAuditEvent({
    actorUserId: user.id,
    action:      'recording.uploaded',
    entityType:  'meeting',
    entityId:    recording.meeting_id as string,
    afterJson:   { recording_id: recordingId, storage_path: recording.storage_path, byte_size: byteSize ?? null },
  })

  // ── Generate short-lived signed READ URL for AssemblyAI ──────────────────
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey  = process.env.SUPABASE_SECRET_KEY!

  const signedReadRes = await fetch(
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

  if (!signedReadRes.ok) {
    console.error('[api/recordings/finalize] Failed to generate signed read URL')
    await db
      .from('meeting_recordings')
      .update({ status: 'failed', processing_error: 'Failed to generate signed URL for transcription.' })
      .eq('id', recordingId)
    return NextResponse.json({ error: 'Failed to prepare transcription.' }, { status: 500 })
  }

  const { signedURL } = await signedReadRes.json() as { signedURL: string }
  const audioUrl = `${supabaseUrl}/storage/v1${signedURL}`

  // ── Submit to AssemblyAI ──────────────────────────────────────────────────
  const webhookSecret = process.env.ASSEMBLYAI_WEBHOOK_SECRET
  const appUrl        = process.env.NEXT_PUBLIC_APP_URL

  if (!webhookSecret || !appUrl) {
    console.error('[api/recordings/finalize] ASSEMBLYAI_WEBHOOK_SECRET or NEXT_PUBLIC_APP_URL not set')
    await db
      .from('meeting_recordings')
      .update({ status: 'failed', processing_error: 'Server misconfiguration.' })
      .eq('id', recordingId)
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const speakerNames = (recording.expected_speakers as string[]) ?? []

  const languageConfig =
    languageMode === 'da'
      ? { mode: 'fixed' as const, languageCode: 'da' }
      : languageMode === 'en'
        ? { mode: 'fixed' as const, languageCode: 'en' }
        : { mode: 'detect' as const }

  let transcriptId: string
  try {
    const result = await submitTranscription({
      audioUrl,
      speakerNames,
      speakerCount:   speakerNames.length >= 2 ? speakerNames.length : null,
      languageConfig,
      webhookUrl:     `${appUrl}/api/assemblyai/webhook`,
      webhookSecret,
    })
    transcriptId = result.transcriptId
  } catch (err) {
    const msg = (err as Error).message
    console.error('[api/recordings/finalize] AssemblyAI submit failed:', msg)
    await db
      .from('meeting_recordings')
      .update({ status: 'failed', processing_error: `Transcription submit failed: ${msg}` })
      .eq('id', recordingId)
    return NextResponse.json({ error: 'Failed to submit for transcription. Audio is saved — retry from the meeting.' }, { status: 500 })
  }

  // ── Update row: transcribing ──────────────────────────────────────────────
  await db
    .from('meeting_recordings')
    .update({
      status:                   'transcribing',
      assemblyai_transcript_id: transcriptId,
    })
    .eq('id', recordingId)

  await recordAuditEvent({
    actorUserId: user.id,
    action:      'recording.transcription_submitted',
    entityType:  'meeting',
    entityId:    recording.meeting_id as string,
    afterJson:   { recording_id: recordingId, transcript_id: transcriptId },
  })

  return NextResponse.json({ ok: true })
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
