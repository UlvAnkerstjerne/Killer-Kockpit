/**
 * lib/notification-format.ts — pure, client-safe notification helpers
 *
 * Separated from lib/actions/notifications.ts ('use server') so that
 * client components can import the presentation logic without violating
 * Next.js's rule that all exports from 'use server' files must be async.
 */

export type NotificationType =
  | 'task.assigned'
  | 'task.submitted_for_review'
  | 'task.sent_back'
  | 'task.approved'
  | 'audit.result'
  | 'kkc.result'

/**
 * Derives a concise human-readable notification message.
 *
 * For task types:
 *   actor  — display name of the actor, or a fallback when unknown
 *   title  — current task title, or a fallback when unavailable
 *
 * For system types (audit.result, kkc.result):
 *   metadata — structured data stored at creation time
 *
 * Examples:
 *   task.assigned             → "Adam assigned you "Film videos for SSP""
 *   task.submitted_for_review → "Adam submitted "Film videos for SSP" for your review"
 *   task.sent_back            → "Ulv sent "Film videos for SSP" back to you"
 *   task.approved             → "Ulv approved "Film videos for SSP""
 *   audit.result              → "Audit — Magstræde · 87% overall · 91% core · 0 red flags · GREEN"
 *   kkc.result                → "KQC — SSP/CPH · 92% overall · 95% critical · 0 failures"
 */
export function formatNotificationMessage(
  type:      NotificationType,
  actorName: string | null,
  taskTitle: string | null,
  metadata?: Record<string, unknown> | null,
): string {
  const actor = actorName ?? 'Someone'
  const title = taskTitle ?? 'a task'

  switch (type) {
    case 'task.assigned':             return `${actor} assigned you "${title}"`
    case 'task.submitted_for_review': return `${actor} submitted "${title}" for your review`
    case 'task.sent_back':            return `${actor} sent "${title}" back to you`
    case 'task.approved':             return `${actor} approved "${title}"`

    case 'audit.result': {
      if (!metadata) return 'Audit submitted'
      const loc    = (metadata.location as string | undefined) ?? '?'
      const ovr    = metadata.overall_pct   as number | undefined
      const core   = metadata.core_pct      as number | undefined
      const rf     = metadata.red_flag_count as number | undefined
      const status = metadata.audit_status  as string | undefined
      const parts  = [`Audit — ${loc}`]
      if (ovr   !== undefined) parts.push(`${ovr}% overall`)
      if (core  !== undefined) parts.push(`${core}% core`)
      if (rf    !== undefined) parts.push(`${rf} red flag${rf === 1 ? '' : 's'}`)
      if (status)              parts.push(status)
      return parts.join(' · ')
    }

    case 'kkc.result': {
      if (!metadata) return 'KQC submitted'
      const ovr  = metadata.overall_score    as number | undefined
      const crit = metadata.critical_score   as number | undefined
      const fail = metadata.critical_failures as number | undefined
      const parts = ['KQC — SSP/CPH']
      if (ovr  !== undefined) parts.push(`${ovr}% overall`)
      if (crit !== undefined) parts.push(`${crit}% critical`)
      if (fail !== undefined) parts.push(`${fail} failure${fail === 1 ? '' : 's'}`)
      return parts.join(' · ')
    }
  }
}
