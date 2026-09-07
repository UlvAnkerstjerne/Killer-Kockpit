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
import { resolveEntityRef }        from './capture-resolve'
import type {
  EnrichedEntityRef,
  ResolvedEntityRef,
  AmbiguousEntityRef,
  NotFoundEntityRef,
} from './capture-resolve'

// Re-export types for consumers (type exports are allowed from 'use server' files).
export type { ResolvedEntityRef, AmbiguousEntityRef, NotFoundEntityRef, EnrichedEntityRef }

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RAW_TEXT_LENGTH = 5_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ─── Output types ─────────────────────────────────────────────────────────────

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
): Promise<{ data: EnrichedCandidateUpdate[]; analysisNote: string | null } | { error: string }> {

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

  return { data: enriched, analysisNote: aiResult.output.analysis_note }
}

// ─── searchCaptureEntities ────────────────────────────────────────────────────

export type CaptureEntityResult = {
  entity_type: KkUpdateEntityType
  entity_id:   string
  display_name: string
}

/**
 * Authenticated read-only entity search for the Quick Capture review UI.
 *
 * Returns active employees, locations, and/or projects matching the query.
 * Uses case-insensitive partial text matching (ilike).  No semantic search.
 *
 * @param query       Search string (1–100 chars)
 * @param entityType  When provided, restricts to that entity type only.
 */
export async function searchCaptureEntities(
  query:       string,
  entityType?: KkUpdateEntityType,
): Promise<{ data: CaptureEntityResult[] } | { error: string }> {

  // ── Auth + gate ────────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }
  if (!canAccessManagementView(user.role)) return { error: 'Access denied.' }

  // ── Input validation ───────────────────────────────────────────────────────
  const q = query.trim()
  if (!q) return { data: [] }
  if (q.length > 100) return { error: 'Search query too long.' }

  const supabase = await createClient()
  const LIMIT    = 8
  const types: KkUpdateEntityType[] = entityType ? [entityType] : ['employee', 'location', 'project']

  const results: CaptureEntityResult[] = []

  await Promise.all(types.map(async (type) => {
    if (type === 'employee') {
      const { data } = await supabase
        .from('employees')
        .select('id, name')
        .eq('employment_status', 'active')
        .ilike('name', `%${q}%`)
        .order('name')
        .limit(LIMIT)
      for (const e of data ?? []) {
        results.push({ entity_type: 'employee', entity_id: e.id, display_name: e.name })
      }
    } else if (type === 'location') {
      const { data } = await supabase
        .from('locations')
        .select('id, name')
        .eq('active', true)
        .or(`name.ilike.%${q}%,short_name.ilike.%${q}%`)
        .order('name')
        .limit(LIMIT)
      for (const l of data ?? []) {
        results.push({ entity_type: 'location', entity_id: l.id, display_name: l.name })
      }
    } else {
      const { data } = await supabase
        .from('projects')
        .select('id, title')
        .is('archived_at', null)
        .not('status', 'in', '("completed","archived","cancelled")')
        .ilike('title', `%${q}%`)
        .order('title')
        .limit(LIMIT)
      for (const p of data ?? []) {
        results.push({ entity_type: 'project', entity_id: p.id, display_name: p.title })
      }
    }
  }))

  return { data: results.slice(0, LIMIT) }
}
