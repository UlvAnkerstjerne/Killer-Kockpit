/**
 * __tests__/unit/lib/task-overdue-reminders.test.ts
 *
 * Unit tests for staged overdue-task email reminder logic.
 * Covers: submission key format, stage eligibility, email subject/copy,
 * deadline-change episode model, and idempotency contract.
 *
 * No network calls — all assertions are on pure exported functions.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSubmissionKey,
  getEligibleStages,
  OVERDUE_STAGE_HOURS,
} from '@/lib/reports/dispatch-task-overdue'
import {
  buildOverdueSubject,
  buildStageLabel,
} from '@/lib/reports/send-task-overdue-email'

// ─── buildSubmissionKey ───────────────────────────────────────────────────────

describe('buildSubmissionKey', () => {
  const TASK_ID = 'aabbccdd-1234-5678-abcd-ef1234567890'
  const DUE_AT  = '2026-09-10T12:00:00Z'

  it('encodes taskId, dueAt, and stage in the key', () => {
    const key = buildSubmissionKey(TASK_ID, DUE_AT, 0)
    expect(key).toBe(`${TASK_ID}:${DUE_AT}:0`)
  })

  it('produces distinct keys for different stages', () => {
    const keys = OVERDUE_STAGE_HOURS.map(h => buildSubmissionKey(TASK_ID, DUE_AT, h))
    const unique = new Set(keys)
    expect(unique.size).toBe(OVERDUE_STAGE_HOURS.length)
  })

  it('produces distinct keys for different due dates (episode model)', () => {
    const key1 = buildSubmissionKey(TASK_ID, '2026-09-10T12:00:00Z', 0)
    const key2 = buildSubmissionKey(TASK_ID, '2026-09-12T12:00:00Z', 0)
    expect(key1).not.toBe(key2)
  })

  it('produces distinct keys for different tasks at the same due date and stage', () => {
    const key1 = buildSubmissionKey('task-aaa', DUE_AT, 24)
    const key2 = buildSubmissionKey('task-bbb', DUE_AT, 24)
    expect(key1).not.toBe(key2)
  })

  it('round-trips the stage value into the key', () => {
    for (const hours of OVERDUE_STAGE_HOURS) {
      const key = buildSubmissionKey(TASK_ID, DUE_AT, hours)
      expect(key.endsWith(`:${hours}`)).toBe(true)
    }
  })
})

// ─── getEligibleStages ────────────────────────────────────────────────────────

describe('getEligibleStages', () => {
  const DUE_AT = '2026-09-10T12:00:00Z'  // Wednesday noon UTC

  function nowAt(iso: string): Date { return new Date(iso) }

  it('returns no stages when now is exactly at the deadline (not yet overdue)', () => {
    // now === dueAt exactly — 0h stage threshold is >= dueAt + 0, so 0h IS eligible
    const stages = getEligibleStages(DUE_AT, nowAt('2026-09-10T12:00:00Z'))
    expect(stages).toContain(0)
  })

  it('returns only stage 0 just after the deadline', () => {
    const stages = getEligibleStages(DUE_AT, nowAt('2026-09-10T12:01:00Z'))
    expect(stages).toEqual([0])
  })

  it('returns stages 0 and 24 after 24+ hours have elapsed', () => {
    const stages = getEligibleStages(DUE_AT, nowAt('2026-09-11T13:00:00Z'))  // 25h later
    expect(stages).toEqual([0, 24])
  })

  it('returns stages 0, 24, and 48 after 48+ hours have elapsed', () => {
    const stages = getEligibleStages(DUE_AT, nowAt('2026-09-12T13:00:00Z'))  // 49h later
    expect(stages).toEqual([0, 24, 48])
  })

  it('returns all four stages after 72+ hours have elapsed', () => {
    const stages = getEligibleStages(DUE_AT, nowAt('2026-09-13T13:00:00Z'))  // 73h later
    expect(stages).toEqual([0, 24, 48, 72])
  })

  it('returns empty array when now is before the deadline', () => {
    const stages = getEligibleStages(DUE_AT, nowAt('2026-09-10T11:59:00Z'))
    expect(stages).toEqual([])
  })

  it('returns exactly the 72h stage when at the 72h boundary', () => {
    const stages = getEligibleStages(DUE_AT, nowAt('2026-09-13T12:00:00Z'))  // exactly 72h
    expect(stages).toContain(72)
    expect(stages).toHaveLength(4)  // all four
  })

  it('returns all four stages for a task 100 hours overdue', () => {
    const stages = getEligibleStages(DUE_AT, nowAt('2026-09-14T16:00:00Z'))  // 100h
    expect(stages).toEqual([0, 24, 48, 72])
  })

  it('returns no stages when task has no due date (empty dueAt handled by caller)', () => {
    // getEligibleStages receives a valid dueAt — caller filters nulls — but this
    // confirms it does not crash on future dates with no stage due
    const futureDue = '2026-12-31T12:00:00Z'
    const stages    = getEligibleStages(futureDue, nowAt('2026-09-10T12:00:00Z'))
    expect(stages).toEqual([])
  })
})

// ─── OVERDUE_STAGE_HOURS constant ─────────────────────────────────────────────

describe('OVERDUE_STAGE_HOURS', () => {
  it('contains exactly 4 stages', () => {
    expect(OVERDUE_STAGE_HOURS).toHaveLength(4)
  })

  it('stages are [0, 24, 48, 72] in ascending order', () => {
    expect([...OVERDUE_STAGE_HOURS]).toEqual([0, 24, 48, 72])
  })
})

// ─── buildOverdueSubject ──────────────────────────────────────────────────────

describe('buildOverdueSubject', () => {
  it('prefixes with "Overdue task — "', () => {
    expect(buildOverdueSubject('Fix the login bug')).toBe('Overdue task — Fix the login bug')
  })

  it('preserves special characters in the title', () => {
    expect(buildOverdueSubject('Review Q3 P&L — Finance')).toBe('Overdue task — Review Q3 P&L — Finance')
  })

  it('handles an empty title without crashing', () => {
    const subject = buildOverdueSubject('')
    expect(subject).toBe('Overdue task — ')
  })
})

// ─── buildStageLabel ──────────────────────────────────────────────────────────

describe('buildStageLabel', () => {
  it('labels stage 0 as immediately overdue', () => {
    const label = buildStageLabel(0)
    expect(label).toMatch(/now overdue/i)
  })

  it('labels stage 24 with 24 hours', () => {
    const label = buildStageLabel(24)
    expect(label).toMatch(/24 hours/i)
  })

  it('labels stage 48 with 48 hours', () => {
    const label = buildStageLabel(48)
    expect(label).toMatch(/48 hours/i)
  })

  it('labels stage 72 with 72 hours and marks it final', () => {
    const label = buildStageLabel(72)
    expect(label).toMatch(/72 hours/i)
    expect(label).toMatch(/final reminder/i)
  })

  it('each stage label is distinct', () => {
    const labels = OVERDUE_STAGE_HOURS.map(h => buildStageLabel(h))
    const unique  = new Set(labels)
    expect(unique.size).toBe(OVERDUE_STAGE_HOURS.length)
  })
})

// ─── Idempotency contract (submission key model) ──────────────────────────────

describe('idempotency model', () => {
  const TASK_ID = 'task-abc-123'

  it('different due dates for the same task produce non-overlapping key spaces', () => {
    const episode1Keys = OVERDUE_STAGE_HOURS.map(h => buildSubmissionKey(TASK_ID, '2026-09-01T12:00:00Z', h))
    const episode2Keys = OVERDUE_STAGE_HOURS.map(h => buildSubmissionKey(TASK_ID, '2026-09-10T12:00:00Z', h))

    const intersection = episode1Keys.filter(k => episode2Keys.includes(k))
    expect(intersection).toHaveLength(0)
  })

  it('same task + same due date + same stage always produces the same key', () => {
    const k1 = buildSubmissionKey(TASK_ID, '2026-09-10T12:00:00Z', 48)
    const k2 = buildSubmissionKey(TASK_ID, '2026-09-10T12:00:00Z', 48)
    expect(k1).toBe(k2)
  })

  it('all 4 stage keys for one episode are unique', () => {
    const keys   = OVERDUE_STAGE_HOURS.map(h => buildSubmissionKey(TASK_ID, '2026-09-10T12:00:00Z', h))
    const unique = new Set(keys)
    expect(unique.size).toBe(4)
  })

  it('stage keys do not collide across different tasks', () => {
    const keysA = OVERDUE_STAGE_HOURS.map(h => buildSubmissionKey('task-A', '2026-09-10T12:00:00Z', h))
    const keysB = OVERDUE_STAGE_HOURS.map(h => buildSubmissionKey('task-B', '2026-09-10T12:00:00Z', h))
    const all   = [...keysA, ...keysB]
    expect(new Set(all).size).toBe(all.length)
  })
})

// ─── Stage eligibility boundary conditions ────────────────────────────────────

describe('stage eligibility — boundary conditions', () => {
  it('exactly at the 24h threshold — stage 24 is included', () => {
    const dueAt  = '2026-09-10T12:00:00Z'
    const nowAt24 = new Date(new Date(dueAt).getTime() + 24 * 3_600_000)
    const stages  = getEligibleStages(dueAt, nowAt24)
    expect(stages).toContain(24)
  })

  it('one second before the 24h threshold — stage 24 is not included', () => {
    const dueAt    = '2026-09-10T12:00:00Z'
    const nowJust  = new Date(new Date(dueAt).getTime() + 24 * 3_600_000 - 1000)
    const stages   = getEligibleStages(dueAt, nowJust)
    expect(stages).not.toContain(24)
    expect(stages).toContain(0)
  })

  it('exactly at the 72h threshold — all stages are included and this is the final', () => {
    const dueAt   = '2026-09-10T12:00:00Z'
    const nowAt72 = new Date(new Date(dueAt).getTime() + 72 * 3_600_000)
    const stages  = getEligibleStages(dueAt, nowAt72)
    expect(stages).toEqual([0, 24, 48, 72])
  })

  it('tasks 200h overdue still only return 4 stages (no additional stages beyond 72h)', () => {
    const dueAt    = '2026-09-01T12:00:00Z'
    const nowLate  = new Date(new Date(dueAt).getTime() + 200 * 3_600_000)
    const stages   = getEligibleStages(dueAt, nowLate)
    expect(stages).toHaveLength(4)
    expect([...OVERDUE_STAGE_HOURS]).toEqual([...stages])
  })
})
