'use server'

/**
 * lib/actions/capture.ts
 *
 * Server action for Quick Capture analysis (M8B3).
 *
 * Flow
 * ────
 * 1. Authenticate the current user.
 * 2. Management role gate (canAccessManagementView).
 * 3. Validate raw input text and optional occurred_on date.
 * 4. Default occurred_on to today in Europe/Copenhagen when omitted.
 * 5. Fetch minimal active entity context via the authenticated RLS client
 *    (projects, employees, locations).
 * 6. Call analyzeCapture() AI module.
 * 7. Deterministically resolve returned entity name_hints:
 *      exact match → resolved (exact)
 *      unique partial match → resolved (partial)
 *      multiple matches → ambiguous
 *      no match → not_found
 * 8. Return enriched ephemeral candidates.
 *
 * What this action does NOT do
 * ─────────────────────────────
 * • Write any rows to the database.
 * • Call createUpdate — that is the apply step (M8B4+).
 * • Log the raw note text.
 * • Expose entity UUIDs to the AI model.
 */

import { getCurrentUser }          from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { createClient }            from '@/lib/supabase/server'
import { analyzeCapture as runAI } from '@/lib/ai/analyze-capture'
import type { KkUpdateEntityType } from '@/lib/types'
import type { CandidateEntityRef } from '@/lib/ai/capture-analysis-schema'

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RAW_TEXT_LENGTH = 5_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ─── Enriched output types ────────────────────────────────────────────────────

export type ResolvedEntityRef = {
  entity_type:  KkUpdateEntityType
  name_hint:    string
  status:       'resolved'
  entity_id:    string
  display_name: string
  match_kind:   'exact' | 'partial'
}

export type AmbiguousEntityRef = {
  entity_type: KkUpdateEntityType
  name_hint:   string
  status:      'ambiguous'
  candidates:  { entity_id: string; display_name: string }[]
}

export type NotFoundEntityRef = {
  entity_type: KkUpdateEntityType
  name_hint:   string
  status:      'not_found'
}

export type EnrichedEntityRef =
  | ResolvedEntityRef
  | AmbiguousEntityRef
  | NotFoundEntityRef

export interface EnrichedCandidateUpdate {
  body:         string
  occurred_on:  string | null
  entity_refs:  EnrichedEntityRef[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns today's date in Europe/Copenhagen as YYYY-MM-DD. */
function todayInCopenhagen(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date())
}

/** Normalises a string for comparison: lowercase and trim. */
function norm(s: string): string {
  return s.toLowerCase().trim()
}

interface PoolEntry {
  entity_id:    string
  display_name: string
  /** Secondary searchable name (e.g. short_name for locations). */
  alt_name?:    string
}

function buildPool(
  entityType: KkUpdateEntityType,
  projects:   { id: string; title: string }[],
  employees:  { id: string; name: string }[],
  locations:  { id: string; name: string; short_name: string | null }[],
): PoolEntry[] {
  if (entityType === 'project') {
    return projects.map(p => ({ entity_id: p.id, display_name: p.title }))
  }
  if (entityType === 'employee') {
    return employees.map(e => ({ entity_id: e.id, display_name: e.name }))
  }
  // location
  return locations.map(l => ({
    entity_id:    l.id,
    display_name: l.name,
    alt_name:     l.short_name ?? undefined,
  }))
}

function matchesExact(entry: PoolEntry, hint: string): boolean {
  return (
    norm(entry.display_name) === hint ||
    (entry.alt_name !== undefined && norm(entry.alt_name) === hint)
  )
}

function matchesPartial(entry: PoolEntry, hint: string): boolean {
  const dn = norm(entry.display_name)
  const an = entry.alt_name !== undefined ? norm(entry.alt_name) : null
  return (
    dn.includes(hint) ||
    hint.includes(dn) ||
    (an !== null && (an.includes(hint) || hint.includes(an)))
  )
}

export function resolveEntityRef(
  ref: CandidateEntityRef,
  projects:  { id: string; title: string }[],
  employees: { id: string; name: string }[],
  locations: { id: string; name: string; short_name: string | null }[],
): EnrichedEntityRef {
  const pool = buildPool(ref.entity_type, projects, employees, locations)
  const hint = norm(ref.name_hint)

  // ── Exact match ────────────────────────────────────────────────────────────
  const exact = pool.filter(e => matchesExact(e, hint))

  if (exact.length === 1) {
    return {
      entity_type:  ref.entity_type,
      name_hint:    ref.name_hint,
      status:       'resolved',
      entity_id:    exact[0].entity_id,
      display_name: exact[0].display_name,
      match_kind:   'exact',
    }
  }

  if (exact.length > 1) {
    return {
      entity_type: ref.entity_type,
      name_hint:   ref.name_hint,
      status:      'ambiguous',
      candidates:  exact.map(e => ({ entity_id: e.entity_id, display_name: e.display_name })),
    }
  }

  // ── Partial match ──────────────────────────────────────────────────────────
  const partial = pool.filter(e => matchesPartial(e, hint))

  if (partial.length === 1) {
    return {
      entity_type:  ref.entity_type,
      name_hint:    ref.name_hint,
      status:       'resolved',
      entity_id:    partial[0].entity_id,
      display_name: partial[0].display_name,
      match_kind:   'partial',
    }
  }

  if (partial.length > 1) {
    return {
      entity_type: ref.entity_type,
      name_hint:   ref.name_hint,
      status:      'ambiguous',
      candidates:  partial.map(e => ({ entity_id: e.entity_id, display_name: e.display_name })),
    }
  }

  // ── Not found ──────────────────────────────────────────────────────────────
  return {
    entity_type: ref.entity_type,
    name_hint:   ref.name_hint,
    status:      'not_found',
  }
}

// ─── Server action ────────────────────────────────────────────────────────────

/**
 * Analyses a raw management note and returns enriched candidate Universal Updates.
 *
 * No database writes are performed — candidates are ephemeral and returned to
 * the caller for human review before any createUpdate calls are made.
 *
 * @param rawText    The management note text (≤ 5 000 characters).
 * @param occurredOn Optional YYYY-MM-DD date.  Defaults to today in
 *                   Europe/Copenhagen when omitted or null.
 */
export async function analyzeCapture(
  rawText:     string,
  occurredOn?: string | null,
): Promise<{ data: EnrichedCandidateUpdate[] } | { error: string }> {

  // ── 1. Authenticate ────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  // ── 2. Management role gate ────────────────────────────────────────────────
  if (!canAccessManagementView(user.role)) {
    return { error: 'Access denied. Management role required.' }
  }

  // ── 3. Validate input ──────────────────────────────────────────────────────
  if (!rawText || !rawText.trim()) {
    return { error: 'Note text is required.' }
  }
  if (rawText.length > MAX_RAW_TEXT_LENGTH) {
    return { error: `Note must be ${MAX_RAW_TEXT_LENGTH.toLocaleString()} characters or fewer.` }
  }

  // Validate occurredOn when explicitly supplied
  if (occurredOn !== undefined && occurredOn !== null && !DATE_RE.test(occurredOn)) {
    return { error: 'occurred_on must be a date in YYYY-MM-DD format.' }
  }

  // ── 4. Resolve reference date ──────────────────────────────────────────────
  const referenceDate = todayInCopenhagen()
  const resolvedOccurredOn: string | null = occurredOn ?? referenceDate

  // ── 5. Fetch entity context ────────────────────────────────────────────────
  const supabase = await createClient()

  const [projectsResult, employeesResult, locationsResult] = await Promise.all([
    supabase
      .from('projects')
      .select('id, title')
      .is('archived_at', null)
      .not('status', 'in', '("completed","archived","cancelled")')
      .order('title'),
    supabase
      .from('employees')
      .select('id, name')
      .eq('employment_status', 'active')
      .order('name'),
    supabase
      .from('locations')
      .select('id, name, short_name')
      .eq('active', true)
      .order('name'),
  ])

  const projects  = projectsResult.data  ?? []
  const employees = employeesResult.data ?? []
  const locations = locationsResult.data ?? []

  // ── 6. AI analysis ─────────────────────────────────────────────────────────
  const aiResult = await runAI({
    rawText,
    occurred_on:   resolvedOccurredOn,
    referenceDate,
    projects,
    employees,
    locations,
  })

  if (!aiResult.ok) return { error: aiResult.error }

  // ── 7. Deterministic entity resolution ────────────────────────────────────
  const enriched: EnrichedCandidateUpdate[] = aiResult.output.candidates.map(candidate => ({
    body:        candidate.body,
    occurred_on: candidate.occurred_on,
    entity_refs: candidate.entity_refs.map(ref =>
      resolveEntityRef(ref, projects, employees, locations)
    ),
  }))

  return { data: enriched }
}
