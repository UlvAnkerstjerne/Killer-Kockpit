/**
 * lib/reports/notify-users.ts
 *
 * Server-only helpers for creating system Kockpit notifications with
 * idempotency via report_deliveries.
 *
 * All writes go through the create_system_notification() SECURITY DEFINER
 * RPC (migration 056) using createServiceClient() to bypass RLS.
 *
 * Idempotency pattern:
 *   - For notification deliveries, recipient = 'notification:<userId>'
 *   - Terminal rows (status = 'sent' | 'skipped') in report_deliveries
 *     prevent re-creation on retry.
 */

import { createServiceClient } from '@/lib/supabase/server'

// ─── User resolution ──────────────────────────────────────────────────────────

/**
 * Resolves app_users.email → app_users.id for a list of email addresses.
 * Uses service_role to bypass RLS.
 * Users not found are omitted from the map with a console warning.
 */
export async function resolveUsersByEmail(
  emails: string[],
): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map()

  const db = createServiceClient()
  const { data, error } = await db
    .from('app_users')
    .select('id, email')
    .in('email', emails)

  if (error) throw new Error(`User lookup failed: ${error.message}`)

  const map = new Map<string, string>()
  for (const row of data ?? []) {
    map.set(row.email, row.id)
  }

  for (const email of emails) {
    if (!map.has(email)) {
      console.warn(`[notify-users] No app_user found for email "${email}" — notification skipped`)
    }
  }

  return map
}

// ─── Idempotent notification creation ─────────────────────────────────────────

export interface SystemNotificationInput {
  /** report_deliveries.report_type — stable identifier for this notification class */
  reportType:    string
  /** report_deliveries.submission_key — unique key for this specific event */
  submissionKey: string
  /** Recipient app_user ID */
  userId:        string
  /** notifications.type — must satisfy the DB CHECK constraint */
  type:          string
  /** notifications.entity_type */
  entityType:    string
  /** notifications.entity_id — UUID pointing to the referenced entity */
  entityId:      string
  /** Structured display data stored in notifications.metadata */
  metadata:      Record<string, unknown>
}

/**
 * Creates a system notification for one user, idempotent via report_deliveries.
 *
 * The report_deliveries recipient key is 'notification:<userId>' — one row
 * per (report_type, submission_key, userId) combination.
 *
 * Returns 'sent' on first delivery, 'skipped' if already delivered,
 * 'failed' if the RPC or DB insert fails (error is logged, not thrown).
 */
export async function createSystemNotificationIdempotent(
  opts: SystemNotificationInput,
): Promise<'sent' | 'skipped' | 'failed'> {
  const { reportType, submissionKey, userId, type, entityType, entityId, metadata } = opts
  const recipient = `notification:${userId}`
  const db = createServiceClient()

  // ── Check for existing terminal delivery ──────────────────────────────
  const { data: existing, error: checkError } = await db
    .from('report_deliveries')
    .select('id')
    .eq('report_type', reportType)
    .eq('submission_key', submissionKey)
    .eq('recipient', recipient)
    .in('status', ['sent', 'skipped'])
    .maybeSingle()

  if (checkError) {
    console.error(`[notify-users] Delivery check failed for ${userId}:`, checkError.message)
    return 'failed'
  }

  if (existing) return 'skipped'

  // ── Create notification via SECURITY DEFINER RPC ──────────────────────
  const { error: rpcError } = await db.rpc('create_system_notification', {
    p_type:              type,
    p_entity_type:       entityType,
    p_entity_id:         entityId,
    p_recipient_user_id: userId,
    p_metadata:          metadata,
  })

  if (rpcError) {
    console.error(`[notify-users] RPC failed for ${userId}:`, rpcError.message)
    await db.from('report_deliveries').insert({
      report_type:    reportType,
      submission_key: submissionKey,
      recipient,
      status:         'failed',
      error:          rpcError.message,
    })
    return 'failed'
  }

  // ── Record successful delivery (unique index handles concurrent runs) ──
  const { error: insertError } = await db.from('report_deliveries').insert({
    report_type:    reportType,
    submission_key: submissionKey,
    recipient,
    status:         'sent',
    sent_at:        new Date().toISOString(),
  })

  if (insertError && insertError.code !== '23505') {
    // 23505 = concurrent run already recorded — safe to ignore
    console.error(`[notify-users] Failed to record delivery for ${userId}:`, insertError.message)
  }

  return 'sent'
}
