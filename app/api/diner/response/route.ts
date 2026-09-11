/**
 * POST /api/diner/response
 *
 * Autosave endpoint for Mystery Diner questionnaire answers.
 *
 * Auth: HMAC-SHA256 signed dk_session cookie (Path=/, HttpOnly).
 * Writes via service_role after verifying:
 *   1. Cookie signature is valid.
 *   2. Submission exists and belongs to the session invitation.
 *   3. Submission is still in_progress (not submitted).
 *   4. No direct anon Supabase access — all writes via this endpoint.
 *
 * Idempotent: upserts on (submission_id, checkpoint_id).
 */

import { type NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyDinerSession, DINER_COOKIE_NAME } from '@/lib/diner/session'

export async function POST(request: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────
  const cookie  = request.cookies.get(DINER_COOKIE_NAME)
  const session = cookie ? verifyDinerSession(cookie.value) : null

  if (!session) {
    return NextResponse.json({ error: 'No valid session.' }, { status: 401 })
  }

  // ── Parse body ───────────────────────────────────────────────────────────
  let body: { checkpointId?: unknown; result?: unknown; notes?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const { checkpointId, result, notes } = body

  if (typeof checkpointId !== 'string' || !checkpointId) {
    return NextResponse.json({ error: 'checkpointId is required.' }, { status: 400 })
  }
  if (result !== null && result !== undefined && !['pass', 'fail', 'na'].includes(result as string)) {
    return NextResponse.json({ error: 'Invalid result value.' }, { status: 400 })
  }
  if (notes !== null && notes !== undefined && typeof notes !== 'string') {
    return NextResponse.json({ error: 'Invalid notes value.' }, { status: 400 })
  }

  const db = createServiceClient()

  // ── Verify submission ─────────────────────────────────────────────────────
  const { data: submission } = await db
    .from('diner_submissions')
    .select('id, status')
    .eq('id',            session.submissionId)
    .eq('invitation_id', session.invitationId)
    .maybeSingle()

  if (!submission) {
    return NextResponse.json({ error: 'Submission not found.' }, { status: 404 })
  }
  if (submission.status === 'submitted') {
    return NextResponse.json({ error: 'Audit already submitted.' }, { status: 409 })
  }

  // ── Upsert response ───────────────────────────────────────────────────────
  const { error } = await db
    .from('diner_responses')
    .upsert(
      {
        submission_id: session.submissionId,
        checkpoint_id: checkpointId,
        result:        (result as string | null) ?? null,
        notes:         (notes as string | null)  ?? null,
        updated_at:    new Date().toISOString(),
      },
      { onConflict: 'submission_id,checkpoint_id' },
    )

  if (error) {
    console.error('[api/diner/response] upsert error:', error.message)
    return NextResponse.json({ error: 'Failed to save response.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
