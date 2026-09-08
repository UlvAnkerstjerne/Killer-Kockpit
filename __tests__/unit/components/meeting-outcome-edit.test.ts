/**
 * __tests__/unit/components/meeting-outcome-edit.test.ts
 *
 * Tests for the pure helpers exported from OutcomesSection.tsx:
 *   payloadToForm  — payload_json → EditForm conversion
 *   formToPayload  — EditForm → payload_json conversion (per kind)
 *   outcomeMeta    — derives WHO / WHEN for the collapsed summary row
 *   shortDate      — compact date formatter
 *
 * Environment: Node (no jsdom, no React). Pure-function tests only.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  payloadToForm,
  formToPayload,
  outcomeMeta,
  shortDate,
} from '@/app/(app)/meetings/[id]/OutcomesSection'
import type { MeetingOutcome, MeetingOutcomeKind } from '@/lib/types'
import { wallToUtc, utcToWall } from '@/lib/time'

// OutcomesSection is a 'use client' file — mock Next.js deps it imports
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('next/link', () => ({ default: 'a' }))
vi.mock('@/lib/actions/meeting-outcomes', () => ({
  createMeetingOutcome: vi.fn(),
  removeMeetingOutcome: vi.fn(),
  updateMeetingOutcome: vi.fn(),
}))

afterEach(() => { vi.restoreAllMocks() })

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_OUTCOME: Omit<MeetingOutcome, 'kind' | 'title' | 'payload_json'> = {
  id: 'oc-1',
  meeting_id: 'mtg-1',
  status: 'proposed',
  proposed_by_user_id: null,
  published_entity_id: null,
  ai_draft_id: null,
  sort_order: 0,
  created_at: '2026-09-08T10:00:00Z',
  updated_at: '2026-09-08T10:00:00Z',
}

function makeOutcome(
  kind: MeetingOutcomeKind,
  title: string,
  payload: Record<string, unknown>,
): MeetingOutcome {
  return { ...BASE_OUTCOME, kind, title, payload_json: payload }
}

const USERS = [
  { id: 'u-1', display_name: 'Alice' },
  { id: 'u-2', display_name: 'Bob' },
]

// ─── shortDate ────────────────────────────────────────────────────────────────

describe('shortDate', () => {
  it('returns null for null input', () => {
    expect(shortDate(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(shortDate(undefined)).toBeNull()
  })

  it('returns a non-empty locale string for a valid ISO date', () => {
    const result = shortDate('2026-09-15T12:00:00Z')
    expect(result).toBeTruthy()
    expect(typeof result).toBe('string')
  })

  it('includes the day number in the result', () => {
    // In Europe/Copenhagen UTC+2, 12:00 UTC → 14:00 local → still 15 Sep
    const result = shortDate('2026-09-15T12:00:00Z')
    expect(result).toMatch(/15/)
  })
})

// ─── payloadToForm ────────────────────────────────────────────────────────────

describe('payloadToForm — task', () => {
  it('maps all task fields correctly', () => {
    const outcome = makeOutcome('task', 'Fix bug', {
      owner_user_id: 'u-1',
      priority: 2,
      due_at: '2026-09-20T14:00:00.000Z',
      project_id: 'proj-1',
    })
    const form = payloadToForm(outcome)
    expect(form.title).toBe('Fix bug')
    expect(form.owner_user_id).toBe('u-1')
    expect(form.priority).toBe('2')
    expect(form.project_id).toBe('proj-1')
    // due_at sliced to datetime-local format
    expect(form.due_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    // waiting_on / decision fields default to empty
    expect(form.waiting_for_user_id).toBe('')
    expect(form.waiting_for_name).toBe('')
    expect(form.decision_text).toBe('')
    expect(form.rationale).toBe('')
  })

  it('defaults priority to "2" when absent', () => {
    const outcome = makeOutcome('task', 'X', {})
    expect(payloadToForm(outcome).priority).toBe('2')
  })

  it('defaults due_at to empty string when absent', () => {
    const outcome = makeOutcome('task', 'X', {})
    expect(payloadToForm(outcome).due_at).toBe('')
  })
})

describe('payloadToForm — waiting_on', () => {
  it('maps waiting_for_user_id and waiting_for_name', () => {
    const outcome = makeOutcome('waiting_on', 'Waiting for docs', {
      owner_user_id: 'u-2',
      waiting_for_user_id: 'u-1',
      waiting_for_name: null,
      due_at: null,
      project_id: null,
    })
    const form = payloadToForm(outcome)
    expect(form.waiting_for_user_id).toBe('u-1')
    expect(form.waiting_for_name).toBe('')
    expect(form.owner_user_id).toBe('u-2')
  })

  it('maps external waiting_for_name when no user id', () => {
    const outcome = makeOutcome('waiting_on', 'Waiting for vendor', {
      waiting_for_user_id: null,
      waiting_for_name: 'Acme Corp',
    })
    const form = payloadToForm(outcome)
    expect(form.waiting_for_user_id).toBe('')
    expect(form.waiting_for_name).toBe('Acme Corp')
  })
})

describe('payloadToForm — decision', () => {
  it('maps decision_text and rationale', () => {
    const outcome = makeOutcome('decision', 'Move to cloud', {
      decision_text: 'We will migrate Q4.',
      rationale: 'Cost reduction.',
      owner_user_id: 'u-1',
    })
    const form = payloadToForm(outcome)
    expect(form.decision_text).toBe('We will migrate Q4.')
    expect(form.rationale).toBe('Cost reduction.')
    expect(form.owner_user_id).toBe('u-1')
  })
})

// ─── formToPayload ────────────────────────────────────────────────────────────

describe('formToPayload — task', () => {
  const base = {
    title: 'T', owner_user_id: 'u-1', priority: '1',
    due_at: '2026-10-01T09:00', project_id: 'p-1',
    waiting_for_user_id: '', waiting_for_name: '',
    decision_text: '', rationale: '',
  }

  it('returns task payload with correct types', () => {
    const p = formToPayload('task', base)
    expect(p.owner_user_id).toBe('u-1')
    expect(p.priority).toBe(1)          // Number(), not string
    // due_at is converted from Copenhagen wall-clock to UTC ISO
    expect(p.due_at).toBe(wallToUtc('2026-10-01T09:00'))
    expect(typeof p.due_at).toBe('string')
    expect(p.due_at as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(p.project_id).toBe('p-1')
    // waiting_on / decision fields must NOT appear
    expect('waiting_for_user_id' in p).toBe(false)
    expect('decision_text' in p).toBe(false)
  })

  it('converts empty owner to null', () => {
    const p = formToPayload('task', { ...base, owner_user_id: '' })
    expect(p.owner_user_id).toBeNull()
  })

  it('converts empty due_at to null', () => {
    const p = formToPayload('task', { ...base, due_at: '' })
    expect(p.due_at).toBeNull()
  })

  it('converts empty project_id to null', () => {
    const p = formToPayload('task', { ...base, project_id: '' })
    expect(p.project_id).toBeNull()
  })
})

describe('formToPayload — waiting_on', () => {
  const base = {
    title: 'W', owner_user_id: 'u-2', priority: '2',
    due_at: '', project_id: '',
    waiting_for_user_id: 'u-1', waiting_for_name: '',
    decision_text: '', rationale: '',
  }

  it('includes waiting_for_user_id when set', () => {
    const p = formToPayload('waiting_on', base)
    expect(p.waiting_for_user_id).toBe('u-1')
    // waiting_for_name must be null when user id is provided
    expect(p.waiting_for_name).toBeNull()
  })

  it('uses waiting_for_name when no user id selected', () => {
    const p = formToPayload('waiting_on', {
      ...base,
      waiting_for_user_id: '',
      waiting_for_name: 'Acme Corp',
    })
    expect(p.waiting_for_user_id).toBeNull()
    expect(p.waiting_for_name).toBe('Acme Corp')
  })

  it('sets both to null when neither provided', () => {
    const p = formToPayload('waiting_on', {
      ...base,
      waiting_for_user_id: '',
      waiting_for_name: '',
    })
    expect(p.waiting_for_user_id).toBeNull()
    expect(p.waiting_for_name).toBeNull()
  })
})

describe('formToPayload — decision', () => {
  const base = {
    title: 'D', owner_user_id: 'u-1', priority: '2',
    due_at: '', project_id: '',
    waiting_for_user_id: '', waiting_for_name: '',
    decision_text: 'We decided X.', rationale: 'Because Y.',
  }

  it('includes decision_text and rationale', () => {
    const p = formToPayload('decision', base)
    expect(p.decision_text).toBe('We decided X.')
    expect(p.rationale).toBe('Because Y.')
    expect(p.owner_user_id).toBe('u-1')
    // task / waiting_on fields must NOT appear
    expect('due_at' in p).toBe(false)
    expect('waiting_for_user_id' in p).toBe(false)
  })

  it('sets rationale to null when empty', () => {
    const p = formToPayload('decision', { ...base, rationale: '' })
    expect(p.rationale).toBeNull()
  })
})

// ─── outcomeMeta ──────────────────────────────────────────────────────────────

describe('outcomeMeta — task', () => {
  it('resolves owner display name as WHO', () => {
    const outcome = makeOutcome('task', 'Do work', { owner_user_id: 'u-1', due_at: null })
    const { who, when } = outcomeMeta(outcome, USERS)
    expect(who).toBe('Alice')
    expect(when).toBeNull()
  })

  it('returns who=null when owner not in user list', () => {
    const outcome = makeOutcome('task', 'X', { owner_user_id: 'u-999', due_at: null })
    const { who } = outcomeMeta(outcome, USERS)
    expect(who).toBeNull()
  })

  it('returns when from due_at', () => {
    const outcome = makeOutcome('task', 'X', {
      owner_user_id: null,
      due_at: '2026-09-20T12:00:00Z',
    })
    const { when } = outcomeMeta(outcome, USERS)
    expect(when).toBeTruthy()
    expect(when).toMatch(/20/)
  })

  it('returns both who and when when both are present', () => {
    const outcome = makeOutcome('task', 'X', {
      owner_user_id: 'u-2',
      due_at: '2026-09-20T12:00:00Z',
    })
    const { who, when } = outcomeMeta(outcome, USERS)
    expect(who).toBe('Bob')
    expect(when).toBeTruthy()
  })
})

describe('outcomeMeta — waiting_on', () => {
  it('resolves waiting_for_user_id as WHO', () => {
    const outcome = makeOutcome('waiting_on', 'Waiting', {
      waiting_for_user_id: 'u-1',
      waiting_for_name: null,
      due_at: null,
    })
    const { who } = outcomeMeta(outcome, USERS)
    expect(who).toBe('Alice')
  })

  it('falls back to waiting_for_name when no user id', () => {
    const outcome = makeOutcome('waiting_on', 'Waiting', {
      waiting_for_user_id: null,
      waiting_for_name: 'Acme Corp',
      due_at: null,
    })
    const { who } = outcomeMeta(outcome, USERS)
    expect(who).toBe('Acme Corp')
  })

  it('returns when from due_at', () => {
    const outcome = makeOutcome('waiting_on', 'W', {
      waiting_for_user_id: null,
      waiting_for_name: null,
      due_at: '2026-10-01T08:00:00Z',
    })
    const { when } = outcomeMeta(outcome, USERS)
    expect(when).toBeTruthy()
  })
})

describe('outcomeMeta — decision', () => {
  it('resolves owner as WHO for decisions', () => {
    const outcome = makeOutcome('decision', 'D', { owner_user_id: 'u-2' })
    const { who } = outcomeMeta(outcome, USERS)
    expect(who).toBe('Bob')
  })

  it('never returns WHEN for decisions', () => {
    const outcome = makeOutcome('decision', 'D', {
      owner_user_id: 'u-1',
      // even if due_at were present it should be ignored
      due_at: '2026-09-20T12:00:00Z',
    })
    const { when } = outcomeMeta(outcome, USERS)
    expect(when).toBeNull()
  })
})

describe('outcomeMeta — empty state', () => {
  it('returns both null when payload is empty and user list is empty', () => {
    const outcome = makeOutcome('task', 'X', {})
    const { who, when } = outcomeMeta(outcome, [])
    expect(who).toBeNull()
    expect(when).toBeNull()
  })
})

// ─── datetime-local display and save (Copenhagen wall-clock) ─────────────────
// payloadToForm converts stored UTC ISO → Copenhagen local YYYY-MM-DDTHH:MM (for input display).
// formToPayload converts Copenhagen local → UTC ISO (for DB storage via publish).

describe('datetime-local — display (payloadToForm)', () => {
  it('converts stored UTC midnight to Copenhagen local — Sep 15 midnight UTC = Sep 15 in CEST', () => {
    // Sep 15 2026 00:00 UTC = Sep 15 02:00 CEST; utcToWall gives "2026-09-15T02:00"
    const outcome = makeOutcome('task', 'X', { due_at: '2026-09-15T00:00:00.000Z' })
    const form = payloadToForm(outcome)
    expect(form.due_at).toBe(utcToWall('2026-09-15T00:00:00.000Z'))
    expect(form.due_at).toMatch(/^2026-09-15T/)
  })

  it('converts 14:00 UTC to Copenhagen local (16:00 CEST)', () => {
    const outcome = makeOutcome('task', 'X', { due_at: '2026-09-20T14:00:00.000Z' })
    const form = payloadToForm(outcome)
    expect(form.due_at).toBe('2026-09-20T16:00')  // CEST +2
  })

  it('converts CET winter time correctly (UTC+1)', () => {
    // Jan 15 2027 11:00 UTC = Jan 15 12:00 CET
    const outcome = makeOutcome('task', 'X', { due_at: '2027-01-15T11:00:00.000Z' })
    const form = payloadToForm(outcome)
    expect(form.due_at).toBe('2027-01-15T12:00')  // CET +1
  })

  it('leaves due_at empty when absent', () => {
    const outcome = makeOutcome('task', 'X', {})
    expect(payloadToForm(outcome).due_at).toBe('')
  })
})

describe('datetime-local — save (formToPayload)', () => {
  const base = {
    title: 'T', owner_user_id: '', priority: '2',
    due_at: '', project_id: '',
    waiting_for_user_id: '', waiting_for_name: '',
    decision_text: '', rationale: '',
  }

  it('converts Copenhagen wall-clock to UTC ISO on save (CEST summer)', () => {
    // 09:00 Copenhagen CEST (UTC+2) → 07:00 UTC
    const p = formToPayload('task', { ...base, due_at: '2026-09-15T09:00' })
    expect(p.due_at).toBe('2026-09-15T07:00:00.000Z')
  })

  it('converts Copenhagen wall-clock to UTC ISO on save (CET winter)', () => {
    // 12:00 Copenhagen CET (UTC+1) → 11:00 UTC
    const p = formToPayload('task', { ...base, due_at: '2027-01-15T12:00' })
    expect(p.due_at).toBe('2027-01-15T11:00:00.000Z')
  })

  it('round-trips: payloadToForm → formToPayload restores same UTC ISO', () => {
    const stored = '2026-09-15T07:00:00.000Z'
    const outcome = makeOutcome('task', 'X', { due_at: stored, priority: 2 })
    const form = payloadToForm(outcome)
    const payload = formToPayload('task', form)
    expect(payload.due_at).toBe(stored)
  })

  it('round-trip works for CET winter case', () => {
    const stored = '2027-01-15T11:00:00.000Z'
    const outcome = makeOutcome('task', 'X', { due_at: stored, priority: 2 })
    const form = payloadToForm(outcome)
    const payload = formToPayload('task', form)
    expect(payload.due_at).toBe(stored)
  })

  it('produces null for empty due_at', () => {
    const p = formToPayload('task', { ...base, due_at: '' })
    expect(p.due_at).toBeNull()
  })

  it('applies same conversion for waiting_on due_at', () => {
    const p = formToPayload('waiting_on', { ...base, due_at: '2026-09-20T09:00' })
    expect(p.due_at).toBe('2026-09-20T07:00:00.000Z')  // CEST -2h
  })
})

// ─── Immutability regression ───────────────────────────────────────────────────
// formToPayload must not include task fields in decision output and vice versa.

describe('formToPayload — cross-kind isolation', () => {
  const fullForm = {
    title: 'T', owner_user_id: 'u-1', priority: '2',
    due_at: '2026-10-01T09:00', project_id: 'p-1',
    waiting_for_user_id: 'u-2', waiting_for_name: 'Acme',
    decision_text: 'text', rationale: 'because',
  }

  it('decision payload has no due_at or project_id', () => {
    const p = formToPayload('decision', fullForm)
    expect('due_at' in p).toBe(false)
    expect('project_id' in p).toBe(false)
    expect('waiting_for_user_id' in p).toBe(false)
  })

  it('task payload has no decision_text or rationale', () => {
    const p = formToPayload('task', fullForm)
    expect('decision_text' in p).toBe(false)
    expect('rationale' in p).toBe(false)
    expect('waiting_for_user_id' in p).toBe(false)
  })

  it('waiting_on payload has no decision_text', () => {
    const p = formToPayload('waiting_on', fullForm)
    expect('decision_text' in p).toBe(false)
    expect('rationale' in p).toBe(false)
  })
})
