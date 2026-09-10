/**
 * review-panel-inline.test.ts
 *
 * Unit tests for the pure helpers exported from ReviewPanel.tsx:
 *   outcomeSupportsInlineEdit  — which kinds show Responsible + Due chips
 *   getResponsibleName         — extracts display name from owner_user_id
 *   formatReviewDue            — compact UTC → Copenhagen date string
 *   buildInlinePayload         — merges one field into existing payload
 *
 * Environment: Node (no jsdom, no React). Pure-function tests only.
 *
 * Invariants verified:
 *   • task and waiting_on support inline edit; decision does not
 *   • getResponsibleName resolves correctly and never exposes due_at as name
 *   • formatReviewDue returns null for absent dates
 *   • buildInlinePayload never touches fields other than the one being changed
 *     (changing Responsible does NOT reset Due, and vice versa)
 *   • confirm uses human-edited values: payload_json.owner_user_id / due_at
 *     are exactly what publish_meeting_and_audit reads — so inline edits are
 *     canonical after updateMeetingOutcome persists them
 *   • Owner semantics unchanged: created_by_user_id comes from the publish
 *     actor (p_actor_user_id), NOT from payload_json — inline edits to
 *     owner_user_id only affect the Responsible, never the Owner/Requester
 */

import { describe, it, expect, vi } from 'vitest'
import {
  outcomeSupportsInlineEdit,
  getResponsibleName,
  formatReviewDue,
  buildInlinePayload,
} from '@/app/(app)/meetings/[id]/publish/ReviewPanel'

// ReviewPanel is a 'use client' file — mock Next.js deps it imports.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('next/link', () => ({ default: 'a' }))
vi.mock('@/lib/actions/meetings', () => ({
  updateMeeting: vi.fn(),
  publishMeeting: vi.fn(),
}))
vi.mock('@/lib/actions/meeting-outcomes', () => ({
  updateMeetingOutcome: vi.fn(),
  removeMeetingOutcome: vi.fn(),
}))

const USERS = [
  { id: 'u-1', display_name: 'Alice' },
  { id: 'u-2', display_name: 'Bob' },
]

// ─── outcomeSupportsInlineEdit ────────────────────────────────────────────────

describe('outcomeSupportsInlineEdit', () => {
  it('returns true for task', () => {
    expect(outcomeSupportsInlineEdit('task')).toBe(true)
  })

  it('returns true for waiting_on', () => {
    expect(outcomeSupportsInlineEdit('waiting_on')).toBe(true)
  })

  it('returns false for decision — no Responsible or Due concept', () => {
    expect(outcomeSupportsInlineEdit('decision')).toBe(false)
  })
})

// ─── getResponsibleName ───────────────────────────────────────────────────────

describe('getResponsibleName', () => {
  it('resolves owner_user_id to display name', () => {
    expect(getResponsibleName({ owner_user_id: 'u-1' }, USERS)).toBe('Alice')
  })

  it('returns null when owner_user_id is absent', () => {
    expect(getResponsibleName({}, USERS)).toBeNull()
  })

  it('returns null when owner_user_id is empty string', () => {
    expect(getResponsibleName({ owner_user_id: '' }, USERS)).toBeNull()
  })

  it('returns null when user is not in the list', () => {
    expect(getResponsibleName({ owner_user_id: 'u-999' }, USERS)).toBeNull()
  })

  it('resolves Bob correctly', () => {
    expect(getResponsibleName({ owner_user_id: 'u-2' }, USERS)).toBe('Bob')
  })

  it('does not confuse due_at with owner', () => {
    // due_at is a separate field — should not affect Responsible lookup
    const payload = { owner_user_id: 'u-1', due_at: '2026-09-20T12:00:00Z' }
    expect(getResponsibleName(payload, USERS)).toBe('Alice')
  })

  it('returns null with empty user list', () => {
    expect(getResponsibleName({ owner_user_id: 'u-1' }, [])).toBeNull()
  })
})

// ─── formatReviewDue ──────────────────────────────────────────────────────────

describe('formatReviewDue', () => {
  it('returns null for null input', () => {
    expect(formatReviewDue(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(formatReviewDue(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(formatReviewDue('')).toBeNull()
  })

  it('returns a non-empty string for a valid ISO date', () => {
    const result = formatReviewDue('2026-09-15T12:00:00Z')
    expect(result).toBeTruthy()
    expect(typeof result).toBe('string')
  })

  it('includes the day number in the result', () => {
    const result = formatReviewDue('2026-09-15T12:00:00Z')
    expect(result).toMatch(/15/)
  })

  it('includes the month name abbreviation', () => {
    const result = formatReviewDue('2026-09-15T12:00:00Z')
    expect(result).toMatch(/Sept?/)
  })
})

// ─── buildInlinePayload ───────────────────────────────────────────────────────

describe('buildInlinePayload', () => {
  const basePayload = {
    owner_user_id: 'u-1',
    due_at: '2026-09-20T12:00:00Z',
    priority: 2,
    project_id: 'proj-1',
  }

  it('sets owner_user_id without touching due_at', () => {
    const result = buildInlinePayload(basePayload, 'owner_user_id', 'u-2')
    expect(result.owner_user_id).toBe('u-2')
    expect(result.due_at).toBe('2026-09-20T12:00:00Z')
    // Other fields preserved
    expect(result.priority).toBe(2)
    expect(result.project_id).toBe('proj-1')
  })

  it('sets due_at without touching owner_user_id', () => {
    const result = buildInlinePayload(basePayload, 'due_at', '2026-10-01T08:00:00Z')
    expect(result.due_at).toBe('2026-10-01T08:00:00Z')
    expect(result.owner_user_id).toBe('u-1')
    // Other fields preserved
    expect(result.priority).toBe(2)
    expect(result.project_id).toBe('proj-1')
  })

  it('allows clearing owner_user_id to null', () => {
    const result = buildInlinePayload(basePayload, 'owner_user_id', null)
    expect(result.owner_user_id).toBeNull()
    expect(result.due_at).toBe('2026-09-20T12:00:00Z')
  })

  it('allows clearing due_at to null', () => {
    const result = buildInlinePayload(basePayload, 'due_at', null)
    expect(result.due_at).toBeNull()
    expect(result.owner_user_id).toBe('u-1')
  })

  it('does not mutate the original payload', () => {
    const original = { owner_user_id: 'u-1', due_at: '2026-09-20T12:00:00Z' }
    buildInlinePayload(original, 'owner_user_id', 'u-2')
    expect(original.owner_user_id).toBe('u-1')
  })

  // Semantics regression: inline owner_user_id edit targets RESPONSIBLE only.
  // The canonical task's created_by_user_id (Owner) is set to p_actor_user_id
  // by publish_meeting_and_audit — it never comes from payload_json — so inline
  // edits to owner_user_id cannot accidentally change the Owner/Requester.
  it('only has owner_user_id in payload — not created_by_user_id', () => {
    const result = buildInlinePayload(basePayload, 'owner_user_id', 'u-2')
    expect('created_by_user_id' in result).toBe(false)
  })
})

// ─── Unsupported outcome types do not get inline controls ────────────────────

describe('decision does not support Responsible or Due inline controls', () => {
  it('outcomeSupportsInlineEdit("decision") is false — no chips rendered', () => {
    // This is the guard used in ReviewPanel JSX:
    // {supportsInline && !isEditing && ( <Responsible chip> <Due chip> )}
    // When false, no chips are rendered for decisions.
    expect(outcomeSupportsInlineEdit('decision')).toBe(false)
  })

  it('task supports both Responsible and Due', () => {
    expect(outcomeSupportsInlineEdit('task')).toBe(true)
  })

  it('waiting_on supports both Responsible and Due', () => {
    expect(outcomeSupportsInlineEdit('waiting_on')).toBe(true)
  })
})

// ─── Review state persistence flow ───────────────────────────────────────────
//
// The review state IS the database: updateMeetingOutcome persists to
// meeting_outcomes.payload_json immediately. publish_meeting_and_audit then
// reads that payload to create canonical Tasks/WaitingOns. So:
//
//   inline change → updateMeetingOutcome(payload_json) → DB
//   publish → reads payload_json → creates Task with owner_user_id (Responsible)
//                                  and created_by_user_id = p_actor_user_id (Owner)
//
// The tests below verify the PAYLOAD SHAPE that will be persisted and later
// used by publish_meeting_and_audit. They do not test the server action itself.

describe('payload shape used on confirm', () => {
  it('buildInlinePayload produces the correct shape for a task Responsible change', () => {
    const taskPayload = { owner_user_id: null, priority: 2, due_at: null, project_id: null }
    const updated = buildInlinePayload(taskPayload, 'owner_user_id', 'u-1')
    // publish_meeting_and_audit reads payload_json->>'owner_user_id' for task.owner_user_id
    expect(updated.owner_user_id).toBe('u-1')
    // priority and other fields unchanged
    expect(updated.priority).toBe(2)
  })

  it('buildInlinePayload produces the correct shape for a task Due change', () => {
    const utcIso = '2026-09-20T07:00:00.000Z'
    const taskPayload = { owner_user_id: 'u-1', priority: 2, due_at: null, project_id: null }
    const updated = buildInlinePayload(taskPayload, 'due_at', utcIso)
    // publish_meeting_and_audit reads payload_json->>'due_at'::timestamptz
    expect(updated.due_at).toBe(utcIso)
    expect(updated.owner_user_id).toBe('u-1')
  })

  it('buildInlinePayload produces the correct shape for a waiting_on Responsible change', () => {
    const woPayload = {
      owner_user_id: null,
      waiting_for_user_id: 'u-2',
      due_at: null,
      project_id: null,
    }
    const updated = buildInlinePayload(woPayload, 'owner_user_id', 'u-1')
    // waiting_for_user_id is preserved — only owner_user_id changed
    expect(updated.owner_user_id).toBe('u-1')
    expect(updated.waiting_for_user_id).toBe('u-2')
  })
})
