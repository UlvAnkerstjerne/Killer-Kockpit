'use server'

/**
 * lib/actions/diner-diners.ts
 *
 * Server actions for managing permanent Mystery Diner access records.
 * Only management roles (SUPER_ADMIN, UM) can perform these actions.
 *
 * Access link delivery is tracked in report_deliveries:
 *   report_type    = 'diner_access'
 *   submission_key = diner UUID
 *   recipient      = diner email address
 *
 * The raw access token is returned exactly once at creation — it is never
 * stored. Resend uses the encrypted_access_url column (AES-256-GCM, key from
 * DINER_INVITE_SECRET) to reconstruct the URL without the raw token.
 */

import { createServiceClient }       from '@/lib/supabase/server'
import { getCurrentUser }             from '@/lib/auth'
import { canAccessManagementView }    from '@/lib/permissions'
import { generateInviteToken }        from '@/lib/diner/token'
import { encryptInviteUrl, decryptInviteUrl } from '@/lib/diner/encrypt-url'
import { sendDinerAccessEmail }       from '@/lib/diner/send-access-email'
import type { ActionResult }          from '@/lib/types'

const REPORT_TYPE = 'diner_access'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateDinerAccessInput {
  name:  string
  email: string
}

export interface CreateDinerAccessData {
  dinerId:     string
  emailStatus: 'sent' | 'failed'
  emailError?: string
}

export interface DinerRosterRow {
  id:            string
  name:          string
  email:         string
  status:        'active' | 'disabled'
  created_at:    string
  disabled_at:   string | null
  visit_count:   number
  last_visit_at: string | null
  email_status:  'sent' | 'failed' | 'not_sent'
  can_resend:    boolean
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function recordDelivery(
  dinerId:   string,
  recipient: string,
  outcome:   { status: 'sent'; resendId: string } | { status: 'failed'; error: string },
): Promise<void> {
  const db = createServiceClient()
  const { error } = await db.from('report_deliveries').insert({
    report_type:    REPORT_TYPE,
    submission_key: dinerId,
    recipient,
    status:         outcome.status,
    resend_id:      outcome.status === 'sent' ? outcome.resendId : null,
    sent_at:        outcome.status === 'sent' ? new Date().toISOString() : null,
    error:          outcome.status === 'failed' ? outcome.error : null,
  })
  if (error && error.code !== '23505') {
    console.error('[diner-diners] recordDelivery error:', error.message)
  }
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createDinerAccess(
  input: CreateDinerAccessInput,
): Promise<ActionResult<CreateDinerAccessData>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessManagementView(user.role)) return { error: 'Not authorised' }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { error: 'Server misconfiguration: NEXT_PUBLIC_APP_URL not set' }

  const name  = input.name.trim()
  const email = input.email.trim().toLowerCase()
  if (!name)  return { error: 'Name is required' }
  if (!email) return { error: 'Email is required' }

  const { rawToken, tokenHash } = generateInviteToken()
  const accessUrl               = `${appUrl}/diner/${rawToken}`
  const encryptedUrl            = encryptInviteUrl(accessUrl)

  const db = createServiceClient()

  const { data, error } = await db
    .from('diner_diners')
    .insert({
      name,
      email,
      token_hash:           tokenHash,
      encrypted_access_url: encryptedUrl,
      created_by_user_id:   user.id,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[diner-diners] createDinerAccess error:', error.message)
    return { error: 'Failed to create diner. Please try again.' }
  }

  const dinerId = data.id as string

  const sendResult = await sendDinerAccessEmail({
    recipientEmail: email,
    dinerName:      name,
    accessUrl,
  })

  let emailStatus: 'sent' | 'failed'
  let emailError: string | undefined

  if (sendResult.ok) {
    emailStatus = 'sent'
    await recordDelivery(dinerId, email, { status: 'sent', resendId: sendResult.resendId })
  } else {
    emailStatus = 'failed'
    emailError  = sendResult.error
    await recordDelivery(dinerId, email, { status: 'failed', error: sendResult.error })
    console.error('[diner-diners] access email failed:', sendResult.error)
  }

  return { data: { dinerId, emailStatus, ...(emailError && { emailError }) } }
}

// ─── Resend access link ───────────────────────────────────────────────────────

export async function resendDinerAccessEmail(
  dinerId: string,
): Promise<ActionResult<{ emailStatus: 'sent' }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessManagementView(user.role)) return { error: 'Not authorised' }

  if (!dinerId) return { error: 'dinerId is required' }

  const db = createServiceClient()

  const { data: diner, error: dinerErr } = await db
    .from('diner_diners')
    .select('id, name, email, status, encrypted_access_url')
    .eq('id', dinerId)
    .maybeSingle()

  if (dinerErr || !diner) return { error: 'Diner not found' }
  if ((diner.status as string) === 'disabled') {
    return { error: 'Cannot resend link for a disabled diner' }
  }

  const encryptedUrl = diner.encrypted_access_url as string | null
  if (!encryptedUrl) {
    return {
      error:
        'Access URL not available — DINER_INVITE_SECRET was not configured when this diner was created',
    }
  }

  const accessUrl = decryptInviteUrl(encryptedUrl)
  if (!accessUrl) {
    return { error: 'Failed to decrypt access URL — DINER_INVITE_SECRET may have changed' }
  }

  const sendResult = await sendDinerAccessEmail({
    recipientEmail: diner.email as string,
    dinerName:      diner.name  as string,
    accessUrl,
  })

  if (sendResult.ok) {
    await recordDelivery(dinerId, diner.email as string, { status: 'sent', resendId: sendResult.resendId })
    return { data: { emailStatus: 'sent' } }
  } else {
    await recordDelivery(dinerId, diner.email as string, { status: 'failed', error: sendResult.error })
    return { error: `Email delivery failed: ${sendResult.error}` }
  }
}

// ─── Disable ──────────────────────────────────────────────────────────────────

export async function disableDiner(dinerId: string): Promise<ActionResult<void>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessManagementView(user.role)) return { error: 'Not authorised' }

  const db = createServiceClient()
  const { error } = await db
    .from('diner_diners')
    .update({ status: 'disabled', disabled_at: new Date().toISOString() })
    .eq('id', dinerId)
    .eq('status', 'active')

  if (error) {
    console.error('[diner-diners] disableDiner error:', error.message)
    return { error: 'Failed to disable diner' }
  }
  return { data: undefined }
}

// ─── Enable ───────────────────────────────────────────────────────────────────

export async function enableDiner(dinerId: string): Promise<ActionResult<void>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessManagementView(user.role)) return { error: 'Not authorised' }

  const db = createServiceClient()
  const { error } = await db
    .from('diner_diners')
    .update({ status: 'active', disabled_at: null })
    .eq('id', dinerId)
    .eq('status', 'disabled')

  if (error) {
    console.error('[diner-diners] enableDiner error:', error.message)
    return { error: 'Failed to enable diner' }
  }
  return { data: undefined }
}
