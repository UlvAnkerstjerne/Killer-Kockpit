/**
 * lib/ai/email-suggestion-display.ts
 *
 * Pure display helpers for EmailSuggestion values.
 * No async, no side-effects — all functions are node-testable.
 *
 * Used by InboxClient to render the "Kockpit suggests" section.
 */

import type { EmailSuggestion, Responsibility } from './email-analysis-schema'

// ─── Kind label ────────────────────────────────────────────────────────────────

/** Human-readable label for each suggestion kind. */
export function kindLabel(kind: EmailSuggestion['kind']): string {
  switch (kind) {
    case 'todo':       return 'To-Do'
    case 'task':       return 'Task'
    case 'waiting_on': return 'Waiting On'
    case 'meeting':    return 'Meeting'
  }
}

// ─── Responsible ───────────────────────────────────────────────────────────────

/**
 * Returns a display string for a task Responsibility, or null when
 * the responsible party cannot be meaningfully represented (unknown
 * with no display_name).
 */
export function formatResponsible(responsible: Responsibility): string | null {
  if (responsible.type === 'current_user') return 'You'
  if (responsible.type === 'named_person' && responsible.display_name) {
    return responsible.display_name
  }
  return null
}

// ─── Date formatting ───────────────────────────────────────────────────────────

/**
 * Formats an ISO date string (YYYY-MM-DD or full ISO timestamp) as a
 * short localised date ("5 Sep 2026"). Returns null if the input is
 * null or cannot be parsed.
 */
export function formatDisplayDate(iso: string | null): string | null {
  if (!iso) return null
  try {
    // YYYY-MM-DD (date-only) strings are parsed as UTC midnight by spec; add
    // a T00:00:00 so they don't shift one day when the local TZ is behind UTC.
    const normalised = iso.length === 10 ? `${iso}T00:00:00` : iso
    const d = new Date(normalised)
    if (isNaN(d.getTime())) return null
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return null
  }
}

/**
 * Formats an ISO timestamp as a short time string ("10:00"). Returns
 * null if the input is null or cannot be parsed.
 */
export function formatDisplayTime(iso: string | null): string | null {
  if (!iso) return null
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return null
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return null
  }
}

// ─── Detail rows ───────────────────────────────────────────────────────────────

/**
 * Returns an ordered list of display-ready detail rows for a suggestion.
 * Only entries with non-null values are included — null optional fields
 * are silently omitted.
 */
export function suggestionDetails(
  s: EmailSuggestion,
): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = []

  if (s.kind === 'todo') {
    const d = formatDisplayDate(s.scheduled_for)
    if (d) out.push({ label: 'Scheduled', value: d })
  }

  if (s.kind === 'task') {
    const responsible = formatResponsible(s.responsible)
    if (responsible) out.push({ label: 'Responsible', value: responsible })
    const due = formatDisplayDate(s.due_at)
    if (due) out.push({ label: 'Due', value: due })
    if (s.priority_hint === 'high') out.push({ label: 'Priority', value: 'High' })
  }

  if (s.kind === 'waiting_on') {
    if (s.waiting_for_name) out.push({ label: 'Waiting on', value: s.waiting_for_name })
    const due = formatDisplayDate(s.due_at)
    if (due) out.push({ label: 'Due', value: due })
  }

  if (s.kind === 'meeting') {
    if (s.scheduled_start) {
      const date = formatDisplayDate(s.scheduled_start)
      const time = formatDisplayTime(s.scheduled_start)
      const str  = [date, time].filter(Boolean).join(' at ')
      if (str) out.push({ label: 'When', value: str })
    }
    if (s.scheduled_end) {
      const time = formatDisplayTime(s.scheduled_end)
      if (time) out.push({ label: 'Until', value: time })
    }
    if (s.location) out.push({ label: 'Where', value: s.location })
  }

  return out
}

// ─── Kind badge class ──────────────────────────────────────────────────────────

/** Returns the Tailwind class for the type badge pill for a given kind. */
export function kindBadgeClass(kind: EmailSuggestion['kind']): string {
  switch (kind) {
    case 'todo':       return 'bg-kk-soft text-kk-muted'
    case 'task':       return 'bg-kk-ink text-white'
    case 'waiting_on': return 'bg-kk-warn-bg text-kk-warn'
    case 'meeting':    return 'bg-kk-good-bg text-kk-good'
  }
}
