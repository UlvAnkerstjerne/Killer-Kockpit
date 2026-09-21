/**
 * lib/brain/todos.ts
 *
 * Brain To-Do retrieval layer.
 *
 * fetchBrainTodoContext({ keywords, personUserIds?, includeRecent?, maxTodos? })
 * ─────────────────────────────────────────────────────────────────────────────
 * Retrieves relevant To-Dos for Brain context. Three complementary paths:
 *
 *   A. Keyword search — title, notes, completion_context ILIKE against query keywords.
 *   B. Recency path  — fallback when keyword path found zero results: returns recent
 *                      completed To-Dos with meaningful completion_context.
 *   C. Person path   — fallback when keyword path found zero results: returns recent
 *                      To-Dos owned by mentioned people.
 *
 * Fallback semantics: Paths B and C only run when Path A found nothing. If keyword
 * search already surfaces relevant To-Dos, the recency and person fillers are
 * suppressed entirely — returning high-signal matches rather than padding.
 *
 * Cancelled To-Dos are excluded — they represent intent that was abandoned,
 * not outcomes. Completion context is the highest-value field and is clearly
 * labelled as such in AI context so it is not confused with the original intent.
 *
 * Security:
 *  - Uses createClient() (authenticated user session) so the Supabase RLS policy
 *    "todos: management can read all" (migration 027) remains authoritative.
 *    SUPER_ADMIN + UM see all todos via RLS; MEMBER users are blocked at the
 *    action layer before this function is ever called.
 *  - Does NOT use service_role / createServiceClient — To-Do access must stay
 *    under RLS control, not bypass it.
 *  - Caps results to prevent context bloat.
 */

import { createClient } from '@/lib/supabase/server'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface BrainTodoItem {
  id:                string
  title:             string
  notes:             string | null
  completionContext: string | null   // what actually happened — high-value operational source
  completedAt:       string | null   // YYYY-MM-DD
  scheduledFor:      string | null   // YYYY-MM-DD
  isCompleted:       boolean
  ownerName:         string | null
}

export interface BrainTodoContext {
  todos: BrainTodoItem[]
}

// ─── Internal types ───────────────────────────────────────────────────────────

type RawTodoRow = {
  id:                 string
  title:              string
  notes:              string | null
  completion_context: string | null
  completed_at:       string | null
  scheduled_for:      string | null
  user_id:            string
  cancelled_at:       string | null
  owner:              { display_name: string } | { display_name: string }[] | null
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TODOS         = 10
const RECENCY_DAYS              = 60
const CONTEXT_EXCERPT_CHARS     = 400
const NOTES_EXCERPT_CHARS       = 300

// ─── Row mapper ───────────────────────────────────────────────────────────────

function mapRow(row: RawTodoRow): BrainTodoItem {
  const ownerRaw = row.owner
  const ownerObj = Array.isArray(ownerRaw) ? ownerRaw[0] : ownerRaw
  const ownerName = (ownerObj as { display_name: string } | null)?.display_name ?? null

  return {
    id:                row.id,
    title:             row.title,
    notes:             row.notes ? row.notes.slice(0, NOTES_EXCERPT_CHARS) : null,
    completionContext: row.completion_context
      ? row.completion_context.slice(0, CONTEXT_EXCERPT_CHARS)
      : null,
    completedAt:  row.completed_at ? row.completed_at.slice(0, 10) : null,
    scheduledFor: row.scheduled_for ? row.scheduled_for.slice(0, 10) : null,
    isCompleted:  !!row.completed_at,
    ownerName,
  }
}

// ─── fetchBrainTodoContext ────────────────────────────────────────────────────

/**
 * Fetches relevant To-Dos for Brain context.
 *
 * @param keywords       Words to ILIKE-search in title, notes, completion_context.
 * @param personUserIds  App user IDs whose todos to include (person-context path).
 * @param includeRecent  Include recent completed todos with completion_context (recency path).
 * @param maxTodos       Maximum todos to return (default: 10).
 */
export async function fetchBrainTodoContext({
  keywords      = [],
  personUserIds = [],
  includeRecent = false,
  maxTodos      = DEFAULT_MAX_TODOS,
}: {
  keywords?:      string[]
  personUserIds?: string[]
  includeRecent?: boolean
  maxTodos?:      number
}): Promise<BrainTodoContext> {
  const hasKeywords = keywords.length > 0
  const hasPersons  = personUserIds.length > 0

  if (!hasKeywords && !hasPersons && !includeRecent) {
    return { todos: [] }
  }

  try {
    const db = await createClient()
    const collectedIds = new Set<string>()
    const allItems: BrainTodoItem[] = []

    function addRow(row: RawTodoRow) {
      if (collectedIds.has(row.id)) return
      collectedIds.add(row.id)
      allItems.push(mapRow(row))
    }

    // ── Path A: Keyword search (title + notes + completion_context) ──────────
    //
    // This is the primary path. Searches all three text fields so that both
    // the original intent (title) and the recorded outcome (completion_context)
    // are discoverable. e.g. "feedback" in title, or "gæster" in completion_context.
    if (hasKeywords) {
      const orFilter = keywords
        .map(kw => `title.ilike.%${kw}%,notes.ilike.%${kw}%,completion_context.ilike.%${kw}%`)
        .join(',')

      const { data: kwRows } = await db
        .from('todos')
        .select('id, title, notes, completion_context, completed_at, scheduled_for, user_id, cancelled_at, owner:user_id(display_name)')
        .is('cancelled_at', null)
        .or(orFilter)
        .order('completed_at', { ascending: false, nullsFirst: false })
        .order('updated_at',   { ascending: false })
        .limit(maxTodos * 2)

      for (const row of (kwRows ?? []) as RawTodoRow[]) {
        addRow(row)
      }
    }

    // ── Path B: Recency — fallback when keyword path found nothing ───────────
    //
    // Only runs when keyword search returned zero results. If Path A already
    // surfaced relevant To-Dos, adding unrelated recency results would dilute
    // signal with noise. When triggered, returns recent completed todos that
    // have something written in completion_context.
    if (includeRecent && allItems.length === 0) {
      const cutoff = new Date(Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10)

      const { data: recentRows } = await db
        .from('todos')
        .select('id, title, notes, completion_context, completed_at, scheduled_for, user_id, cancelled_at, owner:user_id(display_name)')
        .is('cancelled_at', null)
        .not('completed_at',       'is', null)
        .not('completion_context', 'is', null)
        .gte('completed_at', cutoff)
        .order('completed_at', { ascending: false })
        .limit(maxTodos * 2)

      for (const row of (recentRows ?? []) as RawTodoRow[]) {
        addRow(row)
      }
    }

    // ── Path C: Person context — fallback when keyword path found nothing ─────
    //
    // Only runs when keyword search returned zero results. If Path A already
    // found relevant To-Dos (even ones involving the mentioned person), generic
    // person-owned filler is suppressed.
    if (hasPersons && allItems.length === 0) {
      const { data: personRows } = await db
        .from('todos')
        .select('id, title, notes, completion_context, completed_at, scheduled_for, user_id, cancelled_at, owner:user_id(display_name)')
        .is('cancelled_at', null)
        .in('user_id', personUserIds.slice(0, 3))
        .order('completed_at', { ascending: false, nullsFirst: false })
        .order('updated_at',   { ascending: false })
        .limit(maxTodos)

      for (const row of (personRows ?? []) as RawTodoRow[]) {
        addRow(row)
      }
    }

    // ── Sort by effective recency DESC, cap ──────────────────────────────────
    allItems.sort((a, b) => {
      const da = a.completedAt ?? ''
      const db2 = b.completedAt ?? ''
      return db2.localeCompare(da)
    })

    return { todos: allItems.slice(0, maxTodos) }
  } catch (err) {
    console.error('[brain/todos] fetchBrainTodoContext failed:', (err as Error).message)
    return { todos: [] }
  }
}
