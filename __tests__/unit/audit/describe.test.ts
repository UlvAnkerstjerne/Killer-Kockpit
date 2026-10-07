import { describe, it, expect } from 'vitest'
import { collectReferencedIds, describeAuditEvent, humaniseAction, type AuditLookups } from '@/lib/audit/describe'

const lookups: AuditLookups = {
  users: new Map([['u-ulv', 'Ulv Kerstjerne'], ['u-sam', 'Sam Jensen']]),
  projects: new Map([['p-1', 'Airport launch']]),
}
const empty: AuditLookups = { users: new Map(), projects: new Map() }

describe('describeAuditEvent — the reported examples', () => {
  it('task.submitted_for_review reads as a sentence, not a code', () => {
    const d = describeAuditEvent(
      { action: 'task.submitted_for_review', before_json: { status: 'open' }, after_json: { status: 'pending_review' } },
      'task', lookups,
    )
    expect(d.title).toBe('Submitted for review')
    expect(JSON.stringify(d)).not.toContain('task.submitted_for_review')
  })

  it('admin.override shows the override note', () => {
    const d = describeAuditEvent(
      { action: 'admin.override', after_json: { note: 'Administrative override of task commitment terms' }, metadata: { is_admin_override: true } },
      'task', lookups,
    )
    expect(d.title).toBe('Administrator override')
    expect(d.lines).toEqual(['Administrative override of task commitment terms'])
  })

  it('drive_reference_attached shows the file name', () => {
    const d = describeAuditEvent(
      { action: 'drive_reference_attached', after_json: { file_id: 'abc', file_name: 'Lufthavn actionplaner', web_view_link: 'https://x' } },
      'task', lookups,
    )
    expect(d.title).toBe('Drive file attached')
    expect(d.lines).toEqual(['Lufthavn actionplaner'])
  })

  it('responsible change resolves user ids to names (task terminology: Responsible)', () => {
    const d = describeAuditEvent(
      { action: 'task.owner_user_id.changed', before_json: { owner_user_id: 'u-ulv' }, after_json: { owner_user_id: 'u-sam' } },
      'task', lookups,
    )
    expect(d.title).toBe('Responsible changed')
    expect(d.lines).toEqual(['Ulv Kerstjerne → Sam Jensen'])
  })

  it('projects keep the "Owner" label', () => {
    const d = describeAuditEvent(
      { action: 'project.owner_user_id.changed', before_json: { owner_user_id: 'u-ulv' }, after_json: { owner_user_id: 'u-sam' } },
      'project', lookups,
    )
    expect(d.title).toBe('Owner changed')
  })

  it('a same-day due-date change shows date AND time in Copenhagen with a zone label', () => {
    const d = describeAuditEvent(
      { action: 'task.due_at.changed', before_json: { due_at: '2026-10-07T08:00:00+00:00' }, after_json: { due_at: '2026-10-07T20:00' } },
      'task', lookups,
    )
    expect(d.title).toBe('Due date changed')
    expect(d.lines).toEqual(['7 Oct 2026, 10:00 CEST → 7 Oct 2026, 22:00 CEST'])
  })

  it('winter time uses CET', () => {
    const d = describeAuditEvent(
      { action: 'task.due_at.changed', before_json: { due_at: null }, after_json: { due_at: '2026-12-01T11:00:00+00:00' } },
      'task', lookups,
    )
    expect(d.lines).toEqual(['None → 1 Dec 2026, 12:00 CET'])
  })

  it('legacy no-op due-date rows (same instant, different string format) are labelled as unchanged', () => {
    const d = describeAuditEvent(
      { action: 'task.due_at.changed', before_json: { due_at: '2026-10-07T20:00:00+00:00' }, after_json: { due_at: '2026-10-07T20:00' } },
      'task', lookups,
    )
    expect(d.title).toBe('Due date re-saved')
    expect(d.lines).toEqual(['7 Oct 2026, 22:00 CEST (unchanged)'])
  })
})

describe('describeAuditEvent — robustness', () => {
  it('missing or deleted users render as "Unknown user", never a raw id', () => {
    const d = describeAuditEvent(
      { action: 'task.owner_user_id.changed', before_json: { owner_user_id: 'gone-1' }, after_json: { owner_user_id: null } },
      'task', empty,
    )
    expect(d.lines).toEqual(['Unknown user → None'])
  })

  it('missing project resolves to a placeholder', () => {
    const d = describeAuditEvent(
      { action: 'task.project_id.changed', before_json: { project_id: 'p-x' }, after_json: { project_id: 'p-1' } },
      'task', lookups,
    )
    expect(d.title).toBe('Project changed')
    expect(d.lines).toEqual(['Unknown project → Airport launch'])
  })

  it('formats status and priority values', () => {
    expect(describeAuditEvent({ action: 'task.status.changed', before_json: { status: 'open' }, after_json: { status: 'pending_review' } }, 'task', lookups).lines)
      .toEqual(['Open → Pending review'])
    expect(describeAuditEvent({ action: 'task.priority.changed', before_json: { priority: 2 }, after_json: { priority: 1 } }, 'task', lookups).lines)
      .toEqual(['Normal → Critical'])
  })

  it('tolerates null / missing before and after json', () => {
    expect(describeAuditEvent({ action: 'task.created' }, 'task', lookups)).toEqual({ title: 'Task created', lines: [] })
    expect(describeAuditEvent({ action: 'task.title.changed', before_json: null, after_json: null }, 'task', lookups).title).toBe('Title changed')
    expect(describeAuditEvent({ action: 'task.due_at.changed', before_json: null, after_json: { due_at: 'garbage' } }, 'task', lookups).lines)
      .toEqual(['Unknown date'])
  })

  it('falls back to a readable label for unknown events without leaking raw values', () => {
    const d = describeAuditEvent(
      { action: 'meeting.some_new_event', after_json: { secret_token: 'abc123', nested: { a: 1 } } },
      'meeting', lookups,
    )
    expect(d.title).toBe('Meeting some new event')
    expect(d.lines).toEqual([])
    expect(humaniseAction('')).toBe('Activity recorded')
  })

  it('truncates long descriptions and shows sent-back notes', () => {
    const long = 'x'.repeat(500)
    const d = describeAuditEvent({ action: 'task.description.changed', before_json: { description: 'a' }, after_json: { description: long } }, 'task', lookups)
    expect(d.lines[0].length).toBeLessThanOrEqual(140)
    const back = describeAuditEvent({ action: 'task.sent_back', after_json: { status: 'open', review_note: 'Add the SOP photos' } }, 'task', lookups)
    expect(back.lines).toEqual(['Note: Add the SOP photos'])
  })

  it('collectReferencedIds gathers user and project ids across events', () => {
    const ids = collectReferencedIds([
      { action: 'a', before_json: { owner_user_id: 'u1' }, after_json: { owner_user_id: 'u2', project_id: 'p1' } },
      { action: 'b', after_json: { created_by_user_id: 'u1', title: 'ignored' } },
      { action: 'c' },
    ])
    expect(ids.userIds.sort()).toEqual(['u1', 'u2'])
    expect(ids.projectIds).toEqual(['p1'])
  })
})
