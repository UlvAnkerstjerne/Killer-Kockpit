/**
 * todo-enter-key-m8c3c.test.ts
 *
 * Unit tests for the shouldSubmitOnEnter pure helper exported from
 * TodoPageClient.  No DOM rendering required.
 *
 * Contracts verified:
 *   • Enter (no modifiers, non-blank title, not pending, not composing) → true
 *   • Blank title → false (do nothing)
 *   • Whitespace-only title → false
 *   • isPending true → false (no double-submit)
 *   • Shift+Enter → false (allow newline in textarea)
 *   • isComposing true → false (IME safety)
 *   • Any other key → false
 */

import { describe, it, expect } from 'vitest'
import { shouldSubmitOnEnter } from '@/app/(app)/todos/TodoPageClient'

// Shorthand: call with defaults overridden by the given partial
function check(
  overrides: Partial<{
    key: string
    shiftKey: boolean
    isComposing: boolean
    title: string
    isPending: boolean
  }>,
): boolean {
  const {
    key        = 'Enter',
    shiftKey   = false,
    isComposing = false,
    title      = 'Buy milk',
    isPending  = false,
  } = overrides
  return shouldSubmitOnEnter(key, shiftKey, isComposing, title, isPending)
}

describe('shouldSubmitOnEnter', () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns true for Enter with a valid title', () => {
    expect(check({})).toBe(true)
  })

  it('returns true when notes are present and title is non-blank', () => {
    // The helper only cares about title, not notes — notes are captured via state
    expect(check({ title: 'Fix the printer' })).toBe(true)
  })

  // ── Blank / whitespace guards ──────────────────────────────────────────────

  it('returns false when title is empty string', () => {
    expect(check({ title: '' })).toBe(false)
  })

  it('returns false when title is whitespace only', () => {
    expect(check({ title: '   ' })).toBe(false)
  })

  it('returns false when title is tab characters only', () => {
    expect(check({ title: '\t\t' })).toBe(false)
  })

  // ── isPending guard ────────────────────────────────────────────────────────

  it('returns false when isPending is true (prevents double-submit)', () => {
    expect(check({ isPending: true })).toBe(false)
  })

  // ── Shift+Enter → newline, not submit ────────────────────────────────────

  it('returns false for Shift+Enter', () => {
    expect(check({ shiftKey: true })).toBe(false)
  })

  // ── IME composition guard ─────────────────────────────────────────────────

  it('returns false when isComposing is true', () => {
    expect(check({ isComposing: true })).toBe(false)
  })

  // ── Other keys ────────────────────────────────────────────────────────────

  it('returns false for Escape', () => {
    expect(check({ key: 'Escape' })).toBe(false)
  })

  it('returns false for Space', () => {
    expect(check({ key: ' ' })).toBe(false)
  })

  it('returns false for Tab', () => {
    expect(check({ key: 'Tab' })).toBe(false)
  })

  it('returns false for a regular character key', () => {
    expect(check({ key: 'a' })).toBe(false)
  })

  // ── Combined guards ───────────────────────────────────────────────────────

  it('returns false when both isPending and isComposing are true', () => {
    expect(check({ isPending: true, isComposing: true })).toBe(false)
  })

  it('returns false when Shift+Enter even with valid title and not pending', () => {
    expect(check({ shiftKey: true, title: 'Valid title', isPending: false })).toBe(false)
  })

  it('returns false when isComposing even with Enter and valid title', () => {
    expect(check({ key: 'Enter', isComposing: true, title: 'Valid title' })).toBe(false)
  })
})
