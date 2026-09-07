'use client'

/**
 * components/layout/NotificationBell.tsx — N4 notification bell UI
 *
 * Placement: sidebar, directly above the user card.
 *
 * Features:
 *   - Bell button with unread badge (polling every 30 s, count-only)
 *   - Popover with recent notifications (fetched on open, not on poll)
 *   - Click row → optimistic mark-read + navigate to /tasks/[entity_id]
 *   - "Mark all as read" header action
 *   - Outside-click + Escape close
 *   - Accessible: aria-expanded, aria-haspopup, aria-label
 *
 * Pure helpers are exported so they can be tested in Node without jsdom.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  getUnreadNotificationCount,
  getRecentNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  type AppNotification,
} from '@/lib/actions/notifications'

// ─── Constants (exported for testing) ─────────────────────────────────────────

export const POLL_INTERVAL_MS = 30_000

export const KNOWN_TYPES = [
  'task.assigned',
  'task.submitted_for_review',
  'task.sent_back',
  'task.approved',
] as const

// ─── Pure helpers (exported for testing) ──────────────────────────────────────

/**
 * Returns the label for the unread badge, or null when count is zero.
 * 1–9 → exact number. 10+ → "9+".
 */
export function badgeLabel(count: number): string | null {
  if (count <= 0) return null
  if (count > 9) return '9+'
  return String(count)
}

/**
 * Compact relative timestamp.
 * < 1 min → "Just now"
 * < 1 h   → "Xm"
 * < 24 h  → "Xh"
 * 1 day   → "Yesterday"
 * < 7 d   → "Xd"
 * older   → short absolute (e.g. "7 Sep")
 */
export function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const secs  = Math.floor(diff / 1000)
  if (secs < 60)   return 'Just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60)   return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24)  return `${hours}h`
  const days  = Math.floor(hours / 24)
  if (days === 1)  return 'Yesterday'
  if (days < 7)    return `${days}d`
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/**
 * Derives notification copy from the row.
 * Falls back to a safe generic message for unknown types.
 * Null actor → "Someone". Null title → "a task".
 */
export function safeFormatMessage(
  n: Pick<AppNotification, 'type' | 'actor_name' | 'task_title'>,
): string {
  const actor = n.actor_name ?? 'Someone'
  const title = n.task_title ?? 'a task'
  switch (n.type) {
    case 'task.assigned':            return `${actor} assigned you "${title}"`
    case 'task.submitted_for_review': return `${actor} submitted "${title}" for your review`
    case 'task.sent_back':           return `${actor} sent "${title}" back to you`
    case 'task.approved':            return `${actor} approved "${title}"`
    default:                         return `${actor} updated a task`
  }
}

/**
 * Returns true when clicking the row should decrement the unread count.
 * False when the row is already read (server or local).
 */
export function shouldDecrement(
  n: Pick<AppNotification, 'read_at' | 'id'>,
  localReadIds: Set<string>,
): boolean {
  return n.read_at === null && !localReadIds.has(n.id)
}

// ─── SVG ──────────────────────────────────────────────────────────────────────

function IconBell() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <path d="M13 11H3l1-2V7a4 4 0 0 1 8 0v2l1 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <path d="M6.5 12a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M8 1v1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function NotificationBell() {
  const router       = useRouter()
  const containerRef = useRef<HTMLDivElement>(null)
  const mountedRef   = useRef(true)

  const [unreadCount,   setUnreadCount]   = useState(0)
  const [isOpen,        setIsOpen]        = useState(false)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [listStatus,    setListStatus]    = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [localReadIds,  setLocalReadIds]  = useState<Set<string>>(new Set())
  const [isMarkingAll,  setIsMarkingAll]  = useState(false)

  // Keep mounted ref accurate so async callbacks don't setState after unmount.
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // ── Unread count polling ─────────────────────────────────────────────────
  const fetchCount = useCallback(async () => {
    const result = await getUnreadNotificationCount()
    if (!mountedRef.current) return
    if (result.data !== undefined) setUnreadCount(result.data)
  }, [])

  useEffect(() => {
    fetchCount()
    const id = setInterval(fetchCount, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchCount])

  // ── Recent list (fetched only when popover opens) ────────────────────────
  const fetchList = useCallback(async () => {
    setListStatus('loading')
    const result = await getRecentNotifications()
    if (!mountedRef.current) return
    if (result.error) {
      setListStatus('error')
    } else {
      setNotifications(result.data ?? [])
      setLocalReadIds(new Set())
      setListStatus('success')
    }
  }, [])

  function handleToggle() {
    if (!isOpen) {
      setIsOpen(true)
      fetchList()
    } else {
      setIsOpen(false)
    }
  }

  // ── Outside click ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [isOpen])

  // ── Escape key ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen])

  // ── Click row: optimistic mark-read then navigate ────────────────────────
  function handleClickRow(n: AppNotification) {
    const wasUnread = shouldDecrement(n, localReadIds)

    // Optimistic local update
    setLocalReadIds(prev => new Set([...prev, n.id]))
    if (wasUnread) setUnreadCount(c => Math.max(0, c - 1))

    // Fire-and-forget: mark-read failure must not block navigation
    markNotificationRead(n.id)

    setIsOpen(false)
    router.push(`/tasks/${n.entity_id}`)
  }

  // ── Mark all as read ─────────────────────────────────────────────────────
  async function handleMarkAll() {
    if (isMarkingAll) return
    setIsMarkingAll(true)
    const result = await markAllNotificationsRead()
    if (!mountedRef.current) return
    if (!result.error) {
      setUnreadCount(0)
      setLocalReadIds(new Set(notifications.map(n => n.id)))
    }
    setIsMarkingAll(false)
  }

  const badge = badgeLabel(unreadCount)

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className="relative mx-3 mb-1">

      {/* ── Bell button ───────────────────────────────────────────────────── */}
      <button
        onClick={handleToggle}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className={[
          'flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-sm transition-colors',
          isOpen
            ? 'bg-kk-soft text-kk-ink'
            : 'text-kk-ink/60 hover:bg-kk-soft hover:text-kk-ink',
        ].join(' ')}
      >
        {/* Icon wrapper — badge is absolute-positioned relative to this span */}
        <span className={['relative', isOpen ? 'text-kk-ink' : 'text-kk-ink/50'].join(' ')}>
          <IconBell />
          {badge && (
            <span
              aria-hidden="true"
              className="absolute -top-1.5 -right-2 min-w-[14px] h-3.5 px-0.5 flex items-center justify-center rounded-full bg-kk-brand text-white text-[9px] font-bold leading-none"
            >
              {badge}
            </span>
          )}
        </span>

        <span className="flex-1 truncate">Notifications</span>

        {/* Secondary badge count in text — reinforces unread state */}
        {badge && (
          <span aria-hidden="true" className="text-[10px] font-bold text-kk-brand tabular-nums">
            {badge}
          </span>
        )}
      </button>

      {/* ── Popover ───────────────────────────────────────────────────────── */}
      {isOpen && (
        <div
          role="dialog"
          aria-label="Notifications"
          className={[
            'absolute bottom-0 left-full ml-2 z-50',
            'w-80 max-w-[calc(100vw-240px)]',                   // viewport-safe on narrow screens
            'bg-white border border-kk-line rounded-2xl shadow-xl',
            'flex flex-col max-h-[calc(100vh-80px)]',           // never taller than viewport
          ].join(' ')}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-kk-line shrink-0">
            <span className="text-sm font-semibold text-kk-ink">Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAll}
                disabled={isMarkingAll}
                className="text-[11px] text-kk-muted hover:text-kk-ink transition-colors disabled:opacity-50"
              >
                {isMarkingAll ? 'Marking…' : 'Mark all as read'}
              </button>
            )}
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1">

            {listStatus === 'loading' && (
              <p className="px-4 py-6 text-sm text-kk-muted text-center">Loading…</p>
            )}

            {listStatus === 'error' && (
              <p className="px-4 py-6 text-sm text-kk-muted text-center">
                Couldn't load notifications.
              </p>
            )}

            {listStatus === 'success' && notifications.length === 0 && (
              <p className="px-4 py-6 text-sm text-kk-muted text-center">
                No notifications yet.
              </p>
            )}

            {listStatus === 'success' && notifications.length > 0 && (
              <ul>
                {notifications.map(n => {
                  const isRead = n.read_at !== null || localReadIds.has(n.id)
                  return (
                    <li key={n.id}>
                      <button
                        onClick={() => handleClickRow(n)}
                        className={[
                          'w-full text-left px-4 py-3 flex gap-3 transition-colors',
                          'border-b border-kk-line last:border-b-0',
                          isRead ? 'hover:bg-kk-soft/60' : 'hover:bg-kk-soft',
                        ].join(' ')}
                      >
                        {/* Unread dot */}
                        <span className="mt-[7px] shrink-0 w-1.5 h-1.5" aria-hidden="true">
                          {!isRead && (
                            <span className="block w-1.5 h-1.5 rounded-full bg-kk-brand" />
                          )}
                        </span>

                        {/* Message + timestamp */}
                        <span className="flex-1 min-w-0">
                          <span className={[
                            'block text-sm leading-snug',
                            isRead ? 'text-kk-muted' : 'text-kk-ink',
                          ].join(' ')}>
                            {safeFormatMessage(n)}
                          </span>
                          <span className="block text-[11px] text-kk-muted mt-0.5">
                            {relativeTime(n.created_at)}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

          </div>
        </div>
      )}
    </div>
  )
}
