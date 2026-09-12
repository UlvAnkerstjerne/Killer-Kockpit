/**
 * __tests__/unit/lib/audit-followup-escalation.test.ts
 *
 * Unit tests for the overdue Red Flag follow-up escalation feature.
 * Covers: RM routing, recipient list construction, email subject/copy,
 * and notification message format.
 *
 * No network calls — all assertions are on pure exported functions.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveRegionManager,
  buildAllEmailRecipients,
  buildAllNotifyEmails,
} from '@/lib/reports/dispatch-audit-followup-escalation'
import {
  buildEscalationSubject,
  buildOverdueDays,
  formatFollowupDueDate,
} from '@/lib/reports/send-audit-followup-escalation-email'
import { formatNotificationMessage } from '@/lib/notification-format'
import { AUDIT_FOLLOWUP_ESCALATION } from '@/lib/reports/delivery-config'

// ─── resolveRegionManager ─────────────────────────────────────────────────────

describe('resolveRegionManager', () => {
  it('returns Lydia for Borgergade', () => {
    expect(resolveRegionManager('Killer Kebab Borgergade')).toBe('lydia@killerkebab.com')
  })

  it('returns Lydia for Christianshavn', () => {
    expect(resolveRegionManager('Killer Kebab Christianshavn')).toBe('lydia@killerkebab.com')
  })

  it('returns Lydia for Nørrebro', () => {
    expect(resolveRegionManager('Killer Kebab Nørrebro')).toBe('lydia@killerkebab.com')
  })

  it('returns Lydia for Frederiksberg', () => {
    expect(resolveRegionManager('Killer Kebab Frederiksberg')).toBe('lydia@killerkebab.com')
  })

  it('returns Sara for Vesterbro', () => {
    expect(resolveRegionManager('Killer Kebab Vesterbro')).toBe('sara@killerkebab.com')
  })

  it('returns Sara for Fisketorvet', () => {
    expect(resolveRegionManager('Killer Kebab Fisketorvet')).toBe('sara@killerkebab.com')
  })

  it('returns Sara for Parken', () => {
    expect(resolveRegionManager('Killer Kebab Parken')).toBe('sara@killerkebab.com')
  })

  it('returns null for Copenhagen Airport (no RM assigned)', () => {
    expect(resolveRegionManager('Killer Kebab Copenhagen Airport')).toBeNull()
  })

  it('returns null for an unknown location', () => {
    expect(resolveRegionManager('Unknown Location')).toBeNull()
  })
})

// ─── buildAllEmailRecipients ──────────────────────────────────────────────────

describe('buildAllEmailRecipients', () => {
  it('includes Kasper and Ulv for every location', () => {
    const recipients = buildAllEmailRecipients('Killer Kebab Borgergade')
    expect(recipients).toContain('drift@killerkebab.com')
    expect(recipients).toContain('ulv@killerkebab.com')
  })

  it('includes RM for a Lydia location', () => {
    const recipients = buildAllEmailRecipients('Killer Kebab Christianshavn')
    expect(recipients).toContain('lydia@killerkebab.com')
    expect(recipients).toHaveLength(3)
  })

  it('includes RM for a Sara location', () => {
    const recipients = buildAllEmailRecipients('Killer Kebab Vesterbro')
    expect(recipients).toContain('sara@killerkebab.com')
    expect(recipients).toHaveLength(3)
  })

  it('does not include RM for Copenhagen Airport (no RM configured)', () => {
    const recipients = buildAllEmailRecipients('Killer Kebab Copenhagen Airport')
    expect(recipients).not.toContain('lydia@killerkebab.com')
    expect(recipients).not.toContain('sara@killerkebab.com')
    expect(recipients).toHaveLength(2)  // only fixed
  })

  it('produces no duplicates when RM is already in the fixed list', () => {
    // Sanity check: fixed list is Kasper + Ulv; neither is an RM so no real collision,
    // but verify that deduplication logic is in place.
    const recipients = buildAllEmailRecipients('Killer Kebab Parken')
    const unique = new Set(recipients)
    expect(unique.size).toBe(recipients.length)
  })
})

// ─── buildAllNotifyEmails ─────────────────────────────────────────────────────

describe('buildAllNotifyEmails', () => {
  it('matches buildAllEmailRecipients for all known locations', () => {
    const locations = [
      'Killer Kebab Borgergade',
      'Killer Kebab Vesterbro',
      'Killer Kebab Copenhagen Airport',
    ]
    for (const loc of locations) {
      expect(buildAllNotifyEmails(loc)).toEqual(buildAllEmailRecipients(loc))
    }
  })
})

// ─── buildEscalationSubject ───────────────────────────────────────────────────

describe('buildEscalationSubject', () => {
  it('formats the subject with location name', () => {
    expect(buildEscalationSubject('Killer Kebab Borgergade')).toBe(
      'Overdue Red Flag Follow-Up — Killer Kebab Borgergade',
    )
  })

  it('handles location names with special characters', () => {
    expect(buildEscalationSubject('Killer Kebab Nørrebro')).toBe(
      'Overdue Red Flag Follow-Up — Killer Kebab Nørrebro',
    )
  })
})

// ─── buildOverdueDays ─────────────────────────────────────────────────────────

describe('buildOverdueDays', () => {
  it('returns "overdue today" when 0 full days have passed', () => {
    // dueAt = 1 hour ago
    const dueAt = new Date(Date.now() - 3_600_000).toISOString()
    expect(buildOverdueDays(dueAt)).toBe('overdue today')
  })

  it('returns "1 day overdue" when exactly 1 full day has passed', () => {
    const dueAt = new Date(Date.now() - 25 * 3_600_000).toISOString()
    expect(buildOverdueDays(dueAt)).toBe('1 day overdue')
  })

  it('returns "N days overdue" for multiple days', () => {
    const dueAt = new Date(Date.now() - 3 * 24 * 3_600_000 - 3_600_000).toISOString()
    expect(buildOverdueDays(dueAt)).toMatch(/3 days overdue/)
  })
})

// ─── formatFollowupDueDate ────────────────────────────────────────────────────

describe('formatFollowupDueDate', () => {
  it('formats ISO date to en-GB short format', () => {
    const result = formatFollowupDueDate('2026-09-10T12:00:00Z')
    // Node locale may render 'Sept' or 'Sep' depending on runtime — check structure
    expect(result).toMatch(/^10 Sep/)
    expect(result).toMatch(/2026$/)
  })
})

// ─── Notification message format ──────────────────────────────────────────────

describe('formatNotificationMessage — audit.followup.overdue', () => {
  it('formats the message with location and red flag count', () => {
    const msg = formatNotificationMessage(
      'audit.followup.overdue',
      null,
      null,
      { location: 'Killer Kebab Borgergade', red_flag_count: 3 },
    )
    expect(msg).toContain('Killer Kebab Borgergade')
    expect(msg).toMatch(/3 red flags/)
  })

  it('uses singular "red flag" for count = 1', () => {
    const msg = formatNotificationMessage(
      'audit.followup.overdue',
      null,
      null,
      { location: 'Killer Kebab Vesterbro', red_flag_count: 1 },
    )
    expect(msg).toMatch(/1 red flag$/)
    expect(msg).not.toContain('red flags')
  })

  it('returns fallback when no metadata', () => {
    const msg = formatNotificationMessage('audit.followup.overdue', null, null, null)
    expect(msg).toBe('Overdue Red Flag follow-up')
  })
})

// ─── Regional Manager coverage ────────────────────────────────────────────────

describe('RM routing — all configured locations have an RM', () => {
  const configuredLocations = Array.from(AUDIT_FOLLOWUP_ESCALATION.regionManagerByLocation.keys())

  it.each(configuredLocations)('"%s" resolves to a non-null RM email', (loc) => {
    expect(resolveRegionManager(loc)).not.toBeNull()
  })

  it('all 7 known store locations are configured', () => {
    expect(configuredLocations).toHaveLength(7)
  })

  it('each RM email appears at least once', () => {
    const rmEmails = Array.from(AUDIT_FOLLOWUP_ESCALATION.regionManagerByLocation.values())
    expect(rmEmails).toContain('lydia@killerkebab.com')
    expect(rmEmails).toContain('sara@killerkebab.com')
  })
})
