import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketingBusinessContextItem {
  update_id: string
  project_id: string
  project_title: string
  parent_project_title: string | null
  body: string
  occurred_on: string | null
  created_at: string
  age_days: number
}

export type BusinessContextRole =
  | 'proof_point'
  | 'timely_angle'
  | 'case_study'
  | 'subject_matter'

export interface ObservationBusinessContext {
  update_id: string
  project_title: string
  occurred_on: string | null
  excerpt: string
  role: BusinessContextRole
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ITEMS = 30
const MAX_BODY_LENGTH = 500
const LOOKBACK_DAYS = 180

/** Canonical project titles that constitute marketing-relevant business context.
 *  Resolved dynamically from the projects table — never hardcoded UUIDs. */
const CANONICAL_ROOT_TITLES = [
  'Killer Katering',
  'CPH Airport / SSP',
] as const

/** Parent project whose current children are automatically included. */
const FESTIVAL_PARENT_TITLE = 'Festival 2027'

type Db = ReturnType<typeof createServiceClient>

// ---------------------------------------------------------------------------
// Canonical project resolution
// ---------------------------------------------------------------------------

interface ResolvedProject {
  id: string
  title: string
  parent_title: string | null
}

/**
 * Resolves the canonical marketing-relevant projects from the database.
 * - Named root projects (Killer Katering, CPH Airport / SSP)
 * - Festival 2027 and all its current (non-archived) child projects
 *
 * Future festival children become eligible automatically.
 * No hardcoded UUIDs — resolution is by title.
 */
export async function resolveCanonicalProjects(db: Db): Promise<ResolvedProject[]> {
  // 1. Resolve named root projects
  const { data: roots } = await db
    .from('projects')
    .select('id, title')
    .in('title', [...CANONICAL_ROOT_TITLES])
    .is('archived_at', null)

  // 2. Resolve the festival parent
  const { data: festivalParents } = await db
    .from('projects')
    .select('id, title')
    .eq('title', FESTIVAL_PARENT_TITLE)
    .is('archived_at', null)
    .limit(1)

  const festivalParentId = festivalParents?.[0]?.id ?? null
  const festivalParentTitle = festivalParents?.[0]?.title ?? null

  // 3. Resolve children of the festival parent
  let festivalChildren: { id: string; title: string }[] = []
  if (festivalParentId) {
    const { data } = await db
      .from('projects')
      .select('id, title')
      .eq('parent_project_id', festivalParentId)
      .is('archived_at', null)

    festivalChildren = data ?? []
  }

  const result: ResolvedProject[] = []

  // Add named roots
  for (const r of roots ?? []) {
    result.push({ id: r.id as string, title: r.title as string, parent_title: null })
  }

  // Add festival parent
  if (festivalParentId && festivalParentTitle) {
    result.push({ id: festivalParentId, title: festivalParentTitle, parent_title: null })
  }

  // Add festival children
  for (const c of festivalChildren) {
    result.push({ id: c.id as string, title: c.title as string, parent_title: festivalParentTitle })
  }

  return result
}

// ---------------------------------------------------------------------------
// Business context retrieval
// ---------------------------------------------------------------------------

/**
 * Fetches bounded, current (non-superseded) Universal Updates linked to
 * canonical marketing-relevant projects.
 *
 * Follows the same "current update" semantics as the general Kockpit Brain:
 * - Excludes superseded updates (where another update has supersedes_update_id pointing to this one)
 * - Excludes brain_excluded updates
 * - Preserves occurred_on, source update ID, linked project identity
 * - Newest first
 * - Bounded to MAX_ITEMS items within LOOKBACK_DAYS days
 * - Body truncated to MAX_BODY_LENGTH characters
 */
export async function loadMarketingBusinessContext(
  db: Db,
  now: Date = new Date(),
): Promise<MarketingBusinessContextItem[]> {
  const projects = await resolveCanonicalProjects(db)
  if (projects.length === 0) return []

  const projectIds = projects.map(p => p.id)
  const projectMap = new Map(projects.map(p => [p.id, p]))

  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // 1. Collect superseded update IDs
  const { data: supersededRows } = await db
    .from('kk_updates')
    .select('supersedes_update_id')
    .not('supersedes_update_id', 'is', null)

  const supersededIds = new Set(
    (supersededRows ?? [])
      .map(r => r.supersedes_update_id as string)
      .filter(Boolean)
  )

  // 2. Fetch updates linked to canonical projects within the lookback window
  const { data: entityRows } = await db
    .from('kk_update_entities')
    .select('update_id, entity_id')
    .eq('entity_type', 'project')
    .in('entity_id', projectIds)

  if (!entityRows || entityRows.length === 0) return []

  const updateIds = [...new Set(entityRows.map(r => r.update_id as string))]

  // 3. Fetch the actual updates (batch)
  const { data: updates } = await db
    .from('kk_updates')
    .select('id, body, occurred_on, created_at')
    .in('id', updateIds)
    .gte('created_at', cutoff)
    .eq('brain_excluded', false)
    .order('occurred_on', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })

  if (!updates || updates.length === 0) return []

  // 4. Build entity_id → update mapping for project resolution
  const updateToProjects = new Map<string, string>()
  for (const row of entityRows) {
    // If an update links to multiple canonical projects, prefer the first match
    if (!updateToProjects.has(row.update_id as string)) {
      updateToProjects.set(row.update_id as string, row.entity_id as string)
    }
  }

  // 5. Filter superseded, bound, and format
  const nowMs = now.getTime()
  const items: MarketingBusinessContextItem[] = []

  for (const u of updates) {
    if (supersededIds.has(u.id as string)) continue

    const projectId = updateToProjects.get(u.id as string)
    if (!projectId) continue

    const project = projectMap.get(projectId)
    if (!project) continue

    const createdAt = new Date(u.created_at as string)
    const ageDays = Math.floor((nowMs - createdAt.getTime()) / (24 * 60 * 60 * 1000))

    const body = typeof u.body === 'string' && u.body.length > MAX_BODY_LENGTH
      ? u.body.slice(0, MAX_BODY_LENGTH) + '...'
      : (u.body as string)

    items.push({
      update_id: u.id as string,
      project_id: project.id,
      project_title: project.title,
      parent_project_title: project.parent_title,
      body,
      occurred_on: (u.occurred_on as string) ?? null,
      created_at: u.created_at as string,
      age_days: ageDays,
    })

    if (items.length >= MAX_ITEMS) break
  }

  return items
}
