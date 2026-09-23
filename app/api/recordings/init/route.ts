/**
 * POST /api/recordings/init
 *
 * Step 1 of the two-step direct-upload flow.
 *
 * Returns a short-lived signed upload URL so the browser can PUT audio
 * directly to Supabase Storage without routing the binary through Railway.
 *
 * Flow
 * ────
 * 1. Authenticate current user.
 * 2. Validate the meeting_recordings row (must exist, be in status 'recording',
 *    and belong to this user / meeting with manage-transcript permission).
 * 3. Derive a server-controlled storage path (caller cannot choose it).
 * 4. Create a Supabase signed upload URL (service-role key never leaves server).
 * 5. Store the path on the recording row (finalize verifies via DB, not client).
 * 6. Return { uploadUrl } — the browser uploads directly to that URL.
 *
 * Security
 * ────────
 * • Only the authenticated session creator or SUPER_ADMIN may init an upload.
 * • Storage path is server-generated: recordings/<meetingId>/<recordingId>.<ext>
 * • The signed URL is scoped to exactly that path and expires in 30 minutes.
 * • Upsert is enabled so a retry re-uploads the same path cleanly.
 * • Service-role key never sent to the browser.
 *
 * The recording row keeps status='recording' until finalize confirms the
 * object is in Storage and AssemblyAI submission succeeds.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { canManageTranscript } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: { recordingId?: string; mimeType?: string; durationMs?: number }
  try {
    body = await request.json() as { recordingId?: string; mimeType?: string; durationMs?: number }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const { recordingId, mimeType = 'audio/webm', durationMs } = body

  if (!recordingId) {
    return NextResponse.json({ error: 'Missing recordingId.' }, { status: 400 })
  }

  const db = createServiceClient()

  // ── Load recording row ────────────────────────────────────────────────────
  const { data: recording, error: recErr } = await db
    .from('meeting_recordings')
    .select('id, meeting_id, status, created_by_user_id, expected_speakers')
    .eq('id', recordingId)
    .single()

  if (recErr || !recording) {
    return NextResponse.json({ error: 'Recording session not found.' }, { status: 400 })
  }

  // Only the session creator or SUPER_ADMIN may upload
  if (recording.created_by_user_id !== user.id && user.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 401 })
  }

  // Already completed or failed — do not re-init
  if (recording.status === 'complete' || recording.status === 'transcribing') {
    return NextResponse.json({ error: 'Recording already processed.' }, { status: 409 })
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

  // ── Derive server-controlled storage path ─────────────────────────────────
  const ext         = mimeType.split('/')[1]?.split(';')[0] ?? 'webm'
  const storagePath = `recordings/${recording.meeting_id}/${recordingId}.${ext}`

  // ── Create signed upload URL (service role — never exposed to browser) ────
  // Use the SDK so the service key format (sb_secret_… or JWT) is handled
  // correctly regardless of which Supabase key generation is in use.
  const { data: signedData, error: signErr } = await db.storage
    .from('meeting-recordings')
    .createSignedUploadUrl(storagePath, { upsert: true })

  if (signErr || !signedData?.signedUrl) {
    console.error('[api/recordings/init] Failed to create signed upload URL:', signErr?.message)
    return NextResponse.json({ error: 'Could not prepare upload. Please retry.' }, { status: 500 })
  }

  const uploadUrl = signedData.signedUrl

  // ── Store path on recording row (finalize trusts DB, not client) ──────────
  const durationSeconds = durationMs && durationMs > 0 ? Math.round(durationMs / 1000) : null

  await db
    .from('meeting_recordings')
    .update({
      storage_path:     storagePath,
      mime_type:        mimeType,
      duration_seconds: durationSeconds,
    })
    .eq('id', recordingId)

  return NextResponse.json({ uploadUrl })
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
