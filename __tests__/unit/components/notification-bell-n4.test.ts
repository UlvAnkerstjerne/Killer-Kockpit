/**
 * __tests__/unit/components/notification-bell-n4.test.ts — N4 pure-helper tests
 *
 * Environment: Node (vitest.config.ts sets environment: 'node').
 * No jsdom / testing-library. Tests cover only the exported pure helpers from
 * NotificationBell.tsx. The React component itself requires a browser.
 *
 * Component-level behaviours verified by implementation (not unit-testable here):
 *   - Notifications row appears in primary nav directly below Today
 *   - Old bottom placement removed (no second NotificationBell in AppShell)
 *   - Bell icon and "Notifications" label visible in nav row
 *   - Full sidebar row is clickable (button wraps entire row)
 *   - Click opens portal popover rendered in document.body with position:fixed
 *     (escapes nav overflow-y:auto clipping that made the old absolute popover invisible)
 *   - Popover position computed from sidebar right edge via getBoundingClientRect()
 *   - Zero-notification state: click still opens panel (shows "No notifications yet.")
 *   - outside-click checks both containerRef and popoverRef (separate DOM trees)
 *   - count fetch fires immediately on mount (fetchCount() called before setInterval)
 *   - interval cleans up on unmount (clearInterval in useEffect return)
 *   - visibilitychange listener cleans up on unmount (removeEventListener in return)
 *   - overlapping count requests suppressed (fetchingCountRef guard in fetchCount)
 *   - full recent list NOT polled every 60 s (getRecentNotifications only in fetchList)
 *   - mark-read and mark-all behaviour unchanged
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  badgeLabel,
  relativeTime,
  safeFormatMessage,
  shouldDecrement,
  shouldRefreshOnVisibility,
  POLL_INTERVAL_MS,
  KNOWN_TYPES,
} from '@/components/layout/NotificationBell'
import type {} from '@/lib/actions/notifications'

// ─── Constants ────────────────────────────────────────────────────────────────

describe('POLL_INTERVAL_MS', () => {
  it('is 60 seconds', () => {
    expect(POLL_INTERVAL_MS).toBe(60_000)
  })

  it('is not 30 seconds (regression: was halved from 30s to avoid excess polling)', () => {
    expect(POLL_INTERVAL_MS).not.toBe(30_000)
  })
})

describe('KNOWN_TYPES', () => {
  it('contains exactly the four task lifecycle types', () => {
    expect([...KNOWN_TYPES].sort()).toEqual([
      'task.approved',
      'task.assigned',
      'task.sent_back',
      'task.submitted_for_review',
    ])
  })
})

// ─── badgeLabel ───────────────────────────────────────────────────────────────

describe('badgeLabel', () => {
  it('returns null for 0', () => {
    expect(badgeLabel(0)).toBeNull()
  })

  it('returns null for negative numbers', () => {
    expect(badgeLabel(-1)).toBeNull()
    expect(badgeLabel(-100)).toBeNull()
  })

  it('returns exact count for 1–9', () => {
    for (let i = 1; i <= 9; i++) {
      expect(badgeLabel(i)).toBe(String(i))
    }
  })

  it('returns "9+" for 10', () => {
    expect(badgeLabel(10)).toBe('9+')
  })

  it('returns "9+" for counts above 10', () => {
    expect(badgeLabel(99)).toBe('9+')
    expect(badgeLabel(1000)).toBe('9+')
  })
})

// ─── relativeTime ─────────────────────────────────────────────────────────────

describe('relativeTime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function freeze(now: number) {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  }

  const BASE = new Date('2024-06-15T12:00:00Z').getTime()

  it('returns "Just now" for < 60 seconds ago', () => {
    freeze(BASE)
    const date = new Date(BASE - 30_000).toISOString()
    expect(relativeTime(date)).toBe('Just now')
  })

  it('returns "Just now" for 0 seconds ago', () => {
    freeze(BASE)
    expect(relativeTime(new Date(BASE).toISOString())).toBe('Just now')
  })

  it('returns minutes for 1–59 minutes ago', () => {
    freeze(BASE)
    expect(relativeTime(new Date(BASE - 60_000).toISOString())).toBe('1m')
    expect(relativeTime(new Date(BASE - 45 * 60_000).toISOString())).toBe('45m')
    expect(relativeTime(new Date(BASE - 59 * 60_000).toISOString())).toBe('59m')
  })

  it('returns hours for 1–23 hours ago', () => {
    freeze(BASE)
    expect(relativeTime(new Date(BASE - 3600_000).toISOString())).toBe('1h')
    expect(relativeTime(new Date(BASE - 10 * 3600_000).toISOString())).toBe('10h')
    expect(relativeTime(new Date(BASE - 23 * 3600_000).toISOString())).toBe('23h')
  })

  it('returns "Yesterday" for exactly 1 day ago', () => {
    freeze(BASE)
    expect(relativeTime(new Date(BASE - 24 * 3600_000).toISOString())).toBe('Yesterday')
  })

  it('returns days for 2–6 days ago', () => {
    freeze(BASE)
    expect(relativeTime(new Date(BASE - 2 * 86400_000).toISOString())).toBe('2d')
    expect(relativeTime(new Date(BASE - 6 * 86400_000).toISOString())).toBe('6d')
  })

  it('returns a short absolute date for 7+ days ago', () => {
    freeze(BASE)
    const sevenDaysAgo = new Date(BASE - 7 * 86400_000).toISOString()
    const result = relativeTime(sevenDaysAgo)
    // Should be a short date string, not a relative token
    expect(result).not.toMatch(/^(\d+[mhd]|Yesterday|Just now)$/)
    expect(result.length).toBeGreaterThan(0)
  })
})

// ─── safeFormatMessage ────────────────────────────────────────────────────────

describe('safeFormatMessage', () => {
  it('formats task.assigned with actor and title', () => {
    const result = safeFormatMessage({
      type: 'task.assigned',
      actor_name: 'Alice',
      task_title: 'Fix the bug',
    })
    expect(result).toContain('Alice')
    expect(result).toContain('Fix the bug')
  })

  it('formats task.submitted_for_review', () => {
    const result = safeFormatMessage({
      type: 'task.submitted_for_review',
      actor_name: 'Bob',
      task_title: 'Deploy feature',
    })
    expect(result).toContain('Bob')
  })

  it('formats task.approved', () => {
    const result = safeFormatMessage({
      type: 'task.approved',
      actor_name: 'Carol',
      task_title: 'Review docs',
    })
    expect(result).toContain('Carol')
  })

  it('formats task.sent_back', () => {
    const result = safeFormatMessage({
      type: 'task.sent_back',
      actor_name: 'Dave',
      task_title: 'Update report',
    })
    expect(result).toContain('Dave')
  })

  it('falls back to generic message for unknown type', () => {
    const result = safeFormatMessage({
      type: 'task.unknown_future_type' as never,
      actor_name: 'Eve',
      task_title: 'Something',
    })
    expect(result).toBe('Eve updated a task')
  })

  it('uses "Someone" when actor_name is null for unknown type', () => {
    const result = safeFormatMessage({
      type: 'task.unknown_future_type' as never,
      actor_name: null,
      task_title: 'Something',
    })
    expect(result).toBe('Someone updated a task')
  })

  it('handles null actor_name for known types', () => {
    const result = safeFormatMessage({
      type: 'task.assigned',
      actor_name: null,
      task_title: 'Fix the bug',
    })
    // Should not throw; result is a non-empty string
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('handles null task_title for known types', () => {
    const result = safeFormatMessage({
      type: 'task.assigned',
      actor_name: 'Alice',
      task_title: null,
    })
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})

// ─── shouldDecrement ──────────────────────────────────────────────────────────

describe('shouldDecrement', () => {
  const notif = (read_at: string | null, id = 'aaaaaaaa-0000-4000-8000-000000000001') => ({
    read_at,
    id,
  })

  it('returns true when read_at is null and id is not in localReadIds', () => {
    expect(shouldDecrement(notif(null), new Set())).toBe(true)
  })

  it('returns false when read_at is non-null (server-read)', () => {
    expect(shouldDecrement(notif('2024-01-01T00:00:00Z'), new Set())).toBe(false)
  })

  it('returns false when id is in localReadIds (optimistic-read)', () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001'
    expect(shouldDecrement(notif(null, id), new Set([id]))).toBe(false)
  })

  it('returns false when both server-read and local-read', () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001'
    expect(shouldDecrement(notif('2024-01-01T00:00:00Z', id), new Set([id]))).toBe(false)
  })

  it('returns true when a different id is in localReadIds', () => {
    const otherId = 'bbbbbbbb-0000-4000-8000-000000000002'
    expect(shouldDecrement(notif(null), new Set([otherId]))).toBe(true)
  })
})

// ─── shouldRefreshOnVisibility ────────────────────────────────────────────────

describe('shouldRefreshOnVisibility', () => {
  it('returns true when visibilityState is "visible"', () => {
    expect(shouldRefreshOnVisibility('visible')).toBe(true)
  })

  it('returns false when visibilityState is "hidden"', () => {
    expect(shouldRefreshOnVisibility('hidden')).toBe(false)
  })

  it('returns false for other states (e.g. "prerender")', () => {
    expect(shouldRefreshOnVisibility('prerender')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(shouldRefreshOnVisibility('')).toBe(false)
  })
})
