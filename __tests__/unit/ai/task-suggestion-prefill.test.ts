/**
 * Tests for lib/ai/task-suggestion-prefill.ts
 *
 * Verifies:
 *   resolveTaskOwner:
 *     - responsible.type === 'current_user' → returns currentUserId
 *     - responsible.type === 'named_person' with unambiguous match → returns matched user id
 *     - responsible.type === 'named_person' with no match → returns currentUserId
 *     - responsible.type === 'named_person' with ambiguous match → returns currentUserId
 *     - responsible.type === 'named_person' with partial name match → returns matched user id
 *     - responsible.type === 'unknown' → returns currentUserId
 *
 *   priorityFromHint:
 *     - 'high'   → 1 (Critical)
 *     - 'normal' → 2 (Normal)
 *     - 'low'    → 3 (Low)
 *     - null     → 2 (Normal, default)
 */

import { describe, it, expect } from 'vitest'
import { resolveTaskOwner, priorityFromHint } from '@/lib/ai/task-suggestion-prefill'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CURRENT_USER_ID = 'user-current-uuid'

const USERS = [
  { id: 'user-current-uuid',  display_name: 'Ulv Ankerstjerne' },
  { id: 'user-kasper-uuid',   display_name: 'Kasper Kristiansen' },
  { id: 'user-sara-uuid',     display_name: 'Sara Jørgensen' },
  { id: 'user-adam-uuid',     display_name: 'Adam Vearey' },
]

// ── resolveTaskOwner ──────────────────────────────────────────────────────────

describe('resolveTaskOwner', () => {
  describe('current_user', () => {
    it('returns currentUserId regardless of display_name', () => {
      expect(resolveTaskOwner(
        { type: 'current_user', display_name: null },
        USERS,
        CURRENT_USER_ID,
      )).toBe(CURRENT_USER_ID)
    })

    it('returns currentUserId even when display_name is non-null', () => {
      // Model should not set display_name for current_user, but be defensive
      expect(resolveTaskOwner(
        { type: 'current_user', display_name: 'Kasper Kristiansen' },
        USERS,
        CURRENT_USER_ID,
      )).toBe(CURRENT_USER_ID)
    })
  })

  describe('named_person — unambiguous match', () => {
    it('exact match returns that user id', () => {
      expect(resolveTaskOwner(
        { type: 'named_person', display_name: 'Kasper Kristiansen' },
        USERS,
        CURRENT_USER_ID,
      )).toBe('user-kasper-uuid')
    })

    it('case-insensitive exact match returns that user id', () => {
      expect(resolveTaskOwner(
        { type: 'named_person', display_name: 'kasper kristiansen' },
        USERS,
        CURRENT_USER_ID,
      )).toBe('user-kasper-uuid')
    })

    it('partial name match (user display_name contains needle) returns that user id', () => {
      // Needle is a substring of the user's name
      expect(resolveTaskOwner(
        { type: 'named_person', display_name: 'Kasper' },
        USERS,
        CURRENT_USER_ID,
      )).toBe('user-kasper-uuid')
    })

    it('needle contains user display_name (abbreviated sender) returns that user id', () => {
      // Needle "Adam Vearey (adam@kk.com)" contains the user's display name
      expect(resolveTaskOwner(
        { type: 'named_person', display_name: 'Adam Vearey (adam@kk.com)' },
        USERS,
        CURRENT_USER_ID,
      )).toBe('user-adam-uuid')
    })
  })

  describe('named_person — no match', () => {
    it('unknown name → returns currentUserId', () => {
      expect(resolveTaskOwner(
        { type: 'named_person', display_name: 'Completely Unknown Person' },
        USERS,
        CURRENT_USER_ID,
      )).toBe(CURRENT_USER_ID)
    })

    it('null display_name → returns currentUserId', () => {
      expect(resolveTaskOwner(
        { type: 'named_person', display_name: null },
        USERS,
        CURRENT_USER_ID,
      )).toBe(CURRENT_USER_ID)
    })
  })

  describe('named_person — ambiguous match', () => {
    it('multiple matches → returns currentUserId, never guesses', () => {
      const AMBIGUOUS_USERS = [
        { id: 'user-sara-1', display_name: 'Sara Jensen' },
        { id: 'user-sara-2', display_name: 'Sara Lund' },
        { id: 'user-current-uuid', display_name: 'Ulv Ankerstjerne' },
      ]
      // "Sara" matches both Sara Jensen and Sara Lund
      expect(resolveTaskOwner(
        { type: 'named_person', display_name: 'Sara' },
        AMBIGUOUS_USERS,
        CURRENT_USER_ID,
      )).toBe(CURRENT_USER_ID)
    })
  })

  describe('unknown', () => {
    it('returns currentUserId', () => {
      expect(resolveTaskOwner(
        { type: 'unknown', display_name: null },
        USERS,
        CURRENT_USER_ID,
      )).toBe(CURRENT_USER_ID)
    })
  })
})

// ── priorityFromHint ──────────────────────────────────────────────────────────

describe('priorityFromHint', () => {
  it("'high' → 1 (Critical)", () => {
    expect(priorityFromHint('high')).toBe(1)
  })

  it("'normal' → 2 (Normal)", () => {
    expect(priorityFromHint('normal')).toBe(2)
  })

  it("'low' → 3 (Low)", () => {
    expect(priorityFromHint('low')).toBe(3)
  })

  it('null → 2 (Normal, default when model cannot infer)', () => {
    expect(priorityFromHint(null)).toBe(2)
  })
})
