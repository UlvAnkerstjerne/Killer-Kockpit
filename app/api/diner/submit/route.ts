/**
 * POST /api/diner/submit
 *
 * Submits a Mystery Diner audit.
 *
 * Auth: HMAC-SHA256 signed dk_session cookie (same as /api/diner/response).
 *
 * Calls submit_diner_submission(submissionId, invitationId) SECURITY DEFINER RPC
 * which:
 *   - Locks the row to prevent concurrent submits
 *   - Computes score_pct, critical_fail_count, gold_star_count, waiting_time_band
 *   - Sets status = 'submitted' on both submission and invitation
 *   - Returns computed scores as JSON
 *
 * After this call, the submission and all its responses are immutable
 * (enforced at the DB layer by triggers).
 */

import { type NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyDinerSession, DINER_COOKIE_NAME } from '@/lib/diner/session'
import { dispatchDinerResult } from '@/lib/reports/dispatch-diner'

export async function POST(request: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────
  const cookie  = request.cookies.get(DINER_COOKIE_NAME)
  const session = cookie ? verifyDinerSession(cookie.value) : null

  if (!session) {
    return NextResponse.json({ error: 'No valid session.' }, { status: 401 })
  }

  const db = createServiceClient()

  // ── Verify submission is still open ──────────────────────────────────────
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
    return NextResponse.json({ error: 'Already submitted.', alreadySubmitted: true }, { status: 409 })
  }

  // ── Call submit RPC ───────────────────────────────────────────────────────
  const { data, error } = await db.rpc('submit_diner_submission', {
    p_submission_id: session.submissionId,
    p_invitation_id: session.invitationId,
  })

  if (error) {
    console.error('[api/diner/submit] RPC error:', error.message)
    const msg = error.message.includes('Already submitted')
      ? 'This audit has already been submitted.'
      : 'Submission failed. Please try again.'
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  // Fire-and-forget — result distribution must not block the diner's response
  dispatchDinerResult(session.submissionId)

  return NextResponse.json(data)
}
