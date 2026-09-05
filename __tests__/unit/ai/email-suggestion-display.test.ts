/**
 * Tests for lib/ai/email-suggestion-display.ts
 *
 * Pure node-level tests. No DOM, no async, no mocks needed.
 *
 * Coverage maps to M7E-C1 test requirements:
 *   • All four suggestion kinds produce human-readable labels
 *   • Null optional fields are omitted from detail rows
 *   • current_user responsibility renders as "You"
 *   • named_person responsibility renders the display name (no UUID)
 *   • unknown responsibility renders nothing
 *   • Date formatting (date-only and ISO timestamp)
 *   • Meeting: scheduled_start and scheduled_end rendered
 *   • Waiting on: waiting_for_name rendered
 *   • Task: responsible, due, priority_hint rendered
 *   • To-Do: scheduled_for rendered
 */

import { describe, it, expect } from 'vitest'
import {
  kindLabel,
  formatResponsible,
  formatDisplayDate,
  formatDisplayTime,
  suggestionDetails,
  kindBadgeClass,
} from '@/lib/ai/email-suggestion-display'

// ─── kindLabel ────────────────────────────────────────────────────────────────

describe('kindLabel', () => {
  it('todo → "To-Do"', () => {
    expect(kindLabel('todo')).toBe('To-Do')
  })

  it('task → "Task"', () => {
    expect(kindLabel('task')).toBe('Task')
  })

  it('waiting_on → "Waiting On"', () => {
    expect(kindLabel('waiting_on')).toBe('Waiting On')
  })

  it('meeting → "Meeting"', () => {
    expect(kindLabel('meeting')).toBe('Meeting')
  })
})

// ─── kindBadgeClass ───────────────────────────────────────────────────────────

describe('kindBadgeClass', () => {
  it('returns a non-empty class string for all four kinds', () => {
    for (const kind of ['todo', 'task', 'waiting_on', 'meeting'] as const) {
      expect(kindBadgeClass(kind).length).toBeGreaterThan(0)
    }
  })

  it('each kind has a distinct badge class', () => {
    const classes = ['todo', 'task', 'waiting_on', 'meeting'].map((k) =>
      kindBadgeClass(k as 'todo' | 'task' | 'waiting_on' | 'meeting'),
    )
    const unique = new Set(classes)
    expect(unique.size).toBe(4)
  })
})

// ─── formatResponsible ───────────────────────────────────────────────────────

describe('formatResponsible', () => {
  it('current_user → "You" (renders sensibly without a name)', () => {
    expect(formatResponsible({ type: 'current_user', display_name: null })).toBe('You')
  })

  it('named_person with display_name → returns the display name (free text, not UUID)', () => {
    const result = formatResponsible({ type: 'named_person', display_name: 'Alice Smith' })
    expect(result).toBe('Alice Smith')
    // Must not be a UUID
    expect(result).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('named_person with null display_name → null (omit rather than display "null")', () => {
    expect(formatResponsible({ type: 'named_person', display_name: null })).toBeNull()
  })

  it('unknown → null', () => {
    expect(formatResponsible({ type: 'unknown', display_name: null })).toBeNull()
  })
})

// ─── formatDisplayDate ───────────────────────────────────────────────────────

describe('formatDisplayDate', () => {
  it('null input → null', () => {
    expect(formatDisplayDate(null)).toBeNull()
  })

  it('parses YYYY-MM-DD date-only string', () => {
    const result = formatDisplayDate('2026-09-11')
    expect(result).not.toBeNull()
    expect(result).toContain('Sep')
    expect(result).toContain('2026')
  })

  it('parses full ISO timestamp', () => {
    const result = formatDisplayDate('2026-09-08T10:00:00+02:00')
    expect(result).not.toBeNull()
    expect(result).toContain('Sep')
    expect(result).toContain('2026')
  })

  it('invalid string → null', () => {
    expect(formatDisplayDate('not-a-date')).toBeNull()
  })
})

// ─── formatDisplayTime ───────────────────────────────────────────────────────

describe('formatDisplayTime', () => {
  it('null input → null', () => {
    expect(formatDisplayTime(null)).toBeNull()
  })

  it('parses ISO timestamp and returns a time string', () => {
    const result = formatDisplayTime('2026-09-08T10:00:00Z')
    expect(result).not.toBeNull()
    // Should look like HH:MM
    expect(result).toMatch(/\d{2}:\d{2}/)
  })

  it('invalid string → null', () => {
    expect(formatDisplayTime('not-a-date')).toBeNull()
  })
})

// ─── suggestionDetails ───────────────────────────────────────────────────────

describe('suggestionDetails — null fields omitted', () => {
  it('todo with null scheduled_for → empty details', () => {
    const details = suggestionDetails({
      kind: 'todo', title: 'Do something', reason: 'Reason',
      evidence: null, scheduled_for: null,
    })
    expect(details).toHaveLength(0)
  })

  it('todo with scheduled_for → one Scheduled detail', () => {
    const details = suggestionDetails({
      kind: 'todo', title: 'Do something', reason: 'Reason',
      evidence: null, scheduled_for: '2026-09-11',
    })
    expect(details).toHaveLength(1)
    expect(details[0].label).toBe('Scheduled')
    expect(details[0].value).toContain('Sep')
  })

  it('task with all null optional fields → empty details', () => {
    const details = suggestionDetails({
      kind: 'task', title: 'T', reason: 'R', evidence: null,
      responsible: { type: 'unknown', display_name: null },
      due_at: null, priority_hint: null,
    })
    expect(details).toHaveLength(0)
  })

  it('task with current_user responsible → "Responsible: You"', () => {
    const details = suggestionDetails({
      kind: 'task', title: 'T', reason: 'R', evidence: null,
      responsible: { type: 'current_user', display_name: null },
      due_at: null, priority_hint: null,
    })
    const resp = details.find((d) => d.label === 'Responsible')
    expect(resp).toBeDefined()
    expect(resp!.value).toBe('You')
  })

  it('task with named_person → "Responsible: Alice Smith"', () => {
    const details = suggestionDetails({
      kind: 'task', title: 'T', reason: 'R', evidence: null,
      responsible: { type: 'named_person', display_name: 'Alice Smith' },
      due_at: null, priority_hint: null,
    })
    const resp = details.find((d) => d.label === 'Responsible')
    expect(resp).toBeDefined()
    expect(resp!.value).toBe('Alice Smith')
  })

  it('task with due_at → "Due" detail present', () => {
    const details = suggestionDetails({
      kind: 'task', title: 'T', reason: 'R', evidence: null,
      responsible: { type: 'unknown', display_name: null },
      due_at: '2026-09-12T00:00:00Z', priority_hint: null,
    })
    expect(details.find((d) => d.label === 'Due')).toBeDefined()
  })

  it('task with priority_hint high → "Priority: High"', () => {
    const details = suggestionDetails({
      kind: 'task', title: 'T', reason: 'R', evidence: null,
      responsible: { type: 'unknown', display_name: null },
      due_at: null, priority_hint: 'high',
    })
    const prio = details.find((d) => d.label === 'Priority')
    expect(prio).toBeDefined()
    expect(prio!.value).toBe('High')
  })

  it('task with priority_hint normal or low → no Priority detail', () => {
    for (const hint of ['normal', 'low'] as const) {
      const details = suggestionDetails({
        kind: 'task', title: 'T', reason: 'R', evidence: null,
        responsible: { type: 'unknown', display_name: null },
        due_at: null, priority_hint: hint,
      })
      expect(details.find((d) => d.label === 'Priority')).toBeUndefined()
    }
  })

  it('waiting_on with waiting_for_name → "Waiting on" detail', () => {
    const details = suggestionDetails({
      kind: 'waiting_on', title: 'T', reason: 'R', evidence: null,
      waiting_for_name: 'Legal team', due_at: null,
    })
    expect(details.find((d) => d.label === 'Waiting on')?.value).toBe('Legal team')
  })

  it('waiting_on with null waiting_for_name → no Waiting on detail', () => {
    const details = suggestionDetails({
      kind: 'waiting_on', title: 'T', reason: 'R', evidence: null,
      waiting_for_name: null, due_at: null,
    })
    expect(details.find((d) => d.label === 'Waiting on')).toBeUndefined()
  })

  it('meeting with scheduled_start → "When" detail', () => {
    const details = suggestionDetails({
      kind: 'meeting', title: 'Sync', reason: 'R', evidence: null,
      scheduled_start: '2026-09-08T10:00:00Z',
      scheduled_end: null, location: null,
    })
    expect(details.find((d) => d.label === 'When')).toBeDefined()
  })

  it('meeting with scheduled_end → "Until" detail', () => {
    const details = suggestionDetails({
      kind: 'meeting', title: 'Sync', reason: 'R', evidence: null,
      scheduled_start: '2026-09-08T10:00:00Z',
      scheduled_end: '2026-09-08T11:00:00Z',
      location: null,
    })
    expect(details.find((d) => d.label === 'Until')).toBeDefined()
  })

  it('meeting with location → "Where" detail', () => {
    const details = suggestionDetails({
      kind: 'meeting', title: 'Sync', reason: 'R', evidence: null,
      scheduled_start: null, scheduled_end: null,
      location: 'Conference Room A',
    })
    expect(details.find((d) => d.label === 'Where')?.value).toBe('Conference Room A')
  })

  it('meeting with all null optional fields → empty details', () => {
    const details = suggestionDetails({
      kind: 'meeting', title: 'Sync', reason: 'R', evidence: null,
      scheduled_start: null, scheduled_end: null, location: null,
    })
    expect(details).toHaveLength(0)
  })
})
