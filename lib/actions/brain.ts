'use server'

/**
 * lib/actions/brain.ts
 *
 * Server action for Kockpit Brain Q&A (M8 / Brain v1).
 *
 * askBrain(question)
 * ──────────────────
 * 1. Authenticate + management role gate.
 * 2. Load all active entity names (locations, employees, projects) for:
 *    - entity mention detection in the question
 *    - display name resolution for source cards
 * 3. Detect mentioned entities by substring matching (exact/partial).
 * 4. Fetch full entity profiles for matched entities (parallel with update retrieval):
 *    - Person: name, role_title, store_or_team, employment_status, started_on, manager
 *    - Location: name, short_name, active
 *    - Project: title, description, status, owner, start_date, due_date, progress
 * 5. Retrieve current (non-superseded) Updates via two complementary paths:
 *    a. Entity-specific: existing get_current_updates_for_entity RPC (handles NOT EXISTS).
 *    b. Keyword text search: ILIKE over kk_updates.body, superseded rows excluded client-side.
 *    c. Fallback: recent updates when query is very broad.
 * 6. Deduplicate, sort by recency, cap at MAX_CONTEXT_UPDATES.
 * 7. Enrich with entity links + author names.
 * 8. Call queryBrain() AI module with both profiles + updates as context.
 * 9. Return { answer, profileSources, sources } or { error }.
 *
 * Security
 * ────────
 * • Management-only (canAccessManagementView — SUPER_ADMIN + UM).
 * • User JWT + RLS client throughout (no service_role bypass).
 * • Entity UUIDs never forwarded to the AI model.
 * • Question text never written to the database.
 */

import { getCurrentUser }          from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { createClient }            from '@/lib/supabase/server'
import { queryBrain }              from '@/lib/ai/brain-query'
import type { ActionResult, KkUpdateEntityType } from '@/lib/types'
import type {
  BrainContextUpdate,
  BrainEntityProfile,
  EmployeeProfile,
  LocationProfile,
  ProjectProfile,
} from '@/lib/ai/brain-query'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface BrainSourceEntity {
  entity_type:  KkUpdateEntityType
  entity_id:    string
  display_name: string
  href:         string
}

export interface BrainSource {
  updateId:    string
  body:        string
  occurred_on: string | null
  created_at:  string
  authorName:  string | null
  entities:    BrainSourceEntity[]
}

/** A card shown in the sources panel representing a Kockpit entity record. */
export interface BrainProfileSource {
  entity_type:  KkUpdateEntityType
  entity_id:    string
  display_name: string
  href:         string
  fields:       { label: string; value: string }[]
}

export interface BrainAnswer {
  answer:         string
  profileSources: BrainProfileSource[]
  sources:        BrainSource[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_QUESTION_LENGTH  = 500
const MAX_CONTEXT_UPDATES  = 20

/** Words excluded from keyword extraction — too generic to be useful. */
const STOP_WORDS = new Set([
  'what', 'with', 'about', 'that', 'this', 'have', 'from', 'know', 'going',
  'doing', 'recently', 'current', 'issues', 'things', 'tell', 'show', 'give',
  'information', 'updates', 'situation', 'happening', 'kockpit', 'killer',
  'kebab', 'there', 'latest', 'their', 'them', 'they', 'been', 'were', 'will',
  'when', 'where', 'which', 'does', 'regarding', 'related', 'anything',
  'something', 'everything', 'nothing', 'currently', 'recent', 'know',
])

// ─── Profile field builder (for UI source cards) ──────────────────────────────

function fmtISODate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
}

function buildProfileFields(
  profile: EmployeeProfile | LocationProfile | ProjectProfile,
): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = []

  if (profile.kind === 'employee') {
    if (profile.role_title)    fields.push({ label: 'Role',     value: profile.role_title })
    if (profile.store_or_team) fields.push({ label: 'Store/Team', value: profile.store_or_team })
    const statusLabel: Record<string, string> = { active: 'Active', inactive: 'Inactive', left: 'Left' }
    fields.push({ label: 'Status', value: statusLabel[profile.employment_status] ?? profile.employment_status })
    if (profile.started_on)  fields.push({ label: 'Started', value: fmtISODate(profile.started_on) })
    if (profile.manager_name) fields.push({ label: 'Manager', value: profile.manager_name })
  }

  if (profile.kind === 'location') {
    fields.push({ label: 'Short name', value: profile.short_name })
    fields.push({ label: 'Status',     value: profile.active ? 'Active' : 'Inactive' })
  }

  if (profile.kind === 'project') {
    fields.push({ label: 'Status', value: profile.status })
    if (profile.description) fields.push({ label: 'Description', value: profile.description })
    if (profile.owner_name)  fields.push({ label: 'Project lead', value: profile.owner_name })
    if (profile.start_date)  fields.push({ label: 'Start date',  value: fmtISODate(profile.start_date) })
    if (profile.due_date)    fields.push({ label: 'Due date',    value: fmtISODate(profile.due_date) })
    if (profile.progress !== null) fields.push({ label: 'Progress', value: `${profile.progress}%` })
  }

  return fields
}

// ─── Internal types ───────────────────────────────────────────────────────────

type RawUpdateRow = {
  id:                  string
  body:                string
  occurred_on:         string | null
  created_at:          string
  created_by_user_id:  string
  supersedes_update_id: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function entityHref(type: KkUpdateEntityType, id: string): string {
  if (type === 'location') return `/locations/${id}`
  if (type === 'employee') return `/people/${id}`
  return `/projects/${id}`
}

function norm(s: string): string {
  return s.toLowerCase().trim()
}

/**
 * Returns true when `name` (or `altName`) is mentioned in the normalised
 * question string.  Uses three strategies in order:
 *
 * 1. Full name exact substring match (catches "ulv ankerstjerne").
 * 2. Any name token ≥4 chars appears as a substring in the question
 *    (catches last names and compound names).
 * 3. First name word-boundary match — handles short names like "Ulv" (3 chars)
 *    that would fail the ≥4-char threshold.  Requires the token to appear as a
 *    distinct word, not embedded inside another word, to avoid false positives.
 */
function mentionedInQuestion(name: string, altName: string | null, q: string): boolean {
  const n = norm(name)
  const a = altName ? norm(altName) : null

  // 1. Full name exact substring
  if (q.includes(n)) return true

  const tokens = n.split(/\s+/)

  // 2. Any token ≥4 chars as substring
  if (tokens.some(t => t.length >= 4 && q.includes(t))) return true

  // 3. First name word-boundary match (handles short names ≥2 chars).
  //    Both q and n are already lowercased.  The lookbehind/lookahead [a-zæøå]
  //    prevents "ulv" from matching inside words like "pulverise".
  const firstName = tokens[0]
  if (firstName && firstName.length >= 2) {
    const esc = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?<![a-zæøå])${esc}(?![a-zæøå])`).test(q)) return true
  }

  // altName checks (used for location short names)
  if (!a) return false
  if (q.includes(a)) return true
  if (a.split(/\s+/).some(t => t.length >= 3 && q.includes(t))) return true

  return false
}

/** Extract meaningful keywords from the question for text search. */
function extractKeywords(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-zæøå0-9\s]/gi, '')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
    .slice(0, 6)
}

// ─── Main server action ───────────────────────────────────────────────────────

export async function askBrain(
  question: string,
): Promise<ActionResult<BrainAnswer>> {

  // ── 1. Auth + role gate ───────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }
  if (!canAccessManagementView(user.role)) return { error: 'Not authorised.' }

  // ── 2. Validate question ──────────────────────────────────────────────────
  const q = question.trim()
  if (!q) return { error: 'Please enter a question.' }
  if (q.length > MAX_QUESTION_LENGTH) return { error: 'Question is too long (max 500 characters).' }

  const supabase = await createClient()

  // ── 3. Load entity names (for matching + display enrichment) ─────────────
  const [locResult, empResult, projResult] = await Promise.all([
    supabase.from('locations').select('id, name, short_name').eq('active', true).order('name'),
    supabase.from('employees').select('id, name, employment_status').order('name'),
    supabase
      .from('projects')
      .select('id, title')
      .not('status', 'in', '(archived,cancelled)')
      .order('title'),
  ])

  const locations = locResult.data ?? []
  const employees = empResult.data ?? []
  const projects  = projResult.data ?? []

  // ── 4. Detect entities mentioned in the question ──────────────────────────
  const qLower = norm(q)

  const mentionedLocations = locations.filter(l =>
    mentionedInQuestion(l.name, (l as { short_name?: string | null }).short_name ?? null, qLower)
  )

  // Employee matching: prefer Active people.
  // If any active employee matches, use only those (avoids Former people shadowing active ones).
  // Fall through to Former employees only when no active person matches and a Former person
  // is explicitly named (historical lookup).
  const allMatchedEmployees = employees.filter(e => mentionedInQuestion(e.name, null, qLower))
  const activeMatchedEmployees = allMatchedEmployees.filter(e => e.employment_status === 'active')
  const mentionedEmployees = activeMatchedEmployees.length > 0 ? activeMatchedEmployees : allMatchedEmployees

  const mentionedProjects = projects.filter(p =>
    mentionedInQuestion(p.title, null, qLower)
  )

  const hasMentionedEntities =
    mentionedLocations.length > 0 || mentionedEmployees.length > 0 || mentionedProjects.length > 0

  // ── 5. Fetch full entity profiles for matched entities ────────────────────
  // Run in parallel with the superseded-IDs fetch (step 6) below.
  const entityProfiles: BrainEntityProfile[] = []
  const profileSources: BrainProfileSource[] = []

  const [supersededRowsResult] = await Promise.all([

    // 5a. Superseded IDs — used to exclude corrected updates in keyword search
    supabase
      .from('kk_updates')
      .select('supersedes_update_id')
      .not('supersedes_update_id', 'is', null),

    // 5b. Employee profiles
    (async () => {
      const empIds = mentionedEmployees.slice(0, 3).map(e => e.id)
      if (empIds.length === 0) return
      const { data } = await supabase
        .from('employees')
        .select('id, name, role_title, store_or_team, employment_status, started_on, manager:manager_employee_id(name)')
        .in('id', empIds)
      for (const emp of data ?? []) {
        const managerRaw = emp.manager
        const managerName = Array.isArray(managerRaw)
          ? (managerRaw[0] as { name: string } | undefined)?.name ?? null
          : (managerRaw as { name: string } | null)?.name ?? null
        const empProfile: EmployeeProfile = {
          kind:              'employee',
          name:              emp.name,
          role_title:        emp.role_title ?? null,
          store_or_team:     emp.store_or_team ?? null,
          employment_status: emp.employment_status,
          started_on:        emp.started_on ?? null,
          manager_name:      managerName,
        }
        entityProfiles.push({ entity_type: 'employee', entity_id: emp.id, display_name: emp.name, profile: empProfile })
        profileSources.push({
          entity_type:  'employee',
          entity_id:    emp.id,
          display_name: emp.name,
          href:         `/people/${emp.id}`,
          fields:       buildProfileFields(empProfile),
        })
      }
    })(),

    // 5c. Location profiles
    (async () => {
      const locIds = mentionedLocations.slice(0, 3).map(l => l.id)
      if (locIds.length === 0) return
      const { data } = await supabase
        .from('locations')
        .select('id, name, short_name, active')
        .in('id', locIds)
      for (const loc of data ?? []) {
        const locProfile: LocationProfile = {
          kind:       'location',
          name:       loc.name,
          short_name: loc.short_name,
          active:     loc.active,
        }
        entityProfiles.push({ entity_type: 'location', entity_id: loc.id, display_name: loc.name, profile: locProfile })
        profileSources.push({
          entity_type:  'location',
          entity_id:    loc.id,
          display_name: loc.name,
          href:         `/locations/${loc.id}`,
          fields:       buildProfileFields(locProfile),
        })
      }
    })(),

    // 5d. Project profiles
    (async () => {
      const projIds = mentionedProjects.slice(0, 3).map(p => p.id)
      if (projIds.length === 0) return
      const { data } = await supabase
        .from('projects')
        .select('id, title, description, status, start_date, due_date, progress, owner:owner_user_id(display_name)')
        .in('id', projIds)
      for (const proj of data ?? []) {
        const ownerRaw = proj.owner
        const ownerName = Array.isArray(ownerRaw)
          ? (ownerRaw[0] as { display_name: string } | undefined)?.display_name ?? null
          : (ownerRaw as { display_name: string } | null)?.display_name ?? null
        const projProfile: ProjectProfile = {
          kind:        'project',
          title:       proj.title,
          description: proj.description ?? null,
          status:      proj.status,
          owner_name:  ownerName,
          start_date:  proj.start_date ?? null,
          due_date:    proj.due_date ?? null,
          progress:    proj.progress ?? null,
        }
        entityProfiles.push({ entity_type: 'project', entity_id: proj.id, display_name: proj.title, profile: projProfile })
        profileSources.push({
          entity_type:  'project',
          entity_id:    proj.id,
          display_name: proj.title,
          href:         `/projects/${proj.id}`,
          fields:       buildProfileFields(projProfile),
        })
      }
    })(),
  ])

  // The entity RPC handles NOT EXISTS internally.
  // For direct table queries, we exclude superseded rows client-side.
  const supersededSet = new Set(
    (supersededRowsResult.data ?? [])
      .map(r => r.supersedes_update_id as string)
      .filter(Boolean)
  )

  // ── 6. Retrieve relevant updates ──────────────────────────────────────────
  const collectedIds = new Set<string>()
  const allRaw: RawUpdateRow[] = []

  function addRow(u: RawUpdateRow) {
    if (!collectedIds.has(u.id)) {
      collectedIds.add(u.id)
      allRaw.push(u)
    }
  }

  // 6a. Entity-specific retrieval via the existing RPC (handles supersession)
  const rpcQueries: Promise<void>[] = []

  for (const loc of mentionedLocations.slice(0, 3)) {
    rpcQueries.push(
      (async () => {
        const { data } = await supabase.rpc('get_current_updates_for_entity', {
          p_entity_type: 'location',
          p_entity_id:   loc.id,
          p_limit:       10,
        })
        for (const u of (data as RawUpdateRow[] | null) ?? []) addRow(u)
      })()
    )
  }

  for (const emp of mentionedEmployees.slice(0, 3)) {
    rpcQueries.push(
      (async () => {
        const { data } = await supabase.rpc('get_current_updates_for_entity', {
          p_entity_type: 'employee',
          p_entity_id:   emp.id,
          p_limit:       10,
        })
        for (const u of (data as RawUpdateRow[] | null) ?? []) addRow(u)
      })()
    )
  }

  for (const proj of mentionedProjects.slice(0, 3)) {
    rpcQueries.push(
      (async () => {
        const { data } = await supabase.rpc('get_current_updates_for_entity', {
          p_entity_type: 'project',
          p_entity_id:   proj.id,
          p_limit:       10,
        })
        for (const u of (data as RawUpdateRow[] | null) ?? []) addRow(u)
      })()
    )
  }

  await Promise.all(rpcQueries)

  // 6b. Keyword text search (supplements entity results or handles free-text queries)
  const keywords = extractKeywords(q)

  if (keywords.length > 0 && allRaw.length < MAX_CONTEXT_UPDATES) {
    const ilikeFilter = keywords.map(kw => `body.ilike.%${kw}%`).join(',')

    const { data: textRows } = await supabase
      .from('kk_updates')
      .select('id, body, occurred_on, created_at, created_by_user_id, supersedes_update_id')
      .eq('brain_excluded', false)
      .or(ilikeFilter)
      .order('occurred_on', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(20)

    for (const u of textRows ?? []) {
      if (!supersededSet.has(u.id)) addRow(u as RawUpdateRow)
    }
  }

  // 6c. Broad-question fallback — return recent updates if nothing found
  if (!hasMentionedEntities && keywords.length === 0) {
    const { data: recentRows } = await supabase
      .from('kk_updates')
      .select('id, body, occurred_on, created_at, created_by_user_id, supersedes_update_id')
      .eq('brain_excluded', false)
      .order('occurred_on', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(10)

    for (const u of recentRows ?? []) {
      if (!supersededSet.has(u.id)) addRow(u as RawUpdateRow)
    }
  }

  // ── 7. Sort by effective date DESC, cap context ───────────────────────────
  allRaw.sort((a, b) => {
    const da = a.occurred_on ?? a.created_at.slice(0, 10)
    const db = b.occurred_on ?? b.created_at.slice(0, 10)
    return db.localeCompare(da)
  })

  const capped = allRaw.slice(0, MAX_CONTEXT_UPDATES)

  // ── 8. Enrich with entity links + author display names ────────────────────
  let linksData:   { update_id: string; entity_type: string; entity_id: string }[] = []
  let authorsData: { id: string; display_name: string }[] = []

  if (capped.length > 0) {
    const cappedIds   = capped.map(u => u.id)
    const authorIdSet = new Set(capped.map(u => u.created_by_user_id).filter(Boolean))

    const [linksResult, authorsResult] = await Promise.all([
      supabase
        .from('kk_update_entities')
        .select('update_id, entity_type, entity_id')
        .in('update_id', cappedIds),
      authorIdSet.size > 0
        ? supabase
            .from('app_users')
            .select('id, display_name')
            .in('id', [...authorIdSet])
        : Promise.resolve({ data: [] as { id: string; display_name: string }[], error: null }),
    ])

    linksData   = linksResult.data   ?? []
    authorsData = authorsResult.data ?? []
  }

  // Build lookup maps
  const linkMap = new Map<string, { entity_type: string; entity_id: string }[]>()
  for (const link of linksData) {
    if (!linkMap.has(link.update_id)) linkMap.set(link.update_id, [])
    linkMap.get(link.update_id)!.push({ entity_type: link.entity_type, entity_id: link.entity_id })
  }

  const authorMap = new Map<string, string>()
  for (const a of authorsData) {
    authorMap.set(a.id, a.display_name)
  }

  // Entity display name resolver (uses the entity lists we already loaded)
  function resolveDisplayName(type: string, id: string): string {
    if (type === 'location') return locations.find(l => l.id === id)?.name ?? '—'
    if (type === 'employee') return employees.find(e => e.id === id)?.name ?? '—'
    return projects.find(p => p.id === id)?.title ?? '—'
  }

  // ── 9. Build context for AI ───────────────────────────────────────────────
  const contextUpdates: BrainContextUpdate[] = capped.map(u => {
    const rawLinks = linkMap.get(u.id) ?? []
    return {
      id:          u.id,
      body:        u.body,
      occurred_on: u.occurred_on ?? null,
      created_at:  u.created_at,
      authorName:  authorMap.get(u.created_by_user_id) ?? null,
      entities: rawLinks.map(l => ({
        entity_type:  l.entity_type,
        entity_id:    l.entity_id,
        display_name: resolveDisplayName(l.entity_type, l.entity_id),
      })),
    }
  })

  // ── 10. Call AI ───────────────────────────────────────────────────────────
  const aiResult = await queryBrain(q, contextUpdates, entityProfiles)
  if (!aiResult.ok) return { error: aiResult.error }

  // ── 11. Build Update sources for UI display ───────────────────────────────
  const sources: BrainSource[] = contextUpdates.map(u => ({
    updateId:    u.id,
    body:        u.body,
    occurred_on: u.occurred_on,
    created_at:  u.created_at,
    authorName:  u.authorName,
    entities: u.entities.map(e => ({
      entity_type:  e.entity_type as KkUpdateEntityType,
      entity_id:    e.entity_id,
      display_name: e.display_name,
      href:         entityHref(e.entity_type as KkUpdateEntityType, e.entity_id),
    })),
  }))

  return { data: { answer: aiResult.answer, profileSources, sources } }
}
