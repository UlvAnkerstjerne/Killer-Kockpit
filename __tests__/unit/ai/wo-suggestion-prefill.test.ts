/**
 * Tests for lib/ai/wo-suggestion-prefill.ts
 *
 * Verifies resolveWaitingFor():
 *   - null waiting_for_name → blank (human must fill)
 *   - unique internal match → { type: 'internal', userId }
 *   - case-insensitive exact match → internal
 *   - partial name match (unique) → internal
 *   - ambiguous match (>1 users) → external, never guesses
 *   - no match → external free text
 *   - never produces both userId and name simultaneously
 */

import { describe, it, expect } from 'vitest'
import { resolveWaitingFor } from '@/lib/ai/wo-suggestion-prefill'

const USERS = [
  { id: 'user-adam-uuid',   display_name: 'Adam Vearey' },
  { id: 'user-kasper-uuid', display_name: 'Kasper Kristiansen' },
  { id: 'user-sara-uuid',   display_name: 'Sara Jørgensen' },
  { id: 'user-ulv-uuid',    display_name: 'Ulv Ankerstjerne' },
]

// ── null input ────────────────────────────────────────────────────────────────

describe('null waiting_for_name', () => {
  it('returns blank when waiting_for_name is null', () => {
    expect(resolveWaitingFor(null, USERS)).toEqual({ type: 'blank' })
  })
})

// ── unique internal match ─────────────────────────────────────────────────────

describe('unique internal match', () => {
  it('exact match → internal with correct userId', () => {
    expect(resolveWaitingFor('Adam Vearey', USERS)).toEqual({
      type: 'internal',
      userId: 'user-adam-uuid',
    })
  })

  it('case-insensitive exact match → internal', () => {
    expect(resolveWaitingFor('adam vearey', USERS)).toEqual({
      type: 'internal',
      userId: 'user-adam-uuid',
    })
  })

  it('partial first name (unique) → internal', () => {
    // "Adam" matches only Adam Vearey
    expect(resolveWaitingFor('Adam', USERS)).toEqual({
      type: 'internal',
      userId: 'user-adam-uuid',
    })
  })

  it('needle contains full display name → internal', () => {
    // e.g. "Adam Vearey (adam@kk.com)" contains "Adam Vearey"
    expect(resolveWaitingFor('Adam Vearey (adam@kk.com)', USERS)).toEqual({
      type: 'internal',
      userId: 'user-adam-uuid',
    })
  })
})

// ── external (no match) ───────────────────────────────────────────────────────

describe('external name — no match', () => {
  it('company name not in user list → external with original name', () => {
    const result = resolveWaitingFor('Westisland Media', USERS)
    expect(result).toEqual({ type: 'external', name: 'Westisland Media' })
  })

  it('unknown person → external', () => {
    const result = resolveWaitingFor('John Smith', USERS)
    expect(result).toEqual({ type: 'external', name: 'John Smith' })
  })
})

// ── ambiguous match ───────────────────────────────────────────────────────────

describe('ambiguous match — never guesses', () => {
  it('name matching multiple users → external, not internal', () => {
    const AMBIGUOUS_USERS = [
      { id: 'user-sara-1', display_name: 'Sara Jensen' },
      { id: 'user-sara-2', display_name: 'Sara Lund' },
      { id: 'user-ulv-uuid', display_name: 'Ulv Ankerstjerne' },
    ]
    // "Sara" matches both Sara Jensen and Sara Lund
    const result = resolveWaitingFor('Sara', AMBIGUOUS_USERS)
    expect(result.type).toBe('external')
    expect(result).not.toMatchObject({ type: 'internal' })
  })
})

// ── mutual exclusion ─────────────────────────────────────────────────────────

describe('mutual exclusion — never both userId and name', () => {
  it('internal result has no name field', () => {
    const result = resolveWaitingFor('Adam Vearey', USERS)
    expect(result.type).toBe('internal')
    expect(result).not.toHaveProperty('name')
  })

  it('external result has no userId field', () => {
    const result = resolveWaitingFor('Westisland Media', USERS)
    expect(result.type).toBe('external')
    expect(result).not.toHaveProperty('userId')
  })
})
