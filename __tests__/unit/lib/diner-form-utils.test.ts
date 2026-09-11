/**
 * __tests__/unit/lib/diner-form-utils.test.ts
 *
 * Tests for Mystery Diner questionnaire pure utility logic.
 */

import { describe, it, expect } from 'vitest'
import {
  isWaitingTimeCritical,
  shouldShowConditional,
  computeProgress,
  groupCheckpointsBySection,
  getWaitingTimeBand,
} from '@/lib/diner/form-utils'
import type { DinerCheckpoint, DinerResponsesMap } from '@/lib/diner/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCheckpoint(overrides: Partial<DinerCheckpoint>): DinerCheckpoint {
  return {
    id:             'cp-' + Math.random(),
    template_id:    'tpl-1',
    section:        'Service',
    order_index:    1,
    label:          'Test checkpoint',
    description:    null,
    hint:           null,
    type:           'scored',
    is_critical:    false,
    is_conditional: false,
    ...overrides,
  }
}

// ─── isWaitingTimeCritical ────────────────────────────────────────────────────

describe('isWaitingTimeCritical', () => {
  it('returns true for 20+', () => {
    expect(isWaitingTimeCritical('20+')).toBe(true)
  })
  it('returns false for 0-5', ()  => { expect(isWaitingTimeCritical('0-5')).toBe(false) })
  it('returns false for 6-10', () => { expect(isWaitingTimeCritical('6-10')).toBe(false) })
  it('returns false for 11-15', ()=> { expect(isWaitingTimeCritical('11-15')).toBe(false) })
  it('returns false for 16-20', ()=> { expect(isWaitingTimeCritical('16-20')).toBe(false) })
  it('returns false for null', ()  => { expect(isWaitingTimeCritical(null)).toBe(false) })
})

// ─── shouldShowConditional ────────────────────────────────────────────────────

describe('shouldShowConditional', () => {
  it('returns true for 16-20', () => { expect(shouldShowConditional('16-20')).toBe(true) })
  it('returns true for 20+',   () => { expect(shouldShowConditional('20+')).toBe(true) })
  it('returns false for 0-5',  () => { expect(shouldShowConditional('0-5')).toBe(false) })
  it('returns false for 6-10', () => { expect(shouldShowConditional('6-10')).toBe(false) })
  it('returns false for 11-15',() => { expect(shouldShowConditional('11-15')).toBe(false) })
  it('returns false for null', () => { expect(shouldShowConditional(null)).toBe(false) })
})

// ─── computeProgress ─────────────────────────────────────────────────────────

describe('computeProgress', () => {
  const scored1 = makeCheckpoint({ id: 'cp1', type: 'scored' })
  const scored2 = makeCheckpoint({ id: 'cp2', type: 'scored' })
  const goldStar = makeCheckpoint({ id: 'cp3', type: 'gold_star' })
  const waitTime = makeCheckpoint({ id: 'cp4', type: 'waiting_time' })
  const info     = makeCheckpoint({ id: 'cp5', type: 'informational' })
  const cond     = makeCheckpoint({ id: 'cp6', type: 'scored', is_conditional: true })

  it('returns 0/0 for empty checkpoints', () => {
    expect(computeProgress([], {}, false)).toEqual({ answered: 0, total: 0, pct: 0 })
  })

  it('excludes informational checkpoints from total', () => {
    const result = computeProgress([info, scored1], {}, false)
    expect(result.total).toBe(1)
  })

  it('counts scored + gold_star + waiting_time in total', () => {
    const result = computeProgress([scored1, goldStar, waitTime, info], {}, false)
    expect(result.total).toBe(3)
  })

  it('counts answered scored (result !== null)', () => {
    const responses: DinerResponsesMap = {
      cp1: { result: 'pass', notes: '' },
      cp2: { result: null,   notes: '' },
    }
    const result = computeProgress([scored1, scored2], responses, false)
    expect(result.answered).toBe(1)
    expect(result.total).toBe(2)
    expect(result.pct).toBe(50)
  })

  it('counts answered gold_star', () => {
    const responses: DinerResponsesMap = {
      cp3: { result: 'pass', notes: '' },
    }
    const result = computeProgress([goldStar], responses, false)
    expect(result.answered).toBe(1)
  })

  it('counts answered waiting_time (non-empty notes)', () => {
    const responses: DinerResponsesMap = {
      cp4: { result: null, notes: '0-5' },
    }
    const result = computeProgress([waitTime], responses, false)
    expect(result.answered).toBe(1)
  })

  it('does not count waiting_time with empty notes as answered', () => {
    const responses: DinerResponsesMap = {
      cp4: { result: null, notes: '' },
    }
    const result = computeProgress([waitTime], responses, false)
    expect(result.answered).toBe(0)
  })

  it('excludes conditional checkpoints when showConditionals=false', () => {
    const result = computeProgress([scored1, cond], {}, false)
    expect(result.total).toBe(1)
  })

  it('includes conditional checkpoints when showConditionals=true', () => {
    const result = computeProgress([scored1, cond], {}, true)
    expect(result.total).toBe(2)
  })

  it('conditional answered when showConditionals=true and answered', () => {
    const responses: DinerResponsesMap = {
      cp6: { result: 'fail', notes: '' },
    }
    const result = computeProgress([cond], responses, true)
    expect(result.answered).toBe(1)
  })
})

// ─── groupCheckpointsBySection ────────────────────────────────────────────────

describe('groupCheckpointsBySection', () => {
  it('preserves section insertion order', () => {
    const checkpoints = [
      makeCheckpoint({ id: 'a', section: 'Service',   order_index: 1 }),
      makeCheckpoint({ id: 'b', section: 'Sales',     order_index: 2 }),
      makeCheckpoint({ id: 'c', section: 'Service',   order_index: 3 }),
    ]
    const map = groupCheckpointsBySection(checkpoints)
    expect([...map.keys()]).toEqual(['Service', 'Sales'])
  })

  it('groups checkpoints correctly', () => {
    const cp1 = makeCheckpoint({ id: 'a', section: 'Service' })
    const cp2 = makeCheckpoint({ id: 'b', section: 'Sales' })
    const cp3 = makeCheckpoint({ id: 'c', section: 'Service' })
    const map  = groupCheckpointsBySection([cp1, cp2, cp3])
    expect(map.get('Service')).toHaveLength(2)
    expect(map.get('Sales')).toHaveLength(1)
  })

  it('returns empty map for empty input', () => {
    expect(groupCheckpointsBySection([])).toEqual(new Map())
  })
})

// ─── getWaitingTimeBand ───────────────────────────────────────────────────────

describe('getWaitingTimeBand', () => {
  const wt = makeCheckpoint({ id: 'wt', type: 'waiting_time' })
  const s1 = makeCheckpoint({ id: 's1', type: 'scored' })

  it('returns the band from notes', () => {
    const responses: DinerResponsesMap = { wt: { result: null, notes: '20+' } }
    expect(getWaitingTimeBand([s1, wt], responses)).toBe('20+')
  })

  it('returns null when not answered', () => {
    expect(getWaitingTimeBand([s1, wt], {})).toBeNull()
  })

  it('returns null when notes is empty', () => {
    const responses: DinerResponsesMap = { wt: { result: null, notes: '' } }
    expect(getWaitingTimeBand([s1, wt], responses)).toBeNull()
  })

  it('returns null when no waiting_time checkpoint exists', () => {
    expect(getWaitingTimeBand([s1], {})).toBeNull()
  })
})
