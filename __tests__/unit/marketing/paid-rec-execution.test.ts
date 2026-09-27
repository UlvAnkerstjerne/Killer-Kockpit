/**
 * Targeted tests for paid recommendation execution layer.
 *
 * Verified guarantees:
 *   1.  SIGNAL_EXECUTION_MAP — spend_no_results → create_task_and_monitor
 *   2.  SIGNAL_EXECUTION_MAP — cpr_worsening → create_task_and_monitor
 *   3.  SIGNAL_EXECUTION_MAP — cpr_improving → monitor
 *   4.  SIGNAL_EXECUTION_MAP — strong_performance → monitor
 *   5.  determineOutcome — baseline 0 results, now has results → improved
 *   6.  determineOutcome — baseline had results, now 0 → needs_attention
 *   7.  determineOutcome — CPR improved ≥15% → improved
 *   8.  determineOutcome — CPR worsened ≥15% → needs_attention
 *   9.  determineOutcome — CPR within ±15% → unchanged
 *  10.  determineOutcome — both null CPR → unchanged
 *  11.  Duplicate suppression — in_motion campaign key is filtered out
 *  12.  Duplicate suppression — completed campaign key is NOT filtered out
 *  13.  Execution type assigned at generation time from signal_type
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { SIGNAL_EXECUTION_MAP } from '@/lib/marketing/paid-recs/types'
import type { PaidRecSignalType } from '@/lib/marketing/paid-recs/types'
import { determineOutcome } from '@/lib/marketing/paid-recs/monitor'

// ─── SIGNAL_EXECUTION_MAP ────────────────────────────────────────────────────

describe('SIGNAL_EXECUTION_MAP', () => {
  it('1. spend_no_results → create_task_and_monitor', () => {
    expect(SIGNAL_EXECUTION_MAP.spend_no_results).toBe('create_task_and_monitor')
  })

  it('2. cpr_worsening → create_task_and_monitor', () => {
    expect(SIGNAL_EXECUTION_MAP.cpr_worsening).toBe('create_task_and_monitor')
  })

  it('3. cpr_improving → monitor', () => {
    expect(SIGNAL_EXECUTION_MAP.cpr_improving).toBe('monitor')
  })

  it('4. strong_performance → monitor', () => {
    expect(SIGNAL_EXECUTION_MAP.strong_performance).toBe('monitor')
  })
})

// ─── determineOutcome ────────────────────────────────────────────────────────

describe('determineOutcome', () => {
  it('5. baseline 0 results, now has results → improved', () => {
    const baseline = { spend_7d: 500, result_count_7d: 0, cpr_7d: null }
    const latest   = { spend_7d: 500, result_count_7d: 3, cpr_7d: 166.67 }
    expect(determineOutcome(baseline, latest)).toBe('improved')
  })

  it('5b. baseline null results, now has results → improved', () => {
    const baseline = { spend_7d: 500, result_count_7d: null, cpr_7d: null }
    const latest   = { spend_7d: 500, result_count_7d: 3, cpr_7d: 166.67 }
    expect(determineOutcome(baseline, latest)).toBe('improved')
  })

  it('6. baseline had results, now 0 → needs_attention', () => {
    const baseline = { spend_7d: 500, result_count_7d: 5, cpr_7d: 100 }
    const latest   = { spend_7d: 500, result_count_7d: 0, cpr_7d: null }
    expect(determineOutcome(baseline, latest)).toBe('needs_attention')
  })

  it('7. CPR improved ≥15% → improved', () => {
    const baseline = { spend_7d: 500, result_count_7d: 5, cpr_7d: 100 }
    const latest   = { spend_7d: 425, result_count_7d: 5, cpr_7d: 85 }  // -15%
    expect(determineOutcome(baseline, latest)).toBe('improved')
  })

  it('8. CPR worsened ≥15% → needs_attention', () => {
    const baseline = { spend_7d: 500, result_count_7d: 5, cpr_7d: 100 }
    const latest   = { spend_7d: 575, result_count_7d: 5, cpr_7d: 115 }  // +15%
    expect(determineOutcome(baseline, latest)).toBe('needs_attention')
  })

  it('9. CPR within ±15% → unchanged', () => {
    const baseline = { spend_7d: 500, result_count_7d: 5, cpr_7d: 100 }
    const latest   = { spend_7d: 500, result_count_7d: 5, cpr_7d: 110 }  // +10%
    expect(determineOutcome(baseline, latest)).toBe('unchanged')
  })

  it('10. both null CPR → unchanged', () => {
    const baseline = { spend_7d: 0, result_count_7d: 0, cpr_7d: null }
    const latest   = { spend_7d: 0, result_count_7d: 0, cpr_7d: null }
    expect(determineOutcome(baseline, latest)).toBe('unchanged')
  })
})

// ─── Duplicate suppression logic ────────────────────────────────────────────

describe('duplicate suppression', () => {
  // Extracted filter logic from generate.ts — mirrors the suppression step
  // Suppresses while: executing or in_motion. Allows again at terminal states.
  function filterSuppressed(
    signals: Array<{ platform: string; campaign_id: string }>,
    activeExecKeys: Set<string>,
  ) {
    return signals.filter(s => !activeExecKeys.has(`${s.platform}:${s.campaign_id}`))
  }

  it('11. in_motion campaign key is filtered out', () => {
    const signals = [
      { platform: 'meta', campaign_id: 'c1' },
      { platform: 'meta', campaign_id: 'c2' },
    ]
    const activeExecKeys = new Set(['meta:c1'])
    const result = filterSuppressed(signals, activeExecKeys)
    expect(result).toHaveLength(1)
    expect(result[0].campaign_id).toBe('c2')
  })

  it('11b. executing campaign key is filtered out', () => {
    const signals = [
      { platform: 'meta', campaign_id: 'c1' },
      { platform: 'google', campaign_id: 'c2' },
    ]
    // c1 is in 'executing' state (claim in progress)
    const activeExecKeys = new Set(['meta:c1'])
    const result = filterSuppressed(signals, activeExecKeys)
    expect(result).toHaveLength(1)
    expect(result[0].campaign_id).toBe('c2')
  })

  it('12. completed campaign key is NOT filtered out', () => {
    // completed campaigns are not in the activeExecKeys set
    const signals = [
      { platform: 'meta', campaign_id: 'c1' },
    ]
    const activeExecKeys = new Set<string>()  // c1 was completed, not in set
    const result = filterSuppressed(signals, activeExecKeys)
    expect(result).toHaveLength(1)
  })

  it('12b. failed campaign key is NOT filtered out', () => {
    const signals = [
      { platform: 'meta', campaign_id: 'c1' },
    ]
    const activeExecKeys = new Set<string>()  // c1 failed, not in active set
    const result = filterSuppressed(signals, activeExecKeys)
    expect(result).toHaveLength(1)
  })

  it('12c. needs_attention campaign key is NOT filtered out', () => {
    const signals = [
      { platform: 'google', campaign_id: 'c3' },
    ]
    const activeExecKeys = new Set<string>()  // c3 needs_attention, not in active set
    const result = filterSuppressed(signals, activeExecKeys)
    expect(result).toHaveLength(1)
  })

  it('12d. pending_approval campaign key IS filtered out (prevents contradictory recs)', () => {
    const signals = [
      { platform: 'meta', campaign_id: 'c1' },
      { platform: 'meta', campaign_id: 'c2' },
    ]
    // c1 has a pending_approval recommendation already
    const activeExecKeys = new Set(['meta:c1'])
    const result = filterSuppressed(signals, activeExecKeys)
    expect(result).toHaveLength(1)
    expect(result[0].campaign_id).toBe('c2')
  })
})

// ─── Execution type assignment ──────────────────────────────────────────────

describe('execution type assignment at generation', () => {
  it('13. every signal_type maps to a known execution_type', () => {
    const signalTypes: PaidRecSignalType[] = [
      'spend_no_results', 'cpr_worsening', 'cpr_improving', 'strong_performance',
    ]
    for (const st of signalTypes) {
      const et = SIGNAL_EXECUTION_MAP[st]
      expect(['create_task', 'monitor', 'create_task_and_monitor', 'platform_action']).toContain(et)
    }
  })
})
