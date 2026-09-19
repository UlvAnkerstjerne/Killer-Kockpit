/**
 * Source-contract tests for app/(app)/meetings/[id]/MeetingActions.tsx
 *
 * Verifies that:
 *   - openMeeting and closeMeeting are NOT present (buttons removed in correction pass)
 *   - cancelMeeting IS present
 *   - Review & publish link IS present for draft meetings
 *   - Reopen button IS present for cancelled meetings
 *
 * These tests read the component source file to verify the contract without
 * requiring a full React rendering environment. They protect against accidental
 * reintroduction of the removed manual controls.
 */

import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const COMPONENT_PATH = resolve(
  __dirname,
  '../../../app/(app)/meetings/[id]/MeetingActions.tsx',
)

describe('MeetingActions — manual controls removed', () => {
  // \bopenMeeting\b uses word boundaries — matches standalone "openMeeting"
  // but NOT "reopenMeeting" (where 'r' and 'o' are both word chars, so no boundary)
  it('does not reference openMeeting as a standalone identifier', async () => {
    const src = await readFile(COMPONENT_PATH, 'utf-8')
    expect(src).not.toMatch(/\bopenMeeting\b/)
  })

  it('does not reference closeMeeting as a standalone identifier', async () => {
    const src = await readFile(COMPONENT_PATH, 'utf-8')
    expect(src).not.toMatch(/\bcloseMeeting\b/)
  })

  it('does not contain the "Manual controls" toggle text', async () => {
    const src = await readFile(COMPONENT_PATH, 'utf-8')
    expect(src).not.toContain('Manual controls')
  })

  it('does not contain "Mark as started" button text', async () => {
    const src = await readFile(COMPONENT_PATH, 'utf-8')
    expect(src).not.toContain('Mark as started')
  })

  it('does not contain "Close to draft" button text', async () => {
    const src = await readFile(COMPONENT_PATH, 'utf-8')
    expect(src).not.toContain('Close to draft')
  })
})

describe('MeetingActions — core actions present', () => {
  it('imports and uses cancelMeeting', async () => {
    const src = await readFile(COMPONENT_PATH, 'utf-8')
    expect(src).toContain('cancelMeeting')
  })

  it('imports and uses reopenMeeting (for cancelled meetings)', async () => {
    const src = await readFile(COMPONENT_PATH, 'utf-8')
    expect(src).toContain('reopenMeeting')
  })

  it('shows Review & publish link when status is draft', async () => {
    const src = await readFile(COMPONENT_PATH, 'utf-8')
    // The draft status gate must exist
    expect(src).toContain("status === 'draft'")
    // The publish route must be linked
    expect(src).toContain('/publish')
  })

  it('shows Cancel meeting button for scheduled/open/draft meetings', async () => {
    const src = await readFile(COMPONENT_PATH, 'utf-8')
    expect(src).toContain('Cancel meeting')
  })
})
