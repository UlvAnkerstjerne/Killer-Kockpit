/**
 * Tests for lib/time.ts
 *
 * Coverage:
 *   • SCHEDULING_TZ constant
 *   • wallToUtc — Copenhagen wall clock → UTC ISO (DST-safe)
 *     - Summer (CEST, UTC+2)
 *     - Winter (CET,  UTC+1)
 *     - DST spring-forward boundary (Mar 2026)
 *     - DST fall-back boundary (Oct 2026)
 *   • utcToWall — UTC ISO → Copenhagen datetime-local string
 *     - Summer and winter cases
 *     - null / empty input
 *   • Round-trips wallToUtc(utcToWall(x)) === x
 *   • formatCopenhagen — UTC ISO → display string in Copenhagen timezone
 */

import { describe, it, expect } from 'vitest'
import { SCHEDULING_TZ, wallToUtc, utcToWall, formatCopenhagen, suggestionDueParts } from '@/lib/time'

// ─── SCHEDULING_TZ ─────────────────────────────────────────────────────────

describe('SCHEDULING_TZ', () => {
  it('is Europe/Copenhagen', () => {
    expect(SCHEDULING_TZ).toBe('Europe/Copenhagen')
  })
})

// ─── wallToUtc ─────────────────────────────────────────────────────────────

describe('wallToUtc', () => {
  it('summer (CEST, UTC+2): 2026-08-31 12:00 Copenhagen → 2026-08-31T10:00:00.000Z', () => {
    expect(wallToUtc('2026-08-31T12:00')).toBe('2026-08-31T10:00:00.000Z')
  })

  it('winter (CET, UTC+1): 2026-12-01 12:00 Copenhagen → 2026-12-01T11:00:00.000Z', () => {
    expect(wallToUtc('2026-12-01T12:00')).toBe('2026-12-01T11:00:00.000Z')
  })

  it('summer: 2026-08-31 00:00 Copenhagen → 2026-08-30T22:00:00.000Z', () => {
    // Midnight Copenhagen in summer = 22:00 UTC previous day
    expect(wallToUtc('2026-08-31T00:00')).toBe('2026-08-30T22:00:00.000Z')
  })

  it('winter: 2026-12-01 00:00 Copenhagen → 2026-11-30T23:00:00.000Z', () => {
    // Midnight Copenhagen in winter = 23:00 UTC previous day
    expect(wallToUtc('2026-12-01T00:00')).toBe('2026-11-30T23:00:00.000Z')
  })

  it('summer: 2026-08-31 09:00 Copenhagen → 2026-08-31T07:00:00.000Z', () => {
    expect(wallToUtc('2026-08-31T09:00')).toBe('2026-08-31T07:00:00.000Z')
  })

  // ── DST spring-forward: 2026-03-29 at 02:00 CET → 03:00 CEST ────────────

  it('spring-forward (DST boundary): 01:59 on 2026-03-29 is still CET (UTC+1)', () => {
    // Just before DST starts: 01:59 CET = 00:59 UTC
    expect(wallToUtc('2026-03-29T01:59')).toBe('2026-03-29T00:59:00.000Z')
  })

  it('spring-forward (DST boundary): 03:00 on 2026-03-29 is CEST (UTC+2)', () => {
    // Just after DST starts: 03:00 CEST = 01:00 UTC
    expect(wallToUtc('2026-03-29T03:00')).toBe('2026-03-29T01:00:00.000Z')
  })

  // ── DST fall-back: 2026-10-25 at 03:00 CEST → 02:00 CET ─────────────────

  it('fall-back (DST boundary): 01:00 on 2026-10-25 is CEST (UTC+2)', () => {
    // Before fall-back: 01:00 CEST = 23:00 UTC previous day
    expect(wallToUtc('2026-10-25T01:00')).toBe('2026-10-24T23:00:00.000Z')
  })

  it('fall-back (DST boundary): 03:00 on 2026-10-25 is CET (UTC+1)', () => {
    // After fall-back: 03:00 CET = 02:00 UTC
    expect(wallToUtc('2026-10-25T03:00')).toBe('2026-10-25T02:00:00.000Z')
  })
})

// ─── utcToWall ─────────────────────────────────────────────────────────────

describe('utcToWall', () => {
  it('summer (CEST, UTC+2): 2026-08-31T10:00:00Z → 2026-08-31T12:00', () => {
    expect(utcToWall('2026-08-31T10:00:00Z')).toBe('2026-08-31T12:00')
  })

  it('winter (CET, UTC+1): 2026-12-01T11:00:00Z → 2026-12-01T12:00', () => {
    expect(utcToWall('2026-12-01T11:00:00Z')).toBe('2026-12-01T12:00')
  })

  it('summer: 2026-08-31T07:00:00Z → 2026-08-31T09:00', () => {
    expect(utcToWall('2026-08-31T07:00:00Z')).toBe('2026-08-31T09:00')
  })

  it('accepts ISO string with explicit +00:00 offset', () => {
    expect(utcToWall('2026-08-31T10:00:00+00:00')).toBe('2026-08-31T12:00')
  })

  // M7E-C4 regression: task suggestion due_at (UTC ISO) must display in Copenhagen
  // This is the value openTaskForm receives from AI and must pass to a datetime-local input
  it('task due_at summer: 2026-09-07T10:00:00.000Z → 2026-09-07T12:00 (Copenhagen UTC+2)', () => {
    expect(utcToWall('2026-09-07T10:00:00.000Z')).toBe('2026-09-07T12:00')
  })

  it('null → empty string', () => {
    expect(utcToWall(null)).toBe('')
  })
})

// ─── Round-trips ───────────────────────────────────────────────────────────

describe('round-trip utcToWall → wallToUtc', () => {
  it('summer: DB UTC → form wall → back to same UTC', () => {
    const utc  = '2026-08-31T10:00:00.000Z'
    const wall = utcToWall(utc)
    expect(wallToUtc(wall)).toBe(utc)
  })

  it('winter: DB UTC → form wall → back to same UTC', () => {
    const utc  = '2026-12-01T11:00:00.000Z'
    const wall = utcToWall(utc)
    expect(wallToUtc(wall)).toBe(utc)
  })
})

describe('round-trip wallToUtc → utcToWall', () => {
  it('summer: form input → UTC → form input', () => {
    const wall = '2026-08-31T12:00'
    expect(utcToWall(wallToUtc(wall))).toBe(wall)
  })

  it('winter: form input → UTC → form input', () => {
    const wall = '2026-12-01T12:00'
    expect(utcToWall(wallToUtc(wall))).toBe(wall)
  })
})

// ─── suggestionDueParts ────────────────────────────────────────────────────
//
// Splits an AI suggestion due_at into separate { dueDate, dueTime } parts
// for the Task and Waiting On review forms. Date and time are shown in
// separate inputs so the human can see that no time was invented.

describe('suggestionDueParts — Task and Waiting On review forms', () => {
  // ── null → both blank (no deadline, creation allowed) ────────────────────

  it('null → { dueDate: "", dueTime: "" }', () => {
    expect(suggestionDueParts(null)).toEqual({ dueDate: '', dueTime: '' })
  })

  // ── Date-only (YYYY-MM-DD): date populated, time blank ───────────────────

  it('date-only "2026-09-09" → date populated, time blank', () => {
    expect(suggestionDueParts('2026-09-09')).toEqual({ dueDate: '2026-09-09', dueTime: '' })
  })

  it('date-only time is "" not "00:00" — no invented time', () => {
    const { dueTime } = suggestionDueParts('2026-09-09')
    expect(dueTime).toBe('')
    expect(dueTime).not.toBe('00:00')
  })

  it('date-only stays on the correct calendar date (no off-by-one)', () => {
    // 2026-09-09 must remain 9th — no timezone date shift
    expect(suggestionDueParts('2026-09-09').dueDate).toBe('2026-09-09')
  })

  it('date-only in winter "2026-12-15" → date populated, time blank', () => {
    expect(suggestionDueParts('2026-12-15')).toEqual({ dueDate: '2026-12-15', dueTime: '' })
  })

  // ── Full ISO timestamp (CEST, UTC+2): correct Copenhagen date + time ───────

  it('Task: explicit UTC timestamp (CEST) "2026-09-09T12:00:00.000Z" → date 2026-09-09, time 14:00', () => {
    // 12:00 UTC = 14:00 Copenhagen CEST
    expect(suggestionDueParts('2026-09-09T12:00:00.000Z')).toEqual({
      dueDate: '2026-09-09',
      dueTime: '14:00',
    })
  })

  it('Waiting On: explicit UTC timestamp (CET) "2026-12-15T11:00:00.000Z" → date 2026-12-15, time 12:00', () => {
    // 11:00 UTC = 12:00 Copenhagen CET
    expect(suggestionDueParts('2026-12-15T11:00:00.000Z')).toEqual({
      dueDate: '2026-12-15',
      dueTime: '12:00',
    })
  })

  it('explicit midnight UTC "2026-09-09T00:00:00Z" → date 2026-09-09, time 02:00 (correct for explicit timestamps)', () => {
    // A genuine midnight-UTC timestamp (not date-only) correctly shifts to 02:00 Copenhagen CEST
    expect(suggestionDueParts('2026-09-09T00:00:00Z')).toEqual({
      dueDate: '2026-09-09',
      dueTime: '02:00',
    })
  })
})

// ─── formatCopenhagen ──────────────────────────────────────────────────────

describe('formatCopenhagen', () => {
  it('formats a summer UTC timestamp as Copenhagen local time', () => {
    const result = formatCopenhagen('2026-08-31T10:00:00Z', {
      hour: '2-digit', minute: '2-digit',
    })
    // 10:00 UTC = 12:00 CEST
    expect(result).toMatch(/12:00/)
  })

  it('formats a winter UTC timestamp as Copenhagen local time', () => {
    const result = formatCopenhagen('2026-12-01T11:00:00Z', {
      hour: '2-digit', minute: '2-digit',
    })
    // 11:00 UTC = 12:00 CET
    expect(result).toMatch(/12:00/)
  })

  it('returns null for null input', () => {
    expect(formatCopenhagen(null, {})).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(formatCopenhagen(undefined, {})).toBeNull()
  })
})
