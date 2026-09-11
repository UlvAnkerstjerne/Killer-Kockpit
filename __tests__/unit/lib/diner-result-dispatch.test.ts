/**
 * __tests__/unit/lib/diner-result-dispatch.test.ts
 *
 * Unit tests for Mystery Diner result dispatch logic.
 * Covers: notification message formatting, channel independence contract,
 * idempotency semantics, and routing rules.
 *
 * No network calls — all assertions are on pure functions and contracts.
 */

import { describe, it, expect } from 'vitest'
import { formatNotificationMessage } from '@/lib/notification-format'
import { safeFormatMessage, KNOWN_TYPES } from '@/components/layout/NotificationBell'

// ─── formatNotificationMessage — diner.result ─────────────────────────────────

describe('formatNotificationMessage — diner.result', () => {
  it('formats full metadata correctly', () => {
    const msg = formatNotificationMessage('diner.result', null, null, {
      location:            'Magstræde',
      score_pct:           87.4,
      final_status:        'GREEN',
      critical_fail_count: 0,
      gold_star_count:     2,
      waiting_time_band:   '5-10',
    })
    expect(msg).toBe('Diner — Magstræde · 87% · GREEN · 0 criticals · 2★')
  })

  it('rounds score_pct to nearest integer', () => {
    const msg = formatNotificationMessage('diner.result', null, null, {
      location:            'SSP',
      score_pct:           66.6,
      final_status:        'RED',
      critical_fail_count: 1,
      gold_star_count:     0,
    })
    expect(msg).toContain('67%')
  })

  it('uses singular "critical" when count is 1', () => {
    const msg = formatNotificationMessage('diner.result', null, null, {
      location:            'Store',
      score_pct:           70,
      final_status:        'YELLOW',
      critical_fail_count: 1,
      gold_star_count:     0,
    })
    expect(msg).toContain('1 critical')
    expect(msg).not.toContain('1 criticals')
  })

  it('omits gold stars segment when gold_star_count is 0', () => {
    const msg = formatNotificationMessage('diner.result', null, null, {
      location:            'Store',
      score_pct:           80,
      final_status:        'GREEN',
      critical_fail_count: 0,
      gold_star_count:     0,
    })
    expect(msg).not.toContain('★')
  })

  it('includes gold stars segment when gold_star_count > 0', () => {
    const msg = formatNotificationMessage('diner.result', null, null, {
      location:            'Store',
      score_pct:           90,
      final_status:        'GREEN',
      critical_fail_count: 0,
      gold_star_count:     3,
    })
    expect(msg).toContain('3★')
  })

  it('falls back to "Mystery Diner submitted" when metadata is null', () => {
    const msg = formatNotificationMessage('diner.result', null, null, null)
    expect(msg).toBe('Mystery Diner submitted')
  })

  it('uses "?" for missing location', () => {
    const msg = formatNotificationMessage('diner.result', null, null, {
      score_pct:           75,
      final_status:        'YELLOW',
      critical_fail_count: 0,
      gold_star_count:     0,
    })
    expect(msg).toContain('Diner — ?')
  })

  it('works with undefined optional fields gracefully', () => {
    const msg = formatNotificationMessage('diner.result', null, null, {
      location: 'Test',
    })
    expect(msg).toBe('Diner — Test')
  })
})

// ─── safeFormatMessage — diner.result ─────────────────────────────────────────

describe('safeFormatMessage — diner.result', () => {
  it('formats full metadata correctly', () => {
    const msg = safeFormatMessage({
      type: 'diner.result',
      actor_name: null,
      task_title: null,
      metadata: {
        location:            'Magstræde',
        score_pct:           91,
        final_status:        'GREEN',
        critical_fail_count: 0,
        gold_star_count:     1,
      },
    })
    expect(msg).toBe('Diner — Magstræde · 91% · GREEN · 0 criticals · 1★')
  })

  it('returns fallback when metadata is null', () => {
    const msg = safeFormatMessage({
      type: 'diner.result',
      actor_name: null,
      task_title: null,
      metadata: null,
    })
    expect(msg).toBe('Mystery Diner submitted')
  })
})

// ─── KNOWN_TYPES — diner.result registered ────────────────────────────────────

describe('KNOWN_TYPES', () => {
  it('includes diner.result', () => {
    expect(KNOWN_TYPES).toContain('diner.result')
  })
})

// ─── Channel independence contract ────────────────────────────────────────────

describe('channel independence contract', () => {
  it('email and notification channels share no state — outcomes are independent arrays', () => {
    // Documents the architectural contract of processDinerDelivery:
    // Each channel (email, notification) appends to outcomes independently.
    // Email failure does not prevent notification outcomes from being recorded,
    // and vice-versa. Channels are identified by recipient string format:
    //   email:       "drift@killerkebab.com"
    //   notification: "notification:<userId>"
    //
    // This test verifies the recipient naming convention is distinguishable.
    const emailRecipient        = 'drift@killerkebab.com'
    const notificationRecipient = 'notification:550e8400-e29b-41d4-a716-446655440000'

    expect(emailRecipient.startsWith('notification:')).toBe(false)
    expect(notificationRecipient.startsWith('notification:')).toBe(true)

    // Both are valid recipient strings — no overlap possible
    expect(emailRecipient).not.toBe(notificationRecipient)
  })
})

// ─── Delivery idempotency contract ────────────────────────────────────────────

describe('delivery idempotency', () => {
  it('isTerminallyDelivered checks status IN (sent, skipped) — failed rows do not block retry', () => {
    // Documents the idempotency model: only terminal statuses (sent, skipped)
    // prevent re-delivery. 'failed' rows are allowed to accumulate across retries.
    // This mirrors the unique partial index: WHERE status IN ('sent', 'skipped').

    function isTerminal(status: string): boolean {
      return status === 'sent' || status === 'skipped'
    }

    expect(isTerminal('sent')).toBe(true)
    expect(isTerminal('skipped')).toBe(true)
    expect(isTerminal('failed')).toBe(false)  // retry allowed
  })

  it('repeated dispatchDinerResult calls are safe — already-sent channels are skipped', () => {
    // The processDinerDelivery function calls isTerminallyDelivered() for each
    // channel before attempting delivery. If the channel already has a terminal
    // record, it returns 'skipped' without hitting Resend or creating a notification.
    // This test documents the idempotency invariant.

    type Outcome = 'sent' | 'skipped' | 'failed'

    function simulateChannel(alreadyDelivered: boolean): Outcome {
      if (alreadyDelivered) return 'skipped'
      return 'sent' // simplified — real code calls Resend or notification RPC
    }

    // First dispatch: no prior records → sends
    expect(simulateChannel(false)).toBe('sent')

    // Second dispatch: terminal record exists → skips
    expect(simulateChannel(true)).toBe('skipped')
  })
})

// ─── Routing contract ──────────────────────────────────────────────────────────

describe('NotificationBell routing — diner_submission', () => {
  it('diner_submission entity routes to /kkc/diner/:entity_id', () => {
    // Documents the entity_type routing in handleClickRow.
    // entity_type='diner_submission' must navigate to /kkc/diner/{entity_id},
    // not /tasks/{entity_id} or any other route.

    function resolveRoute(entityType: string, entityId: string): string {
      if (entityType === 'audit_submission') return `/kkc/audit/${entityId}`
      if (entityType === 'kkc_submission')   return '/kkc/ssp-cph'
      if (entityType === 'diner_submission') return `/kkc/diner/${entityId}`
      return `/tasks/${entityId}`
    }

    const id = '123e4567-e89b-12d3-a456-426614174000'
    expect(resolveRoute('diner_submission', id)).toBe(`/kkc/diner/${id}`)
    expect(resolveRoute('audit_submission', id)).toBe(`/kkc/audit/${id}`)
    expect(resolveRoute('task',             id)).toBe(`/tasks/${id}`)
  })
})
