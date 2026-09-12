/**
 * lib/reports/dispatch-audit-followup-escalation.ts
 *
 * Overdue Red Flag follow-up escalation checker.
 *
 * When an audit_followup is past its due_at and its status is not 'resolved',
 * a one-time escalation is sent via two independent channels to three parties:
 *   1. Kasper (drift@killerkebab.com)       — always
 *   2. Regional Manager                     — resolved from location name
 *   3. Ulv (ulv@killerkebab.com)            — always
 *
 * Channels:
 *   - Email (via Resend)
 *   - Kockpit in-app notification
 *
 * Idempotency:
 *   report_type    = 'audit_followup_overdue'
 *   submission_key = followupId
 *   recipient      = email address (email channel) or 'notification:<userId>'
 *   Terminal records (sent/skipped) in report_deliveries prevent re-delivery.
 *
 * The escalation fires exactly once per follow-up per recipient.  If any
 * individual channel fails it remains non-terminal in report_deliveries and
 * will be retried on the next cron run.  Resolved follow-ups are excluded
 * from the query and will never be escalated.
 *
 * Server-only — never import from client components.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { sendAuditFollowupEscalationEmail } from './send-audit-followup-escalation-email'
import { resolveUsersByEmail, createSystemNotificationIdempotent } from './notify-users'
import { AUDIT_FOLLOWUP_ESCALATION } from './delivery-config'

// ─── Constants ────────────────────────────────────────────────────────────────

const REPORT_TYPE = AUDIT_FOLLOWUP_ESCALATION.reportType

// ─── Pure helpers (exported for unit tests) ───────────────────────────────────

/**
 * Returns the Regional Manager's email for a given location name, or null
 * when no RM is configured for that location (e.g. Copenhagen Airport).
 * Source of truth is AUDIT_FOLLOWUP_ESCALATION.regionManagerByLocation.
 */
export function resolveRegionManager(locationName: string): string | null {
  return AUDIT_FOLLOWUP_ESCALATION.regionManagerByLocation.get(locationName) ?? null
}

/**
 * Builds the full deduplicated list of email recipients for a given location.
 * Always includes fixed recipients (Kasper + Ulv).  Adds the RM if one is
 * configured and not already in the fixed list.
 */
export function buildAllEmailRecipients(locationName: string): string[] {
  const fixed = AUDIT_FOLLOWUP_ESCALATION.fixedEmailRecipients
  const rm    = resolveRegionManager(locationName)
  if (!rm || fixed.includes(rm)) return fixed
  return [...fixed, rm]
}

/**
 * Builds the full deduplicated list of notify-user emails for a given location.
 * Same logic as buildAllEmailRecipients but for the notification channel.
 */
export function buildAllNotifyEmails(locationName: string): string[] {
  const fixed = AUDIT_FOLLOWUP_ESCALATION.fixedNotifyEmails
  const rm    = resolveRegionManager(locationName)
  if (!rm || fixed.includes(rm)) return fixed
  return [...fixed, rm]
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EscalationOutcome {
  followupId:    string
  submissionId:  string
  locationName:  string
  /** Email address or 'notification:<userId>' */
  recipient:     string
  action:        'sent' | 'failed' | 'skipped'
  resendId?:     string
  error?:        string
}

export interface EscalationRunResult {
  totalFollowups: number
  outcomes:       EscalationOutcome[]
  sent:           number
  failed:         number
  skipped:        number
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Runs one overdue follow-up escalation cycle.
 *
 * 1. Queries all non-resolved follow-ups whose due_at is in the past.
 * 2. For each follow-up, fetches location, audit date, and Red Flag items.
 * 3. Sends email to each recipient independently (idempotent via report_deliveries).
 * 4. Creates Kockpit notifications independently (idempotent via report_deliveries).
 *
 * Never throws — all errors are captured in the returned result.
 */
export async function runAuditFollowupEscalationJob(): Promise<EscalationRunResult> {
  const db  = createServiceClient()
  const now = new Date()

  // ── 1. Fetch overdue follow-ups ──────────────────────────────────────────
  const { data: followupRows, error: followupErr } = await db
    .from('audit_followups')
    .select(`
      id,
      submission_id,
      due_at,
      status,
      audit_submissions!submission_id (
        submitted_at,
        location_id,
        locations!location_id ( name )
      )
    `)
    .lt('due_at', now.toISOString())
    .neq('status', 'resolved')

  if (followupErr) {
    console.error('[followup-escalation] Follow-ups query failed:', followupErr.message)
    throw new Error(`Follow-ups query failed: ${followupErr.message}`)
  }

  if (!followupRows || followupRows.length === 0) {
    return { totalFollowups: 0, outcomes: [], sent: 0, failed: 0, skipped: 0 }
  }

  // ── 2. Fetch Red Flag responses for all overdue follow-ups ───────────────
  const followupIds = followupRows.map(r => r.id as string)

  const { data: responseRows } = await db
    .from('audit_followup_responses')
    .select(`
      followup_id,
      result,
      audit_checkpoints!checkpoint_id ( title, section, is_red_flag )
    `)
    .in('followup_id', followupIds)

  // Group responses by followup_id, keeping only Red Flag checkpoints
  const responsesByFollowup = new Map<string, Array<{ title: string; section: string; result: 'pass' | 'fail' | null }>>()
  for (const row of responseRows ?? []) {
    const cp = row.audit_checkpoints as unknown as { title: string; section: string; is_red_flag: boolean } | null
    if (!cp?.is_red_flag) continue
    const fid = row.followup_id as string
    if (!responsesByFollowup.has(fid)) responsesByFollowup.set(fid, [])
    responsesByFollowup.get(fid)!.push({
      title:   cp.title,
      section: cp.section,
      result:  (row.result as 'pass' | 'fail' | null) ?? null,
    })
  }

  // ── 3. Process each follow-up ────────────────────────────────────────────
  const allOutcomes: EscalationOutcome[] = []

  for (const followup of followupRows) {
    const followupId   = followup.id as string
    const submissionId = followup.submission_id as string
    const dueAt        = followup.due_at as string

    const sub         = followup.audit_submissions as unknown as {
      submitted_at: string
      locations: { name: string } | null
    } | null

    const locationName = sub?.locations?.name ?? '—'
    const auditDateStr = sub?.submitted_at
      ? new Date(sub.submitted_at).toLocaleDateString('en-GB', {
          day: 'numeric', month: 'short', year: 'numeric',
        })
      : '—'

    const redFlagItems = responsesByFollowup.get(followupId) ?? []

    // Determine all email recipients for this location
    const emailRecipients = buildAllEmailRecipients(locationName)
    const notifyEmails    = buildAllNotifyEmails(locationName)

    // Resolve display names for email recipients
    let recipientNameMap: Map<string, string>
    try {
      recipientNameMap = await resolveRecipientNames(emailRecipients, db)
    } catch (err) {
      console.error(`[followup-escalation] Name resolution failed for followup ${followupId}:`, err)
      recipientNameMap = new Map()
    }

    // ── Email channels ────────────────────────────────────────────────────
    for (const email of emailRecipients) {
      const { data: existing } = await db
        .from('report_deliveries')
        .select('id')
        .eq('report_type', REPORT_TYPE)
        .eq('submission_key', followupId)
        .eq('recipient', email)
        .in('status', ['sent', 'skipped'])
        .maybeSingle()

      if (existing) {
        allOutcomes.push({ followupId, submissionId, locationName, recipient: email, action: 'skipped' })
        continue
      }

      const result = await sendAuditFollowupEscalationEmail({
        submissionId,
        locationName,
        auditDateStr,
        followupDueAt:  dueAt,
        redFlagItems,
        recipientEmail: email,
        recipientName:  recipientNameMap.get(email) ?? email,
      })

      const { error: insertErr } = await db.from('report_deliveries').insert({
        report_type:    REPORT_TYPE,
        submission_key: followupId,
        recipient:      email,
        status:         result.ok ? 'sent' : 'failed',
        resend_id:      result.ok ? result.id : null,
        error:          result.ok ? null : result.error,
        sent_at:        result.ok ? new Date().toISOString() : null,
      })
      if (insertErr && insertErr.code !== '23505') {
        console.error(`[followup-escalation] Failed to record email delivery (${email}):`, insertErr.message)
      }

      if (result.ok) {
        console.log(`[followup-escalation] Email → ${email} (followup ${followupId}, resend ${result.id})`)
        allOutcomes.push({ followupId, submissionId, locationName, recipient: email, action: 'sent', resendId: result.id })
      } else {
        console.error(`[followup-escalation] Email → ${email} failed:`, result.error)
        allOutcomes.push({ followupId, submissionId, locationName, recipient: email, action: 'failed', error: result.error })
      }
    }

    // ── Notification channels ─────────────────────────────────────────────
    let userMap: Map<string, string>
    try {
      userMap = await resolveUsersByEmail(notifyEmails)
    } catch (err) {
      console.error(`[followup-escalation] User resolution failed for followup ${followupId}:`, err)
      continue
    }

    const metadata = {
      location:        locationName,
      audit_date:      auditDateStr,
      followup_due_at: dueAt,
      red_flag_count:  redFlagItems.length,
    }

    for (const [userEmail, userId] of userMap) {
      const notifResult = await createSystemNotificationIdempotent({
        reportType:    REPORT_TYPE,
        submissionKey: followupId,
        userId,
        type:          'audit.followup.overdue',
        entityType:    'audit_submission',
        entityId:      submissionId,
        metadata,
      }).catch(err => {
        console.error(`[followup-escalation] Notification for ${userEmail} threw:`, err)
        return 'failed' as const
      })

      const recipientKey = `notification:${userId}`
      console.log(`[followup-escalation] Notification → ${userEmail} (${userId}): ${notifResult}`)
      allOutcomes.push({ followupId, submissionId, locationName, recipient: recipientKey, action: notifResult })
    }
  }

  return {
    totalFollowups: followupRows.length,
    outcomes:       allOutcomes,
    sent:    allOutcomes.filter(o => o.action === 'sent').length,
    failed:  allOutcomes.filter(o => o.action === 'failed').length,
    skipped: allOutcomes.filter(o => o.action === 'skipped').length,
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Resolves email → display_name for the given recipient emails.
 * Falls back to the email itself when no display_name is found.
 */
async function resolveRecipientNames(
  emails: string[],
  db: ReturnType<typeof createServiceClient>,
): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map()

  const { data } = await db
    .from('app_users')
    .select('email, display_name')
    .in('email', emails)

  const map = new Map<string, string>()
  for (const row of data ?? []) {
    map.set(row.email, (row.display_name as string | null) ?? row.email)
  }
  return map
}
