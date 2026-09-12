/**
 * lib/reports/dispatch-task-overdue.ts
 *
 * Staged overdue-task email reminder checker.
 *
 * For every incomplete assigned task with a past due date, up to 4 reminder
 * emails are sent to the current assignee:
 *   Stage   0h — at the moment the deadline passes
 *   Stage  24h — 24 hours after the deadline
 *   Stage  48h — 48 hours after the deadline
 *   Stage  72h — 72 hours after the deadline (final)
 *
 * Idempotency:
 *   submission_key = '{taskId}:{dueAt}:{stageHours}'
 *   report_type    = 'task_overdue_reminder'
 *   recipient      = assignee email address
 *   Terminal records (sent/skipped) in report_deliveries prevent re-delivery.
 *
 * Due-date episode model:
 *   The due_at value is embedded in the submission key.  When a deadline moves,
 *   old stage records are silently abandoned — they will never match the new
 *   due_at.  The new due date starts a fresh sequence automatically.
 *
 * Tasks stop receiving reminders when:
 *   - status = 'done' or 'cancelled'
 *   - completed_at IS NOT NULL
 *   - archived_at IS NOT NULL
 *
 * Server-only — never import from client components.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { sendTaskOverdueEmail } from './send-task-overdue-email'

// ─── Constants ────────────────────────────────────────────────────────────────

const REPORT_TYPE  = 'task_overdue_reminder' as const

/** Hours-after-deadline for each reminder stage.  Order is ascending. */
export const OVERDUE_STAGE_HOURS = [0, 24, 48, 72] as const

// ─── Helpers (exported for unit tests) ───────────────────────────────────────

/**
 * Builds the idempotency key for one (task, due-date-episode, stage) triple.
 * Embedding the due_at ISO string ensures a changed deadline starts a new
 * episode without any explicit cancellation.
 */
export function buildSubmissionKey(
  taskId:     string,
  dueAt:      string,
  stageHours: number,
): string {
  return `${taskId}:${dueAt}:${stageHours}`
}

/**
 * Returns the subset of OVERDUE_STAGE_HOURS whose threshold has been reached
 * relative to `now`.  Thresholds are inclusive (>=).
 *
 * @param dueAt ISO timestamptz — the task's due_at
 * @param now   Current moment (injectable for deterministic tests)
 */
export function getEligibleStages(dueAt: string, now: Date): readonly number[] {
  const dueMs = new Date(dueAt).getTime()
  return OVERDUE_STAGE_HOURS.filter(hours => now.getTime() >= dueMs + hours * 3_600_000)
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface OverdueCandidate {
  taskId:      string
  title:       string
  dueAt:       string
  stageHours:  number
  ownerEmail:  string
  ownerName:   string
  projectName: string | null
}

export interface TaskOverdueReminderResult {
  totalTasks: number
  sent:       number
  failed:     number
  skipped:    number
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Runs one overdue-reminder cycle.
 *
 * 1. Queries all incomplete tasks that are past their due date.
 * 2. Determines which stages are now due for each task.
 * 3. Batch-checks report_deliveries for already-delivered stages.
 * 4. Sends only the undelivered stages, recording each outcome.
 *
 * Never throws — errors are captured in the returned result.
 */
export async function runTaskOverdueReminderJob(
  _now?: Date,  // injectable for tests; defaults to current time
): Promise<TaskOverdueReminderResult> {
  const now = _now ?? new Date()
  const db  = createServiceClient()

  // ── 1. Fetch overdue tasks ────────────────────────────────────────────────
  const { data: taskRows, error: taskErr } = await db
    .from('tasks')
    .select('id, title, due_at, owner_user_id, projects(name)')
    .not('owner_user_id', 'is', null)
    .not('due_at', 'is', null)
    .lt('due_at', now.toISOString())
    .neq('status', 'done')
    .neq('status', 'cancelled')
    .is('completed_at', null)
    .is('archived_at', null)

  if (taskErr) {
    console.error('[task-overdue] Tasks query failed:', taskErr.message)
    throw new Error(`Tasks query failed: ${taskErr.message}`)
  }

  if (!taskRows || taskRows.length === 0) {
    return { totalTasks: 0, sent: 0, failed: 0, skipped: 0 }
  }

  // ── 2. Batch-resolve assignees ────────────────────────────────────────────
  const ownerIds = [...new Set(taskRows.map(t => t.owner_user_id as string))]
  const { data: userRows } = await db
    .from('app_users')
    .select('id, email, display_name')
    .in('id', ownerIds)

  const userMap = new Map(
    (userRows ?? []).map(u => [u.id as string, u as { id: string; email: string; display_name: string | null }])
  )

  // ── 3. Build candidates ───────────────────────────────────────────────────
  const candidates: OverdueCandidate[] = []
  for (const task of taskRows) {
    const dueAt   = task.due_at as string
    const owner   = userMap.get(task.owner_user_id as string)
    if (!owner) {
      console.warn(`[task-overdue] No user found for owner_user_id ${task.owner_user_id} (task ${task.id}) — skipped`)
      continue
    }

    const projectName = (task.projects as unknown as { name: string } | null)?.name ?? null
    const stages      = getEligibleStages(dueAt, now)

    for (const stageHours of stages) {
      candidates.push({
        taskId:      task.id as string,
        title:       task.title as string,
        dueAt,
        stageHours,
        ownerEmail:  owner.email,
        ownerName:   owner.display_name ?? owner.email,
        projectName,
      })
    }
  }

  if (candidates.length === 0) {
    return { totalTasks: taskRows.length, sent: 0, failed: 0, skipped: 0 }
  }

  // ── 4. Batch-check already-delivered stages ───────────────────────────────
  const allKeys = candidates.map(c => buildSubmissionKey(c.taskId, c.dueAt, c.stageHours))

  const { data: delivered } = await db
    .from('report_deliveries')
    .select('submission_key, recipient')
    .eq('report_type', REPORT_TYPE)
    .in('submission_key', allKeys)
    .in('status', ['sent', 'skipped'])

  // Combine key + recipient for O(1) lookup (mirrors the unique index columns)
  const deliveredSet = new Set(
    (delivered ?? []).map(d => `${d.submission_key as string}|${d.recipient as string}`)
  )

  // ── 5. Send undelivered stages ────────────────────────────────────────────
  let sent = 0, failed = 0, skipped = 0

  for (const item of candidates) {
    const subKey    = buildSubmissionKey(item.taskId, item.dueAt, item.stageHours)
    const dedupeKey = `${subKey}|${item.ownerEmail}`

    if (deliveredSet.has(dedupeKey)) {
      skipped++
      continue
    }

    const result = await sendTaskOverdueEmail({
      taskId:      item.taskId,
      title:       item.title,
      dueAt:       item.dueAt,
      stageHours:  item.stageHours,
      ownerEmail:  item.ownerEmail,
      ownerName:   item.ownerName,
      projectName: item.projectName,
    })

    if (result.ok) {
      const { error: insertErr } = await db.from('report_deliveries').insert({
        report_type:    REPORT_TYPE,
        submission_key: subKey,
        recipient:      item.ownerEmail,
        status:         'sent',
        resend_id:      result.id,
        sent_at:        new Date().toISOString(),
      })
      // 23505 = concurrent run already recorded the same terminal row — safe to ignore
      if (insertErr && insertErr.code !== '23505') {
        console.error(`[task-overdue] Failed to record sent delivery for task ${item.taskId}:`, insertErr.message)
      }
      console.log(`[task-overdue] Stage ${item.stageHours}h sent → ${item.ownerEmail} (task ${item.taskId})`)
      sent++
    } else {
      await db.from('report_deliveries').insert({
        report_type:    REPORT_TYPE,
        submission_key: subKey,
        recipient:      item.ownerEmail,
        status:         'failed',
        error:          result.error,
      })
      console.error(`[task-overdue] Stage ${item.stageHours}h failed for task ${item.taskId}: ${result.error}`)
      failed++
    }
  }

  return { totalTasks: taskRows.length, sent, failed, skipped }
}
