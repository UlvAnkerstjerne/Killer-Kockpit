// lib/audit/describe.ts
//
// Turns raw audit_events rows into human-readable history entries.
// Presentation only: the stored rows are never modified, and anything this
// module does not recognise falls back to a humanised label with no raw values.
// Pure and side-effect free so it can be unit-tested with fixtures.

import { formatCopenhagen, parseDbInstant } from '@/lib/time'
import { taskStatusLabel } from '@/lib/tasks/status'

export type AuditEventRow = {
  action: string
  before_json?: Record<string, unknown> | null
  after_json?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
}

export type AuditLookups = {
  /** user id → display name */
  users: ReadonlyMap<string, string>
  /** project id → title */
  projects: ReadonlyMap<string, string>
}

export type AuditDescription = {
  title: string
  /** Secondary lines, already formatted for display. */
  lines: string[]
}

const USER_FIELDS = new Set(['owner_user_id', 'created_by_user_id', 'returned_by_user_id', 'waiting_for_user_id'])
const PROJECT_FIELDS = new Set(['project_id', 'parent_project_id'])

const PRIORITY_LABELS: Record<number, string> = { 1: 'Critical', 2: 'Normal', 3: 'Low', 4: 'Background' }
const MAX_TEXT = 140

/** Collect the user / project ids an event set refers to, so callers can resolve them in one query each. */
export function collectReferencedIds(events: AuditEventRow[]): { userIds: string[]; projectIds: string[] } {
  const userIds = new Set<string>()
  const projectIds = new Set<string>()
  for (const e of events) {
    for (const json of [e.before_json, e.after_json]) {
      if (!json || typeof json !== 'object') continue
      for (const [k, v] of Object.entries(json)) {
        if (typeof v !== 'string' || !v) continue
        if (USER_FIELDS.has(k)) userIds.add(v)
        else if (PROJECT_FIELDS.has(k)) projectIds.add(v)
      }
    }
  }
  return { userIds: [...userIds], projectIds: [...projectIds] }
}

// ─── Value formatting ────────────────────────────────────────────────────────

export function formatAuditDateTime(value: unknown): string {
  if (typeof value !== 'string') return 'None'
  const d = parseDbInstant(value)
  if (!d) return 'Unknown date'
  const hasTime = /T\d{2}:\d{2}/.test(value)
  return formatCopenhagen(d.toISOString(), {
    day: 'numeric', month: 'short', year: 'numeric',
    ...(hasTime ? { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' } : {}),
  }) ?? 'Unknown date'
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat
}

function personName(id: unknown, lookups: AuditLookups): string {
  if (typeof id !== 'string' || !id) return 'No one'
  return lookups.users.get(id) ?? 'Unknown user'
}

function formatFieldValue(field: string, value: unknown, lookups: AuditLookups): string {
  if (value === null || value === undefined || value === '') return 'None'
  if (USER_FIELDS.has(field)) return personName(value, lookups)
  if (PROJECT_FIELDS.has(field)) {
    return typeof value === 'string' ? (lookups.projects.get(value) ?? 'Unknown project') : 'None'
  }
  if (field === 'status' && typeof value === 'string') return taskStatusLabel(value)
  if (field === 'priority') return PRIORITY_LABELS[Number(value)] ?? String(value)
  if (field === 'due_at' || field === 'due_date') return formatAuditDateTime(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' || typeof value === 'number') return truncate(String(value))
  return 'Updated' // objects/arrays: never dump raw JSON into the UI
}

// ─── Labels ──────────────────────────────────────────────────────────────────

const FIXED_TITLES: Record<string, string> = {
  'task.created': 'Task created',
  'task.completed': 'Task completed',
  'task.cancelled': 'Task cancelled',
  'task.reopened': 'Task reopened',
  'task.submitted_for_review': 'Submitted for review',
  'task.approved': 'Approved',
  'task.sent_back': 'Sent back for changes',
  'admin.override': 'Administrator override',
  'drive_reference_attached': 'Drive file attached',
  'drive_reference_detached': 'Drive file removed',
  'project.created': 'Project created',
  'project.archived': 'Project archived',
  'project.reopened': 'Project reopened',
  'project.closed': 'Project closed',
  'project.cancelled': 'Project cancelled',
  'waiting_on.created': 'Waiting on created',
  'waiting_on.fulfilled': 'Waiting on fulfilled',
  'waiting_on.reopened': 'Waiting on reopened',
  'waiting_on.cancelled': 'Waiting on cancelled',
  'decision.members_notified': 'All members notified',
}

function fieldLabel(entity: string, field: string): string {
  switch (field) {
    case 'owner_user_id': return entity === 'task' ? 'Responsible' : 'Owner'
    case 'due_at':
    case 'due_date': return 'Due date'
    case 'project_id': return 'Project'
    case 'description': return 'Description'
    case 'title': return 'Title'
    case 'status': return 'Status'
    case 'priority': return 'Priority'
    case 'progress': return 'Progress'
    default: return capitalise(field.replace(/_id$/, '').replace(/_/g, ' '))
  }
}

function capitalise(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

/** "task.foo_bar.changed" → "Task foo bar changed"; used only for unrecognised events. */
export function humaniseAction(action: string): string {
  const cleaned = action.replace(/[._]+/g, ' ').trim()
  return cleaned ? capitalise(cleaned) : 'Activity recorded'
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export function describeAuditEvent(
  event: AuditEventRow,
  entityType: string,
  lookups: AuditLookups,
): AuditDescription {
  const before = isRecord(event.before_json) ? event.before_json : {}
  const after = isRecord(event.after_json) ? event.after_json : {}

  // "<entity>.<field>.changed" — one field, before → after.
  const changed = /^[a-z_]+\.([a-z_]+)\.changed$/.exec(event.action)
  if (changed) {
    const field = changed[1]
    const label = fieldLabel(entityType, field)
    const hasBefore = field in before
    const hasAfter = field in after

    if (field === 'due_at' || field === 'due_date') {
      const b = parseDbInstant(typeof before[field] === 'string' ? (before[field] as string) : null)
      const a = parseDbInstant(typeof after[field] === 'string' ? (after[field] as string) : null)
      if (b && a && b.getTime() === a.getTime()) {
        // Legacy rows: the edit form re-saved an unchanged deadline in a different string format.
        return { title: 'Due date re-saved', lines: [`${formatAuditDateTime(after[field])} (unchanged)`] }
      }
    }

    if (field === 'description' || field === 'title') {
      return {
        title: `${label} changed`,
        lines: hasAfter ? [truncate(String(after[field] ?? '')) || 'Cleared'] : [],
      }
    }

    const lines = hasBefore && hasAfter
      ? [`${formatFieldValue(field, before[field], lookups)} → ${formatFieldValue(field, after[field], lookups)}`]
      : hasAfter ? [formatFieldValue(field, after[field], lookups)] : []
    return { title: `${label} changed`, lines }
  }

  const title = FIXED_TITLES[event.action] ?? humaniseAction(event.action)
  const lines: string[] = []

  switch (event.action) {
    case 'task.created':
      if (typeof after.owner_user_id === 'string') lines.push(`Responsible: ${personName(after.owner_user_id, lookups)}`)
      break
    case 'task.submitted_for_review':
      lines.push('Waiting for the owner to approve or send back')
      break
    case 'task.sent_back':
      if (typeof after.review_note === 'string' && after.review_note.trim()) lines.push(`Note: ${truncate(after.review_note)}`)
      break
    case 'admin.override':
      if (typeof after.note === 'string' && after.note.trim()) lines.push(truncate(after.note))
      break
    case 'drive_reference_attached':
    case 'drive_reference_detached': {
      const src = event.action === 'drive_reference_attached' ? after : before
      if (typeof src.file_name === 'string' && src.file_name) lines.push(truncate(src.file_name))
      break
    }
  }

  return { title, lines }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
