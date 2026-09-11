/**
 * GET /diner/[token]
 *
 * Public token-exchange endpoint for Mystery Diner invitations.
 *
 * Flow:
 *   1. Hash the raw URL token (SHA-256).
 *   2. Look up the invitation by token_hash via service_role.
 *   3. Validate: exists / not expired / not already submitted.
 *   4. If 'pending': create submission row, mark invitation 'active'.
 *      If 'active':  retrieve existing in-progress submission.
 *      Race (23505): fall back to fetching the winning row.
 *   5. Issue a signed HMAC-SHA256 session cookie scoped to (invitationId, submissionId).
 *   6. Redirect to /diner/form.
 *
 * Security:
 *   - No Supabase anon credentials used; all DB access is service_role.
 *   - Cookie is HttpOnly, Secure in production, SameSite=Lax, Path=/diner.
 *   - Expired / submitted / unknown tokens receive an HTML error page — not a redirect
 *     into the Kockpit application.
 *   - timingSafeEqual used in verifyDinerSession; no branch on secret length.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { hashInviteToken } from '@/lib/diner/token'
import { signDinerSession, DINER_COOKIE_NAME } from '@/lib/diner/session'

// ─── Minimal error page (no Kockpit chrome) ──────────────────────────────────

function errorPage(message: string, status: number): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mystery Diner</title>
<style>
  body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
       min-height:100svh;margin:0;background:#f8f8f7}
  .card{background:#fff;border-radius:12px;padding:2rem;max-width:360px;text-align:center;
        box-shadow:0 1px 4px rgba(0,0,0,.08)}
  h1{font-size:1.1rem;margin:0 0 .5rem}
  p{color:#555;margin:0;font-size:.9rem}
</style>
</head>
<body>
  <div class="card">
    <h1>Link unavailable</h1>
    <p>${message}</p>
  </div>
</body>
</html>`
  return new NextResponse(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  if (!token) return errorPage('Invalid invitation link.', 400)

  const tokenHash = hashInviteToken(token)
  const db        = createServiceClient()

  // ── 1. Look up invitation ─────────────────────────────────────────────────
  const { data: invitation, error: invErr } = await db
    .from('diner_invitations')
    .select('id, status, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (invErr) {
    console.error('[diner/token] DB error:', invErr.message)
    return errorPage('Something went wrong. Please try again.', 500)
  }
  if (!invitation) {
    return errorPage('This invitation link is not valid.', 404)
  }

  // ── 2. Validate state ─────────────────────────────────────────────────────
  if (new Date(invitation.expires_at) < new Date()) {
    return errorPage('This invitation has expired.', 410)
  }
  if (invitation.status === 'submitted') {
    return errorPage('This Mystery Diner audit has already been submitted.', 410)
  }
  if (invitation.status === 'expired') {
    return errorPage('This invitation has expired.', 410)
  }

  // ── 3. Get or create submission ───────────────────────────────────────────
  let submissionId: string

  if (invitation.status === 'pending') {
    // First access — create submission and mark invitation active
    const { data: newSub, error: subErr } = await db
      .from('diner_submissions')
      .insert({ invitation_id: invitation.id })
      .select('id')
      .single()

    if (subErr) {
      if (subErr.code === '23505') {
        // Concurrent first-access — fetch the winning row
        const { data: existing } = await db
          .from('diner_submissions')
          .select('id')
          .eq('invitation_id', invitation.id)
          .maybeSingle()
        if (!existing) return errorPage('Something went wrong. Please try again.', 500)
        submissionId = existing.id
      } else {
        console.error('[diner/token] Failed to create submission:', subErr.message)
        return errorPage('Something went wrong. Please try again.', 500)
      }
    } else {
      submissionId = newSub.id
      // Mark invitation active (best-effort; race handled by 23505 path above)
      await db
        .from('diner_invitations')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', invitation.id)
        .eq('status', 'pending') // only update if still pending
    }
  } else {
    // already active — retrieve existing in-progress submission
    const { data: existing, error: fetchErr } = await db
      .from('diner_submissions')
      .select('id, status')
      .eq('invitation_id', invitation.id)
      .maybeSingle()

    if (fetchErr || !existing) {
      console.error('[diner/token] Could not fetch existing submission:', fetchErr?.message)
      return errorPage('Something went wrong. Please try again.', 500)
    }
    if (existing.status === 'submitted') {
      return errorPage('This Mystery Diner audit has already been submitted.', 410)
    }
    submissionId = existing.id
  }

  // ── 4. Sign session cookie ────────────────────────────────────────────────
  let cookieValue: string
  try {
    cookieValue = signDinerSession({ invitationId: invitation.id, submissionId })
  } catch (err) {
    console.error('[diner/token] Failed to sign session:', err)
    return errorPage('Server configuration error. Please contact support.', 500)
  }

  // Cookie expires when the invitation does (floored to max 7 days for safety)
  const invitationExpiry = new Date(invitation.expires_at)
  const maxSeconds = Math.min(
    Math.floor((invitationExpiry.getTime() - Date.now()) / 1000),
    7 * 24 * 60 * 60,
  )

  // ── 5. Redirect to form ───────────────────────────────────────────────────
  const formUrl = new URL('/diner/form', request.url)
  const response = NextResponse.redirect(formUrl)

  response.cookies.set(DINER_COOKIE_NAME, cookieValue, {
    httpOnly:  true,
    secure:    process.env.NODE_ENV === 'production',
    sameSite:  'lax',
    path:      '/diner',
    maxAge:    maxSeconds,
  })

  return response
}
