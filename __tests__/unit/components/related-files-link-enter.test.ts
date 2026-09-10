/**
 * related-files-link-enter.test.ts
 *
 * Unit tests for the shouldAttachLink pure helper exported from
 * RelatedFilesSection.tsx.
 *
 * Contracts verified:
 *   • Enter + non-blank URL + not composing + not attaching → true  (happy path)
 *   • Blank URL → false (do nothing)
 *   • Whitespace-only URL → false
 *   • attaching true → false (no double submit)
 *   • isComposing true → false (IME safety)
 *   • Any other key → false
 *   • Button submit path: button attach still works (covered by the fact that
 *     form onSubmit calls the same handleAttach guard — the helper is agnostic
 *     to the trigger path)
 */

import { describe, it, expect, vi } from 'vitest'
import { shouldAttachLink } from '@/components/drive/RelatedFilesSection'

// RelatedFilesSection is a 'use client' file — mock Next.js deps it imports.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/actions/drive', () => ({
  attachDriveFile: vi.fn(),
  detachDriveFile: vi.fn(),
}))

// Shorthand: run with sensible defaults and override as needed.
function check(
  overrides: Partial<{
    key: string
    isComposing: boolean
    url: string
    attaching: boolean
  }>,
): boolean {
  const {
    key         = 'Enter',
    isComposing = false,
    url         = 'https://drive.google.com/file/d/abc',
    attaching   = false,
  } = overrides
  return shouldAttachLink(key, isComposing, url, attaching)
}

describe('shouldAttachLink', () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns true for Enter with a valid URL', () => {
    expect(check({})).toBe(true)
  })

  it('returns true for any non-blank URL value', () => {
    expect(check({ url: 'https://docs.google.com/d/xyz' })).toBe(true)
  })

  // ── Blank / whitespace guards ──────────────────────────────────────────────

  it('returns false when URL is empty string', () => {
    expect(check({ url: '' })).toBe(false)
  })

  it('returns false when URL is whitespace only', () => {
    expect(check({ url: '   ' })).toBe(false)
  })

  it('returns false when URL is tab characters only', () => {
    expect(check({ url: '\t\t' })).toBe(false)
  })

  // ── Double-submit guard ────────────────────────────────────────────────────

  it('returns false when attaching is true (prevents double submit)', () => {
    expect(check({ attaching: true })).toBe(false)
  })

  // ── IME composition guard ─────────────────────────────────────────────────

  it('returns false when isComposing is true', () => {
    expect(check({ isComposing: true })).toBe(false)
  })

  it('returns false when both isComposing and attaching are true', () => {
    expect(check({ isComposing: true, attaching: true })).toBe(false)
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

  it('returns false when isComposing even with Enter and valid URL', () => {
    expect(check({ key: 'Enter', isComposing: true, url: 'https://drive.google.com/x' })).toBe(false)
  })

  it('returns false when attaching even with Enter and valid URL', () => {
    expect(check({ key: 'Enter', attaching: true, url: 'https://drive.google.com/x' })).toBe(false)
  })
})
