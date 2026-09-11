/**
 * __tests__/unit/lib/diner-scoring.test.ts
 *
 * Tests for Mystery Diner scoring rules.
 * Verifies computeDinerStatus() matches the RPC logic exactly.
 *
 * Requirements verified:
 *   95% + 0 criticals  => GREEN
 *   95% + 1 critical   => YELLOW (critical cap)
 *   86% + 0 criticals  => GREEN  (boundary)
 *   85% + 0 criticals  => YELLOW (boundary)
 *   80% + 0 criticals  => YELLOW
 *   80% + criticals    => YELLOW (stays — cap doesn't change YELLOW)
 *   67% + 0 criticals  => YELLOW (boundary)
 *   66% + 0 criticals  => RED    (boundary)
 *   60% + 0 criticals  => RED
 *   60% + criticals    => RED    (stays — cap doesn't affect RED)
 *   null score         => null   (no checkpoints answered)
 */

import { describe, it, expect } from 'vitest'
import { computeDinerStatus } from '@/lib/diner/scoring'

describe('computeDinerStatus', () => {
  // ── GREEN cases ────────────────────────────────────────────────────────────

  it('returns GREEN for 95% with 0 criticals', () => {
    expect(computeDinerStatus(95, 0)).toBe('GREEN')
  })

  it('returns GREEN for 100% with 0 criticals', () => {
    expect(computeDinerStatus(100, 0)).toBe('GREEN')
  })

  it('returns GREEN at exactly 86% with 0 criticals', () => {
    expect(computeDinerStatus(86, 0)).toBe('GREEN')
  })

  it('returns GREEN for 90% with 0 criticals', () => {
    expect(computeDinerStatus(90, 0)).toBe('GREEN')
  })

  // ── Critical cap ───────────────────────────────────────────────────────────

  it('returns YELLOW for 95% with 1 critical (capped from GREEN)', () => {
    expect(computeDinerStatus(95, 1)).toBe('YELLOW')
  })

  it('returns YELLOW for 100% with 3 criticals (capped from GREEN)', () => {
    expect(computeDinerStatus(100, 3)).toBe('YELLOW')
  })

  it('returns YELLOW for 86% with 1 critical (capped from GREEN)', () => {
    expect(computeDinerStatus(86, 1)).toBe('YELLOW')
  })

  // ── YELLOW cases ───────────────────────────────────────────────────────────

  it('returns YELLOW for 85% with 0 criticals', () => {
    expect(computeDinerStatus(85, 0)).toBe('YELLOW')
  })

  it('returns YELLOW for 80% with 0 criticals', () => {
    expect(computeDinerStatus(80, 0)).toBe('YELLOW')
  })

  it('returns YELLOW for 80% with criticals (stays YELLOW — cap does not change it)', () => {
    expect(computeDinerStatus(80, 2)).toBe('YELLOW')
  })

  it('returns YELLOW at exactly 67% with 0 criticals', () => {
    expect(computeDinerStatus(67, 0)).toBe('YELLOW')
  })

  it('returns YELLOW for 70% with 5 criticals (stays — cap only prevents GREEN)', () => {
    expect(computeDinerStatus(70, 5)).toBe('YELLOW')
  })

  // ── RED cases ──────────────────────────────────────────────────────────────

  it('returns RED at 66% with 0 criticals', () => {
    expect(computeDinerStatus(66, 0)).toBe('RED')
  })

  it('returns RED for 60% with 0 criticals', () => {
    expect(computeDinerStatus(60, 0)).toBe('RED')
  })

  it('returns RED for 60% with criticals (stays RED — cap does not affect RED)', () => {
    expect(computeDinerStatus(60, 1)).toBe('RED')
  })

  it('returns RED for 0% with 0 criticals', () => {
    expect(computeDinerStatus(0, 0)).toBe('RED')
  })

  it('returns RED for 0% with criticals', () => {
    expect(computeDinerStatus(0, 5)).toBe('RED')
  })

  // ── Null / no-score cases ──────────────────────────────────────────────────

  it('returns null when score_pct is null', () => {
    expect(computeDinerStatus(null, 0)).toBeNull()
  })

  it('returns null when score_pct is null even with criticals', () => {
    expect(computeDinerStatus(null, 3)).toBeNull()
  })

  // ── Boundary verification ──────────────────────────────────────────────────

  it('GREEN at 86.00, YELLOW at 85.99', () => {
    expect(computeDinerStatus(86.00, 0)).toBe('GREEN')
    expect(computeDinerStatus(85.99, 0)).toBe('YELLOW')
  })

  it('YELLOW at 67.00, RED at 66.99', () => {
    expect(computeDinerStatus(67.00, 0)).toBe('YELLOW')
    expect(computeDinerStatus(66.99, 0)).toBe('RED')
  })
})
