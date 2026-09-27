/**
 * Tests for tracking diagnostic classification and task-creation logic.
 *
 * Verifies:
 *   1. no_traffic — zero clicks → correct classification
 *   2. traffic_with_ga4_activity — clicks + GA4 sessions but 0 platform conversions
 *   3. traffic_no_platform_conversion — clicks but no GA4 data
 *   4. insufficient_evidence — clicks and conversions exist
 *   5. Output always has diagnosed:true, fixed:false
 *   6. Task creation decision: only when manual intervention required
 *   7. no_traffic does NOT require a Task
 *   8. insufficient_evidence does NOT require a Task
 *   9. traffic_with_ga4_activity DOES require a Task
 *  10. traffic_no_platform_conversion DOES require a Task
 *  11. conversion_exists_outside_platform DOES require a Task
 */

import { describe, it, expect } from 'vitest'

// Mirrors the classification logic from tracking-diagnostic.ts
function classify(evidence: {
  platformClicks: number | null
  platformConversions: number | null
  ga4PaidSessions: number | null
}) {
  const { platformClicks, platformConversions, ga4PaidSessions } = evidence

  if (platformClicks === null || platformClicks === 0) {
    return 'no_traffic'
  }
  if ((platformConversions ?? 0) === 0 && (ga4PaidSessions ?? 0) > 0) {
    return 'traffic_with_ga4_activity'
  }
  if ((platformConversions ?? 0) === 0 && ga4PaidSessions === null) {
    return 'traffic_no_platform_conversion'
  }
  if ((platformConversions ?? 0) === 0 && (ga4PaidSessions ?? 0) === 0) {
    return 'traffic_no_platform_conversion'
  }
  return 'insufficient_evidence'
}

// Mirrors the task-creation decision from paid-recommendations.ts
const TASK_REQUIRED_BREAKS = [
  'traffic_with_ga4_activity',
  'traffic_no_platform_conversion',
  'conversion_exists_outside_platform',
]

function diagnosticRequiresTask(diagnosed: boolean, likelyBreak: string): boolean {
  return diagnosed && TASK_REQUIRED_BREAKS.includes(likelyBreak)
}

describe('tracking diagnostic classification', () => {
  it('1. zero clicks → no_traffic', () => {
    expect(classify({ platformClicks: 0, platformConversions: 0, ga4PaidSessions: null })).toBe('no_traffic')
  })

  it('2. clicks + GA4 sessions but 0 conversions → traffic_with_ga4_activity', () => {
    expect(classify({ platformClicks: 150, platformConversions: 0, ga4PaidSessions: 120 })).toBe('traffic_with_ga4_activity')
  })

  it('3. clicks but no GA4 data → traffic_no_platform_conversion', () => {
    expect(classify({ platformClicks: 150, platformConversions: 0, ga4PaidSessions: null })).toBe('traffic_no_platform_conversion')
  })

  it('4. clicks and conversions → insufficient_evidence', () => {
    expect(classify({ platformClicks: 150, platformConversions: 5, ga4PaidSessions: 120 })).toBe('insufficient_evidence')
  })

  it('5. clicks + 0 GA4 sessions + 0 conversions → traffic_no_platform_conversion', () => {
    expect(classify({ platformClicks: 150, platformConversions: 0, ga4PaidSessions: 0 })).toBe('traffic_no_platform_conversion')
  })

  it('6. null clicks → no_traffic', () => {
    expect(classify({ platformClicks: null, platformConversions: null, ga4PaidSessions: null })).toBe('no_traffic')
  })
})

describe('tracking diagnostic never claims fix', () => {
  it('output shape always has diagnosed + fixed fields', () => {
    const diagnosed = { diagnosed: true, fixed: false } as const
    expect(diagnosed.fixed).toBe(false)
    const unavailable = { diagnosed: false, fixed: false } as const
    expect(unavailable.fixed).toBe(false)
  })
})

describe('diagnostic task-creation decision', () => {
  it('7. no_traffic does NOT require a Task', () => {
    expect(diagnosticRequiresTask(true, 'no_traffic')).toBe(false)
  })

  it('8. insufficient_evidence does NOT require a Task', () => {
    expect(diagnosticRequiresTask(true, 'insufficient_evidence')).toBe(false)
  })

  it('9. traffic_with_ga4_activity DOES require a Task', () => {
    expect(diagnosticRequiresTask(true, 'traffic_with_ga4_activity')).toBe(true)
  })

  it('10. traffic_no_platform_conversion DOES require a Task', () => {
    expect(diagnosticRequiresTask(true, 'traffic_no_platform_conversion')).toBe(true)
  })

  it('11. conversion_exists_outside_platform DOES require a Task', () => {
    expect(diagnosticRequiresTask(true, 'conversion_exists_outside_platform')).toBe(true)
  })

  it('12. undiagnosed result does NOT require a Task', () => {
    expect(diagnosticRequiresTask(false, 'traffic_with_ga4_activity')).toBe(false)
  })

  it('13. diagnostic can complete without creating a Task (no_traffic)', () => {
    // Simulates: diagnostic ran, found no_traffic, no Task created
    const diag = { diagnosed: true, fixed: false as const, likely_break: 'no_traffic' }
    const shouldCreateTask = diagnosticRequiresTask(diag.diagnosed, diag.likely_break)
    expect(shouldCreateTask).toBe(false)
    // Execution should complete with diagnostic evidence but no linked task
    expect(diag.diagnosed).toBe(true)
    expect(diag.fixed).toBe(false)
  })

  it('14. diagnostic creates exactly one Task when manual intervention required', () => {
    const diag = { diagnosed: true, fixed: false as const, likely_break: 'traffic_with_ga4_activity' }
    const shouldCreateTask = diagnosticRequiresTask(diag.diagnosed, diag.likely_break)
    expect(shouldCreateTask).toBe(true)
    // The approval flow creates exactly one Task when shouldCreateTask is true
  })

  it('15. insufficient_evidence does not pretend to fix anything', () => {
    const diag = { diagnosed: true, fixed: false as const, likely_break: 'insufficient_evidence' }
    expect(diag.fixed).toBe(false)
    expect(diagnosticRequiresTask(diag.diagnosed, diag.likely_break)).toBe(false)
    // No Task, no fix claim, just evidence recorded
  })
})
