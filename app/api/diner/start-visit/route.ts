/**
 * POST /api/diner/start-visit
 *
 * Creates a new Mystery Diner visit for an authenticated diner identity.
 *
 * Request body: { locationId: string }
 * Response:     { ok: true } | { ok: false; error: string }
 *
 * Flow:
 *   1. Verify dk_identity cookie.
 *   2. Load diner from diner_diners — must be active.
 *   3. Check for an existing in-progress visit for this diner (anti-duplicate).
 *      If found, re-use it (set dk_session to the existing invitation+submission).
 *   4. Otherwise create a fresh diner_invitations + diner_submissions row.
 *   5. Issue dk_session cookie scoped to the (invitationId, submissionId).
 *   6. Return { ok: true } — client redirects to /diner/form.
 *
 * Security:
 *   - All DB access via service_role after identity cookie verification.
 *   - New visit invitations have far-future expires_at (10 years) — the diner's
 *     active/disabled status is the real access gate, not expiry.
 *   - One in-progress visit per diner at a time (anti-duplicate guard).
 */

import { type NextRequest, NextResponse } from 'next/server'
import { createServiceClient }             from '@/lib/supabase/server'
import { verifyDinerIdentity, DINER_IDENTITY_COOKIE_NAME } from '@/lib/diner/identity'
import { signDinerSession, DINER_COOKIE_NAME }              from '@/lib/diner/session'

function json(body: object, status = 200) {
  return NextResponse.json(body, { status })
}

export async function POST(request: NextRequest) {
  // ── 1. Verify identity cookie ─────────────────────────────────────────────
  const identityCookie = request.cookies.get(DINER_IDENTITY_COOKIE_NAME)?.value ?? ''
  const identity       = verifyDinerIdentity(identityCookie)
  if (!identity) return json({ ok: false, error: 'Not authenticated' }, 401)

  // ── 2. Parse request body ─────────────────────────────────────────────────
  let locationId: string | null = null
  try {
    const body = await request.json()
    locationId = typeof body?.locationId === 'string' && body.locationId ? body.locationId : null
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400)
  }
  if (!locationId) return json({ ok: false, error: 'locationId is required' }, 400)

  const db = createServiceClient()

  // ── 3. Load diner ─────────────────────────────────────────────────────────
  const { data: diner, error: dinerErr } = await db
    .from('diner_diners')
    .select('id, name, status')
    .eq('id', identity.dinerId)
    .maybeSingle()

  if (dinerErr || !diner) {
    console.error('[start-visit] diner lookup error:', dinerErr?.message)
    return json({ ok: false, error: 'Diner not found' }, 404)
  }
  if ((diner.status as string) === 'disabled') {
    return json({ ok: false, error: 'Access disabled' }, 403)
  }

  // ── 4. Anti-duplicate: reuse existing in-progress visit ───────────────────
  const { data: existingInv } = await db
    .from('diner_invitations')
    .select('id, diner_submissions ( id, status )')
    .eq('diner_id', identity.dinerId)
    .eq('status', 'active')
    .maybeSingle()

  if (existingInv) {
    const subs = Array.isArray(existingInv.diner_submissions)
      ? existingInv.diner_submissions
      : existingInv.diner_submissions ? [existingInv.diner_submissions] : []

    const openSub = subs.find((s: any) => s.status === 'in_progress')
    if (openSub) {
      // Re-issue session for the existing in-progress visit
      const cookieValue = signDinerSession({
        invitationId: existingInv.id as string,
        submissionId: openSub.id     as string,
      })
      const response = json({ ok: true })
      response.cookies.set(DINER_COOKIE_NAME, cookieValue, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path:     '/',
        maxAge:   7 * 24 * 60 * 60,
      })
      return response
    }
  }

  // ── 5. Create fresh visit invitation ──────────────────────────────────────
  // Far-future expiry — access is controlled by diner.status, not expiry.
  const expiresAt = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString()

  const { data: newInv, error: invErr } = await db
    .from('diner_invitations')
    .insert({
      diner_id:    identity.dinerId,
      location_id: locationId,
      diner_name:  diner.name   as string,
      diner_email: null,
      expires_at:  expiresAt,
      // created_by_user_id intentionally NULL — system-created on diner's behalf
    })
    .select('id')
    .single()

  if (invErr) {
    console.error('[start-visit] invitation insert error:', invErr.message)
    return json({ ok: false, error: 'Failed to start visit. Please try again.' }, 500)
  }

  const invitationId = newInv.id as string

  // ── 6. Find published template and create submission ──────────────────────
  const { data: tpl } = await db
    .from('diner_templates')
    .select('id')
    .eq('status', 'published')
    .maybeSingle()

  const { data: newSub, error: subErr } = await db
    .from('diner_submissions')
    .insert({ invitation_id: invitationId, template_id: tpl?.id ?? null })
    .select('id')
    .single()

  if (subErr) {
    if (subErr.code === '23505') {
      // Concurrent request won — fetch the winning row
      const { data: existing } = await db
        .from('diner_submissions')
        .select('id')
        .eq('invitation_id', invitationId)
        .maybeSingle()
      if (!existing) return json({ ok: false, error: 'Something went wrong. Please try again.' }, 500)

      // Mark invitation active
      await db
        .from('diner_invitations')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', invitationId)
        .eq('status', 'pending')

      const cookieValue = signDinerSession({ invitationId, submissionId: existing.id as string })
      const response = json({ ok: true })
      response.cookies.set(DINER_COOKIE_NAME, cookieValue, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path:     '/',
        maxAge:   7 * 24 * 60 * 60,
      })
      return response
    }
    console.error('[start-visit] submission insert error:', subErr.message)
    return json({ ok: false, error: 'Failed to start visit. Please try again.' }, 500)
  }

  // Mark invitation active
  await db
    .from('diner_invitations')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', invitationId)
    .eq('status', 'pending')

  // ── 7. Issue session cookie ───────────────────────────────────────────────
  let cookieValue: string
  try {
    cookieValue = signDinerSession({ invitationId, submissionId: newSub.id as string })
  } catch (err) {
    console.error('[start-visit] Failed to sign session:', err)
    return json({ ok: false, error: 'Server configuration error.' }, 500)
  }

  const response = json({ ok: true })
  response.cookies.set(DINER_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   7 * 24 * 60 * 60,
  })
  return response
}
