'use server'

/**
 * lib/actions/diner-invitations.ts
 *
 * Server actions for managing Mystery Diner invitations.
 *
 * Only management roles (SUPER_ADMIN, UM) can create invitations.
 * The raw token is returned exactly once — it must be copied from the
 * response and shared with the diner. It is never stored.
 *
 * Email delivery:
 *   If diner_email is provided, an invitation email is sent automatically.
 *   Delivery is tracked in report_deliveries (report_type='diner_invitation',
 *   submission_key=invitation_id). The unique partial index on terminal status
 *   provides retry idempotency — a 'sent' record can never be duplicated.
 *
 *   To support email retry without re-generating the token, the invite URL is
 *   stored encrypted (AES-256-GCM, key from DINER_INVITE_SECRET env var) in
 *   encrypted_invite_url. If that env var is absent, retry is unavailable but
 *   invitation creation and first-send are unaffected.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser }       from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { generateInviteToken }   from '@/lib/diner/token'
import { encryptInviteUrl, decryptInviteUrl } from '@/lib/diner/encrypt-url'
import { sendDinerInvitationEmail } from '@/lib/diner/send-invitation-email'
import type { ActionResult } from '@/lib/types'

const REPORT_TYPE = 'diner_invitation'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CreateDinerInvitationInput {
  dinerName:    string
  dinerEmail?:  string | null
  locationId?:  string | null
  /** How long the invitation link is valid for, in hours. Default 72. */
  expiresInHours?: number
}

export interface CreateDinerInvitationData {
  invitationId: string
  /** Full public URL including raw token — reveal once, then discard. */
  inviteUrl:    string
  expiresAt:    string
  emailStatus:  'sent' | 'failed' | 'not_sent'
  emailError?:  string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function recordDelivery(
  invitationId: string,
  recipient:    string,
  outcome:      { status: 'sent'; resendId: string } | { status: 'failed'; error: string },
): Promise<void> {
  const db = createServiceClient()
  const { error } = await db.from('report_deliveries').insert({
    report_type:    REPORT_TYPE,
    submission_key: invitationId,
    recipient,
    status:         outcome.status,
    resend_id:      outcome.status === 'sent' ? outcome.resendId : null,
    sent_at:        outcome.status === 'sent' ? new Date().toISOString() : null,
    error:          outcome.status === 'failed' ? outcome.error : null,
  })
  if (error && error.code !== '23505') {
    // 23505 = unique violation on terminal status — concurrent duplicate, safe to ignore
    console.error('[diner-invitations] recordDelivery error:', error.message)
  }
}

async function isAlreadySent(invitationId: string, recipient: string): Promise<boolean> {
  const db = createServiceClient()
  const { data } = await db
    .from('report_deliveries')
    .select('id')
    .eq('report_type', REPORT_TYPE)
    .eq('submission_key', invitationId)
    .eq('recipient', recipient)
    .eq('status', 'sent')
    .maybeSingle()
  return !!data
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createDinerInvitation(
  input: CreateDinerInvitationInput,
): Promise<ActionResult<CreateDinerInvitationData>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessManagementView(user.role)) return { error: 'Not authorised' }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { error: 'Server misconfiguration: NEXT_PUBLIC_APP_URL not set' }

  const dinerName = input.dinerName.trim()
  if (!dinerName) return { error: 'Diner name is required' }

  const dinerEmail = input.dinerEmail?.trim() || null

  const expiresInHours = input.expiresInHours ?? 72
  if (expiresInHours < 1 || expiresInHours > 720) {
    return { error: 'expiresInHours must be between 1 and 720' }
  }

  const expiresAt  = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString()
  const { rawToken, tokenHash } = generateInviteToken()
  const inviteUrl  = `${appUrl}/diner/${rawToken}`

  // Encrypt the URL for retry support (null if DINER_INVITE_SECRET not configured)
  const encryptedUrl = encryptInviteUrl(inviteUrl)

  const db = createServiceClient()

  const { data, error } = await db
    .from('diner_invitations')
    .insert({
      token_hash:           tokenHash,
      diner_name:           dinerName,
      diner_email:          dinerEmail,
      location_id:          input.locationId ?? null,
      created_by_user_id:   user.id,
      expires_at:           expiresAt,
      encrypted_invite_url: encryptedUrl,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[diner-invitations] createDinerInvitation error:', error.message)
    return { error: 'Failed to create invitation. Please try again.' }
  }

  const invitationId = data.id as string

  // rawToken is dropped from this point — never log it
  // Send invitation email if email provided
  let emailStatus: 'sent' | 'failed' | 'not_sent' = 'not_sent'
  let emailError: string | undefined

  if (dinerEmail) {
    // Resolve location name for the email
    let locationName: string | null = null
    if (input.locationId) {
      const { data: loc } = await db
        .from('locations')
        .select('name')
        .eq('id', input.locationId)
        .maybeSingle()
      locationName = (loc as any)?.name ?? null
    }

    const sendResult = await sendDinerInvitationEmail({
      recipientEmail: dinerEmail,
      dinerName,
      locationName,
      inviteUrl,
      expiresAt,
    })

    if (sendResult.ok) {
      emailStatus = 'sent'
      await recordDelivery(invitationId, dinerEmail, { status: 'sent', resendId: sendResult.resendId })
    } else {
      emailStatus = 'failed'
      emailError  = sendResult.error
      await recordDelivery(invitationId, dinerEmail, { status: 'failed', error: sendResult.error })
      console.error('[diner-invitations] invitation email failed:', sendResult.error)
    }
  }

  return {
    data: {
      invitationId,
      inviteUrl,
      expiresAt,
      emailStatus,
      ...(emailError && { emailError }),
    },
  }
}

// ─── Retry email ──────────────────────────────────────────────────────────────

export interface RetryDinerEmailData {
  emailStatus: 'sent' | 'already_sent'
}

export async function retryDinerInvitationEmail(
  invitationId: string,
): Promise<ActionResult<RetryDinerEmailData>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessManagementView(user.role)) return { error: 'Not authorised' }

  if (!invitationId) return { error: 'invitationId is required' }

  const db = createServiceClient()

  const { data: inv, error: invErr } = await db
    .from('diner_invitations')
    .select('id, diner_name, diner_email, location_id, expires_at, status, encrypted_invite_url, locations ( name )')
    .eq('id', invitationId)
    .maybeSingle()

  if (invErr || !inv) return { error: 'Invitation not found' }

  const dinerEmail = (inv.diner_email as string | null)
  if (!dinerEmail) return { error: 'This invitation has no email address' }

  if (inv.status === 'expired') return { error: 'Invitation has expired' }

  const encryptedUrl = (inv.encrypted_invite_url as string | null)
  if (!encryptedUrl) {
    return { error: 'Invite URL is not available for retry — DINER_INVITE_SECRET was not configured when this invitation was created' }
  }

  const inviteUrl = decryptInviteUrl(encryptedUrl)
  if (!inviteUrl) {
    return { error: 'Failed to decrypt invite URL — DINER_INVITE_SECRET may have changed' }
  }

  // Idempotency: skip if already delivered
  const alreadySent = await isAlreadySent(invitationId, dinerEmail)
  if (alreadySent) {
    return { data: { emailStatus: 'already_sent' } }
  }

  const locationName = (inv.locations as unknown as { name: string } | null)?.name ?? null
  const dinerName    = inv.diner_name as string
  const expiresAt    = inv.expires_at as string

  const sendResult = await sendDinerInvitationEmail({
    recipientEmail: dinerEmail,
    dinerName,
    locationName,
    inviteUrl,
    expiresAt,
  })

  if (sendResult.ok) {
    await recordDelivery(invitationId, dinerEmail, { status: 'sent', resendId: sendResult.resendId })
    return { data: { emailStatus: 'sent' } }
  } else {
    await recordDelivery(invitationId, dinerEmail, { status: 'failed', error: sendResult.error })
    return { error: `Email delivery failed: ${sendResult.error}` }
  }
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

export async function cancelDinerInvitation(
  invitationId: string,
): Promise<ActionResult<void>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessManagementView(user.role)) return { error: 'Not authorised' }

  if (!invitationId) return { error: 'invitationId is required' }

  const db = createServiceClient()

  const { data: inv } = await db
    .from('diner_invitations')
    .select('id, status')
    .eq('id', invitationId)
    .maybeSingle()

  if (!inv) return { error: 'Invitation not found' }
  if (inv.status === 'submitted') return { error: 'Cannot cancel a submitted audit' }
  if (inv.status === 'expired')   return { error: 'Invitation is already expired' }

  const { error } = await db
    .from('diner_invitations')
    .update({ status: 'expired' })
    .eq('id', invitationId)

  if (error) {
    console.error('[diner-invitations] cancelDinerInvitation error:', error.message)
    return { error: 'Failed to cancel invitation. Please try again.' }
  }

  return { data: undefined }
}
