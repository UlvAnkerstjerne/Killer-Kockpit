'use server'

/**
 * lib/actions/notifications.ts — N2 notification substrate
 *
 * Four server actions covering the read side of in-app notifications:
 *   getUnreadNotificationCount  — badge count
 *   getRecentNotifications      — popover list (max 20, enriched)
 *   markNotificationRead        — click a notification row
 *   markAllNotificationsRead    — "Mark all as read" button
 *
 * Write side (notification creation) is N3 — task lifecycle hooks.
 *
 * Security:
 *   All actions derive the current user from getCurrentUser() server-side.
 *   No user id is accepted from the caller.
 *   Authenticated Supabase client only (createClient) — RLS enforces
 *   own-row isolation on SELECT; read-state mutations go through
 *   SECURITY DEFINER RPCs that repeat the own-row check at the DB layer.
 */

import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import type { ActionResult } from '@/lib/types'

// ─── Loose UUID validation ─────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Types ─────────────────────────────────────────────────────────────────

export type NotificationType =
  | 'task.assigned'
  | 'task.submitted_for_review'
  | 'task.sent_back'
  | 'task.approved'

export interface AppNotification {
  id:            string
  type:          NotificationType
  entity_type:   string
  entity_id:     string
  created_at:    string
  read_at:       string | null
  actor_user_id: string | null
  /** Display name of the actor, or null if actor was deleted / unavailable */
  actor_name:    string | null
  /** Current title of the referenced task, or null if task unavailable */
  task_title:    string | null
}

// ─── Pure presentation helper (exported for testing / UI) ──────────────────

/**
 * Derives a concise human-readable notification message.
 * No database terminology exposed.
 *
 * actor  — display name of the actor, or a fallback when unknown
 * title  — current task title, or a fallback when unavailable
 *
 * Examples:
 *   task.assigned            → "Adam assigned you "Film videos for SSP""
 *   task.submitted_for_review → "Adam submitted "Film videos for SSP" for your review"
 *   task.sent_back           → "Ulv sent "Film videos for SSP" back to you"
 *   task.approved            → "Ulv approved "Film videos for SSP""
 */
export function formatNotificationMessage(
  type:      NotificationType,
  actorName: string | null,
  taskTitle: string | null,
): string {
  const actor = actorName ?? 'Someone'
  const title = taskTitle ?? 'a task'

  switch (type) {
    case 'task.assigned':
      return `${actor} assigned you "${title}"`
    case 'task.submitted_for_review':
      return `${actor} submitted "${title}" for your review`
    case 'task.sent_back':
      return `${actor} sent "${title}" back to you`
    case 'task.approved':
      return `${actor} approved "${title}"`
  }
}

// ─── getUnreadNotificationCount ────────────────────────────────────────────

/**
 * Returns the count of unread notifications for the authenticated user.
 * RLS ensures only own rows are counted.
 * Returns 0 if unauthenticated (rather than an error — safe for badge rendering).
 */
export async function getUnreadNotificationCount(): Promise<ActionResult<number>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const supabase = await createClient()

  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null)

  if (error) {
    console.error('[getUnreadNotificationCount]', error.message)
    return { error: 'Failed to load notification count.' }
  }

  return { data: count ?? 0 }
}

// ─── getRecentNotifications ────────────────────────────────────────────────

/**
 * Returns the 20 most recent notifications for the authenticated user,
 * enriched with actor display name and task title.
 *
 * Enrichment uses two batch queries (not N+1):
 *   1. app_users   — actor names for all distinct actor_user_ids
 *   2. tasks       — titles for all distinct entity_ids
 *
 * A notification is never dropped because actor or task is unavailable:
 *   - missing actor_user_id → actor_name = null (formatNotificationMessage falls back to "Someone")
 *   - task deleted/inaccessible → task_title = null (falls back to "a task")
 *
 * RLS enforces own-row isolation at the SELECT level.
 */
export async function getRecentNotifications(): Promise<ActionResult<AppNotification[]>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const supabase = await createClient()

  // ── 1. Fetch own notifications (RLS-gated) ─────────────────────────────
  const { data: rows, error: notifErr } = await supabase
    .from('notifications')
    .select('id, type, entity_type, entity_id, created_at, read_at, actor_user_id')
    .order('created_at', { ascending: false })
    .limit(20)

  if (notifErr) {
    console.error('[getRecentNotifications] notifications', notifErr.message)
    return { error: 'Failed to load notifications.' }
  }

  if (!rows || rows.length === 0) return { data: [] }

  // ── 2. Batch: actor display names ─────────────────────────────────────
  const actorIds = [...new Set(
    rows
      .map(r => r.actor_user_id)
      .filter((id): id is string => id !== null),
  )]

  const actorMap = new Map<string, string>()
  if (actorIds.length > 0) {
    const { data: actors } = await supabase
      .from('app_users')
      .select('id, display_name')
      .in('id', actorIds)

    for (const a of actors ?? []) {
      actorMap.set(a.id, a.display_name)
    }
  }

  // ── 3. Batch: task titles ─────────────────────────────────────────────
  // For v1, entity_type is always 'task'.
  const taskIds = [...new Set(rows.map(r => r.entity_id))]

  const taskMap = new Map<string, string>()
  if (taskIds.length > 0) {
    const { data: tasks } = await supabase
      .from('tasks')
      .select('id, title')
      .in('id', taskIds)

    for (const t of tasks ?? []) {
      taskMap.set(t.id, t.title)
    }
  }

  // ── 4. Assemble result ─────────────────────────────────────────────────
  const result: AppNotification[] = rows.map(r => ({
    id:            r.id,
    type:          r.type as NotificationType,
    entity_type:   r.entity_type,
    entity_id:     r.entity_id,
    created_at:    r.created_at,
    read_at:       r.read_at,
    actor_user_id: r.actor_user_id,
    actor_name:    r.actor_user_id ? (actorMap.get(r.actor_user_id) ?? null) : null,
    task_title:    taskMap.get(r.entity_id) ?? null,
  }))

  return { data: result }
}

// ─── markNotificationRead ──────────────────────────────────────────────────

/**
 * Marks one notification as read via the mark_notification_read SECURITY DEFINER RPC.
 *
 * The RPC enforces:
 *   - caller is authenticated (get_my_app_user_id() != NULL)
 *   - only the caller's own row is modified
 *   - only read_at is changed (idempotent: COALESCE preserves first-read time)
 *
 * If the notification id does not belong to the caller, the RPC is a silent
 * no-op — no foreign row details are exposed.
 */
export async function markNotificationRead(notificationId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  if (!notificationId || !UUID_RE.test(notificationId)) {
    return { error: 'Invalid notification id.' }
  }

  const supabase = await createClient()

  const { error } = await supabase.rpc('mark_notification_read', {
    p_notification_id: notificationId,
  })

  if (error) {
    console.error('[markNotificationRead]', error.message)
    return { error: 'Failed to mark notification as read.' }
  }

  return { data: undefined }
}

// ─── markAllNotificationsRead ──────────────────────────────────────────────

/**
 * Marks all unread notifications as read for the current user.
 * Uses mark_all_notifications_read SECURITY DEFINER RPC.
 *
 * The RPC enforces:
 *   - caller is authenticated
 *   - only the caller's own unread rows are touched
 *   - already-read rows are not modified
 */
export async function markAllNotificationsRead(): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const supabase = await createClient()

  const { error } = await supabase.rpc('mark_all_notifications_read')

  if (error) {
    console.error('[markAllNotificationsRead]', error.message)
    return { error: 'Failed to mark all notifications as read.' }
  }

  return { data: undefined }
}
