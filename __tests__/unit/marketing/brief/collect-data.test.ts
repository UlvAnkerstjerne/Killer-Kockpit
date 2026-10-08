/**
 * Tests for deterministic logic in lib/marketing/brief/collect-data.ts
 *
 * All tests use pure logic or small helpers — no DB, no AI, no external calls.
 */

import { describe, it, expect } from 'vitest'
import {
  ANOMALY_MIN_DAILY_SPEND,
  ANOMALY_PCT_THRESHOLD,
  CRITICAL_STALENESS_HOURS,
  DEEP_SYNC_STALENESS_HOURS,
  ORGANIC_DROP_THRESHOLD,
  copenhagenToday,
  copenhagenYesterday,
} from '@/lib/marketing/brief/collect-data'

// ── copenhagenToday / copenhagenYesterday ─────────────────────────────────────

describe('copenhagenToday', () => {
  it('returns a YYYY-MM-DD string', () => {
    const result = copenhagenToday()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns a valid date', () => {
    const result = copenhagenToday()
    const d = new Date(result + 'T12:00:00Z')
    expect(isNaN(d.getTime())).toBe(false)
  })
})

describe('copenhagenYesterday', () => {
  it('returns a YYYY-MM-DD string', () => {
    const result = copenhagenYesterday()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('is exactly one day before today', () => {
    const today     = copenhagenToday()
    const yesterday = copenhagenYesterday()
    const todayMs     = new Date(today + 'T12:00:00Z').getTime()
    const yesterdayMs = new Date(yesterday + 'T12:00:00Z').getTime()
    expect(todayMs - yesterdayMs).toBe(24 * 60 * 60 * 1000)
  })
})

// ── Threshold constants ───────────────────────────────────────────────────────

describe('anomaly thresholds', () => {
  it('ANOMALY_MIN_DAILY_SPEND is a positive number', () => {
    expect(ANOMALY_MIN_DAILY_SPEND).toBeGreaterThan(0)
  })

  it('ANOMALY_PCT_THRESHOLD is between 0.1 and 0.9', () => {
    expect(ANOMALY_PCT_THRESHOLD).toBeGreaterThan(0.1)
    expect(ANOMALY_PCT_THRESHOLD).toBeLessThan(0.9)
  })

  it('CRITICAL_STALENESS_HOURS is reasonable (between 24h and 72h)', () => {
    expect(CRITICAL_STALENESS_HOURS).toBeGreaterThanOrEqual(24)
    expect(CRITICAL_STALENESS_HOURS).toBeLessThanOrEqual(72)
  })

  it('DEEP_SYNC_STALENESS_HOURS is greater than CRITICAL_STALENESS_HOURS', () => {
    expect(DEEP_SYNC_STALENESS_HOURS).toBeGreaterThan(CRITICAL_STALENESS_HOURS)
  })

  it('ORGANIC_DROP_THRESHOLD is between 0.2 and 0.8', () => {
    expect(ORGANIC_DROP_THRESHOLD).toBeGreaterThan(0.2)
    expect(ORGANIC_DROP_THRESHOLD).toBeLessThan(0.8)
  })
})

// ── Anomaly detection rules (tested via exported constants) ───────────────────
//
// The detectPaidAnomaly function is not exported (internal), but its behaviour is
// governed by the exported threshold constants. The following tests verify the
// expected relationships between thresholds and what they gate.

describe('anomaly detection rules', () => {
  it('does not flag anomaly below minimum spend threshold', () => {
    // Any spend below ANOMALY_MIN_DAILY_SPEND should not trigger anomaly
    expect(ANOMALY_MIN_DAILY_SPEND).toBeGreaterThan(0)
    // We verify the constant is set to a meaningful floor (not 0 or 1)
    expect(ANOMALY_MIN_DAILY_SPEND).toBeGreaterThanOrEqual(10)
  })

  it('ANOMALY_PCT_THRESHOLD represents a meaningful percentage (at least 20%)', () => {
    // Guard against accidentally setting threshold too low (noisy alerts)
    expect(ANOMALY_PCT_THRESHOLD * 100).toBeGreaterThanOrEqual(20)
  })

  it('ORGANIC_DROP_THRESHOLD represents at least 30% drop (not triggered by noise)', () => {
    expect(ORGANIC_DROP_THRESHOLD * 100).toBeGreaterThanOrEqual(30)
  })
})

// ── Freshness logic ───────────────────────────────────────────────────────────
//
// The makeFreshness helper is internal. We test the exported threshold values
// that govern it, and verify their logical relationships.

describe('freshness thresholds', () => {
  it('daily sync threshold is less strict than 48h (allows for occasional delays)', () => {
    expect(CRITICAL_STALENESS_HOURS).toBeGreaterThan(24)
  })

  it('deep sync threshold is at least 7 days (deep sync runs weekly)', () => {
    expect(DEEP_SYNC_STALENESS_HOURS).toBeGreaterThanOrEqual(7 * 24)
  })
})

// ── Saved-for-later reviews stay out of the Brief ─────────────────────────────

import { countAwaitingRepliesExcludingSaved, collectNeedsReviewCounts } from '@/lib/marketing/brief/collect-data'

function fakeDb(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from(t: string) {
      let rows = tables[t] ?? []
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => { rows = rows.filter(r => r[c] === v); return b },
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, count: rows.length, error: null }).then(res),
      }
      return b
    },
  } as never
}

describe('Brief excludes saved reviews until answered or dismissed', () => {
  const replies = [
    { id: 'p1', review_id: 'r1', status: 'awaiting_review' },
    { id: 'p2', review_id: 'r2', status: 'awaiting_review' },
    { id: 'p3', review_id: 'r3', status: 'awaiting_review' },
    { id: 'p4', review_id: 'r4', status: 'published' },
  ]

  it('counts every awaiting reply when nothing is saved', async () => {
    expect(await countAwaitingRepliesExcludingSaved(fakeDb({ gbp_review_replies: replies, gbp_review_saved: [] }))).toBe(3)
  })

  it('leaves saved reviews out of the count', async () => {
    const db = fakeDb({ gbp_review_replies: replies, gbp_review_saved: [{ review_id: 'r2' }] })
    expect(await countAwaitingRepliesExcludingSaved(db)).toBe(2)
  })

  it('an answered saved review stays out; a dismissed (unsaved) one returns', async () => {
    const answered = replies.map(r => (r.review_id === 'r2' ? { ...r, status: 'published' } : r))
    expect(await countAwaitingRepliesExcludingSaved(fakeDb({ gbp_review_replies: answered, gbp_review_saved: [{ review_id: 'r2' }] }))).toBe(2)
    expect(await countAwaitingRepliesExcludingSaved(fakeDb({ gbp_review_replies: replies, gbp_review_saved: [] }))).toBe(3)
  })

  it('Needs Review counts in the Brief also exclude saved reviews', async () => {
    const db = fakeDb({ gbp_review_replies: replies, gbp_review_saved: [{ review_id: 'r1' }, { review_id: 'r3' }] })
    const out = await collectNeedsReviewCounts(db)
    expect(out.review_reply).toBe(1)
    expect(out.total).toBe(1)
  })
})
