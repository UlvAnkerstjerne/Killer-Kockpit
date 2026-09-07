/**
 * quick-capture-modal.test.ts
 *
 * Unit tests for the pure helper exports of QuickCaptureModal (M8B4).
 * Runs in Node — no DOM, no browser APIs required for these exports.
 *
 * Covers:
 *   - todayCopenhagen()   — returns YYYY-MM-DD
 *   - enrichedRefToUI()   — resolved / ambiguous / not_found mapping
 *   - enrichedToUI()      — maps candidates array, all start selected, ids assigned
 *   - hasZeroLinks()      — zero-link warning predicate
 */

import { describe, it, expect } from 'vitest'
import {
  todayCopenhagen,
  enrichedRefToUI,
  enrichedToUI,
  hasZeroLinks,
  type EntityRefUI,
  type CandidateUI,
} from '@/components/capture/QuickCaptureModal'
import type {
  ResolvedEntityRef,
  AmbiguousEntityRef,
  NotFoundEntityRef,
} from '@/lib/actions/capture'

// ─── todayCopenhagen ──────────────────────────────────────────────────────────

describe('todayCopenhagen', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(todayCopenhagen()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns the same value on consecutive calls within the same second', () => {
    expect(todayCopenhagen()).toBe(todayCopenhagen())
  })
})

// ─── enrichedRefToUI — resolved ───────────────────────────────────────────────

describe('enrichedRefToUI — resolved', () => {
  const resolved: ResolvedEntityRef = {
    entity_type:  'employee',
    name_hint:    'Ahmed Al-Rashid',
    status:       'resolved',
    entity_id:    'emp-1',
    display_name: 'Ahmed Al-Rashid',
    match_kind:   'exact',
  }

  it('sets canonical from resolved ref', () => {
    const ui = enrichedRefToUI(resolved)
    expect(ui.canonical).not.toBeNull()
    expect(ui.canonical?.entity_id).toBe('emp-1')
    expect(ui.canonical?.display_name).toBe('Ahmed Al-Rashid')
    expect(ui.canonical?.entity_type).toBe('employee')
  })

  it('sets empty ambiguousCandidates for resolved ref', () => {
    const ui = enrichedRefToUI(resolved)
    expect(ui.ambiguousCandidates).toHaveLength(0)
  })

  it('preserves entity_type and name_hint', () => {
    const ui = enrichedRefToUI(resolved)
    expect(ui.entity_type).toBe('employee')
    expect(ui.name_hint).toBe('Ahmed Al-Rashid')
  })

  it('works for partial match_kind too', () => {
    const partial: ResolvedEntityRef = { ...resolved, match_kind: 'partial' }
    const ui = enrichedRefToUI(partial)
    expect(ui.canonical).not.toBeNull()
    expect(ui.canonical?.entity_id).toBe('emp-1')
  })
})

// ─── enrichedRefToUI — ambiguous ──────────────────────────────────────────────

describe('enrichedRefToUI — ambiguous', () => {
  const ambiguous: AmbiguousEntityRef = {
    entity_type: 'employee',
    name_hint:   'Ahmed',
    status:      'ambiguous',
    candidates:  [
      { entity_id: 'emp-1', display_name: 'Ahmed Al-Rashid' },
      { entity_id: 'emp-2', display_name: 'Ahmed Hassan' },
    ],
  }

  it('sets canonical to null', () => {
    const ui = enrichedRefToUI(ambiguous)
    expect(ui.canonical).toBeNull()
  })

  it('maps candidates to ambiguousCandidates with entity_type', () => {
    const ui = enrichedRefToUI(ambiguous)
    expect(ui.ambiguousCandidates).toHaveLength(2)
    expect(ui.ambiguousCandidates[0].entity_id).toBe('emp-1')
    expect(ui.ambiguousCandidates[1].entity_id).toBe('emp-2')
    expect(ui.ambiguousCandidates[0].entity_type).toBe('employee')
  })
})

// ─── enrichedRefToUI — not_found ──────────────────────────────────────────────

describe('enrichedRefToUI — not_found', () => {
  const notFound: NotFoundEntityRef = {
    entity_type: 'location',
    name_hint:   'Valby',
    status:      'not_found',
  }

  it('sets canonical to null', () => {
    const ui = enrichedRefToUI(notFound)
    expect(ui.canonical).toBeNull()
  })

  it('sets empty ambiguousCandidates', () => {
    const ui = enrichedRefToUI(notFound)
    expect(ui.ambiguousCandidates).toHaveLength(0)
  })

  it('preserves entity_type and name_hint', () => {
    const ui = enrichedRefToUI(notFound)
    expect(ui.entity_type).toBe('location')
    expect(ui.name_hint).toBe('Valby')
  })
})

// ─── enrichedToUI ─────────────────────────────────────────────────────────────

describe('enrichedToUI', () => {
  it('returns empty array for empty input', () => {
    expect(enrichedToUI([])).toHaveLength(0)
  })

  it('maps all candidates and preserves count', () => {
    const result = enrichedToUI([
      { body: 'Fact one.', occurred_on: '2026-09-05', entity_refs: [] },
      { body: 'Fact two.', occurred_on: null,          entity_refs: [] },
    ])
    expect(result).toHaveLength(2)
  })

  it('starts every candidate as selected', () => {
    const result = enrichedToUI([
      { body: 'Fact.', occurred_on: null, entity_refs: [] },
      { body: 'Another.', occurred_on: null, entity_refs: [] },
    ])
    expect(result.every(c => c.selected)).toBe(true)
  })

  it('assigns stable string ids based on index', () => {
    const result = enrichedToUI([
      { body: 'A', occurred_on: null, entity_refs: [] },
      { body: 'B', occurred_on: null, entity_refs: [] },
    ])
    expect(result[0].id).toBe('0')
    expect(result[1].id).toBe('1')
  })

  it('copies body and occurredOn', () => {
    const result = enrichedToUI([
      { body: 'Ahmed promoted.', occurred_on: '2026-09-05', entity_refs: [] },
    ])
    expect(result[0].body).toBe('Ahmed promoted.')
    expect(result[0].occurredOn).toBe('2026-09-05')
  })

  it('maps entity_refs through enrichedRefToUI', () => {
    const resolved: ResolvedEntityRef = {
      entity_type:  'employee',
      name_hint:    'Ahmed',
      status:       'resolved',
      entity_id:    'emp-1',
      display_name: 'Ahmed Al-Rashid',
      match_kind:   'exact',
    }
    const result = enrichedToUI([
      { body: 'Promoted.', occurred_on: null, entity_refs: [resolved] },
    ])
    expect(result[0].entityRefs).toHaveLength(1)
    expect(result[0].entityRefs[0].canonical?.entity_id).toBe('emp-1')
  })
})

// ─── hasZeroLinks ─────────────────────────────────────────────────────────────

describe('hasZeroLinks', () => {
  function makeCandidate(overrides: Partial<CandidateUI>): CandidateUI {
    return {
      id:         '0',
      selected:   true,
      body:       'Some fact.',
      occurredOn: null,
      entityRefs: [],
      ...overrides,
    }
  }

  function ref(hasCanonical: boolean): EntityRefUI {
    return {
      entity_type:         'employee',
      name_hint:           'Ahmed',
      canonical:           hasCanonical ? { entity_id: 'e1', display_name: 'Ahmed', entity_type: 'employee' } : null,
      ambiguousCandidates: [],
    }
  }

  it('returns true for selected candidate with no entity refs', () => {
    expect(hasZeroLinks(makeCandidate({ entityRefs: [] }))).toBe(true)
  })

  it('returns true for selected candidate whose only ref has null canonical', () => {
    expect(hasZeroLinks(makeCandidate({ entityRefs: [ref(false)] }))).toBe(true)
  })

  it('returns false for selected candidate with a resolved canonical', () => {
    expect(hasZeroLinks(makeCandidate({ entityRefs: [ref(true)] }))).toBe(false)
  })

  it('returns false when at least one ref has a canonical (even if others do not)', () => {
    const candidate = makeCandidate({ entityRefs: [ref(false), ref(true)] })
    expect(hasZeroLinks(candidate)).toBe(false)
  })

  it('returns false for an unselected candidate (warning not shown)', () => {
    expect(hasZeroLinks(makeCandidate({ selected: false, entityRefs: [] }))).toBe(false)
  })
})
