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
import { createServiceClient }     from '@/lib/supabase/server'
import { queryBrain }              from '@/lib/ai/brain-query'
import { getGoogleOAuth2Client }   from '@/lib/google/auth'
import { hasGmailScope }           from '@/lib/google/auth'
import { searchGmailForBrain, buildGmailSearchQuery } from '@/lib/google/gmail-search'
import type { ActionResult, KkUpdateEntityType } from '@/lib/types'
import type {
  BrainContextUpdate,
  BrainEmailContext,
  BrainEntityProfile,
  EmployeeProfile,
  LocationProfile,
  ProjectProfile,
  PersonOperationalContext,
  PersonOpItem,
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

/** A card shown in the sources panel for a person's operational Kockpit data. */
export interface BrainOperationalSource {
  kind:       'task' | 'project' | 'waiting_on' | 'decision' | 'meeting'
  id:         string
  title:      string
  href:       string
  meta:       string | null   // e.g. "In Progress · due 3 Jan 2026"
  personName: string
}

/** A card shown in the sources panel for a Gmail message found by Brain. */
export interface BrainEmailSource {
  threadId:     string
  messageId:    string
  subject:      string
  from:         string
  dateIso:      string
  excerpt:      string
  href:         string
  accountEmail: string | null
}

export interface BrainAnswer {
  answer:             string
  profileSources:     BrainProfileSource[]
  operationalSources: BrainOperationalSource[]
  sources:            BrainSource[]
  emailSources:       BrainEmailSource[]
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

function fmtOpStatus(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function fmtOpDate(iso: string): string {
  const d = iso.slice(0, 10)
  const [y, m, day] = d.split('-').map(Number)
  return new Date(y, m - 1, day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function opMeta(status: string | null, dateLabel: string, dateIso: string | null): string | null {
  const parts: string[] = []
  if (status) parts.push(fmtOpStatus(status))
  if (dateIso) parts.push(`${dateLabel} ${fmtOpDate(dateIso)}`)
  return parts.length > 0 ? parts.join(' · ') : null
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
  const entityProfiles:      BrainEntityProfile[]       = []
  const profileSources:      BrainProfileSource[]       = []
  const operationalContexts: PersonOperationalContext[] = []
  const operationalSources:  BrainOperationalSource[]  = []

  const [supersededRowsResult] = await Promise.all([

    // 5a. Superseded IDs — used to exclude corrected updates in keyword search
    supabase
      .from('kk_updates')
      .select('supersedes_update_id')
      .not('supersedes_update_id', 'is', null),

    // 5b. Employee profiles + operational context
    (async () => {
      const empIds = mentionedEmployees.slice(0, 3).map(e => e.id)
      if (empIds.length === 0) return
      const { data } = await supabase
        .from('employees')
        .select('id, name, role_title, store_or_team, employment_status, started_on, linked_user_id, manager:manager_employee_id(name)')
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

        // ── Operational context ──────────────────────────────────────────────
        const linkedUserId = emp.linked_user_id as string | null
        const noData = { data: [] as never[] }

        const [taskRows, projRows, waitingOnRows, decisionRows, meetingAttRows] = await Promise.all([
          linkedUserId
            ? supabase
                .from('tasks')
                .select('id, title, status, due_at')
                .eq('owner_user_id', linkedUserId)
                .not('status', 'in', '(done,cancelled)')
                .is('archived_at', null)
                .order('due_at', { ascending: true, nullsFirst: false })
                .limit(5)
            : Promise.resolve(noData),

          linkedUserId
            ? supabase
                .from('projects')
                .select('id, title, status, due_date')
                .eq('owner_user_id', linkedUserId)
                .not('status', 'in', '(completed,archived,cancelled)')
                .order('due_date', { ascending: true, nullsFirst: false })
                .limit(5)
            : Promise.resolve(noData),

          supabase
            .from('waiting_ons')
            .select('id, title, status, due_at')
            .eq('waiting_for_employee_id', emp.id)
            .in('status', ['open', 'overdue'])
            .is('archived_at', null)
            .order('due_at', { ascending: true, nullsFirst: false })
            .limit(5),

          linkedUserId
            ? supabase
                .from('decisions')
                .select('id, title, status, decided_at')
                .eq('owner_user_id', linkedUserId)
                .neq('status', 'superseded')
                .is('archived_at', null)
                .order('decided_at', { ascending: false, nullsFirst: false })
                .limit(5)
            : Promise.resolve(noData),

          linkedUserId
            ? supabase
                .from('meeting_attendees')
                .select('meeting_id')
                .eq('user_id', linkedUserId)
                .limit(20)
            : Promise.resolve(noData),
        ])

        // Resolve meeting details from attendance list
        let meetingRows: { id: string; title: string; status: string; scheduled_start: string | null }[] = []
        if (meetingAttRows.data && meetingAttRows.data.length > 0) {
          const meetingIds = (meetingAttRows.data as { meeting_id: string }[]).map(a => a.meeting_id)
          const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
          const { data: mRows } = await supabase
            .from('meetings')
            .select('id, title, status, scheduled_start')
            .in('id', meetingIds)
            .neq('status', 'cancelled')
            .or(`scheduled_start.gte.${cutoff},scheduled_start.is.null`)
            .order('scheduled_start', { ascending: false })
            .limit(5)
          meetingRows = mRows ?? []
        }

        // Build operational context for the AI
        const opCtx: PersonOperationalContext = {
          employee_id:  emp.id,
          display_name: emp.name,
          tasks: (taskRows.data as { id: string; title: string; status: string; due_at: string | null }[] ?? []).map(t => ({
            title:  t.title,
            status: fmtOpStatus(t.status),
            date:   t.due_at ? t.due_at.slice(0, 10) : null,
            extra:  null,
          } satisfies PersonOpItem)),
          projects: (projRows.data as { id: string; title: string; status: string; due_date: string | null }[] ?? []).map(p => ({
            title:  p.title,
            status: fmtOpStatus(p.status),
            date:   p.due_date ?? null,
            extra:  null,
          } satisfies PersonOpItem)),
          waitingOns: (waitingOnRows.data as { id: string; title: string; status: string; due_at: string | null }[] ?? []).map(w => ({
            title:  w.title,
            status: fmtOpStatus(w.status),
            date:   w.due_at ? w.due_at.slice(0, 10) : null,
            extra:  null,
          } satisfies PersonOpItem)),
          decisions: (decisionRows.data as { id: string; title: string; status: string; decided_at: string | null }[] ?? []).map(d => ({
            title:  d.title,
            status: fmtOpStatus(d.status),
            date:   d.decided_at ? d.decided_at.slice(0, 10) : null,
            extra:  null,
          } satisfies PersonOpItem)),
          meetings: meetingRows.map(m => ({
            title:  m.title,
            status: fmtOpStatus(m.status),
            date:   m.scheduled_start ? m.scheduled_start.slice(0, 10) : null,
            extra:  null,
          } satisfies PersonOpItem)),
        }
        operationalContexts.push(opCtx)

        // Build operational sources for the UI
        for (const t of taskRows.data as { id: string; title: string; status: string; due_at: string | null }[] ?? []) {
          operationalSources.push({
            kind:       'task',
            id:         t.id,
            title:      t.title,
            href:       `/tasks/${t.id}`,
            meta:       opMeta(t.status, 'due', t.due_at),
            personName: emp.name,
          })
        }
        for (const p of projRows.data as { id: string; title: string; status: string; due_date: string | null }[] ?? []) {
          operationalSources.push({
            kind:       'project',
            id:         p.id,
            title:      p.title,
            href:       `/projects/${p.id}`,
            meta:       opMeta(p.status, 'due', p.due_date),
            personName: emp.name,
          })
        }
        for (const w of waitingOnRows.data as { id: string; title: string; status: string; due_at: string | null }[] ?? []) {
          operationalSources.push({
            kind:       'waiting_on',
            id:         w.id,
            title:      w.title,
            href:       `/waiting-ons/${w.id}`,
            meta:       opMeta(w.status, 'due', w.due_at),
            personName: emp.name,
          })
        }
        for (const d of decisionRows.data as { id: string; title: string; status: string; decided_at: string | null }[] ?? []) {
          operationalSources.push({
            kind:       'decision',
            id:         d.id,
            title:      d.title,
            href:       `/decisions/${d.id}`,
            meta:       opMeta(d.status, 'decided', d.decided_at),
            personName: emp.name,
          })
        }
        for (const m of meetingRows) {
          operationalSources.push({
            kind:       'meeting',
            id:         m.id,
            title:      m.title,
            href:       `/meetings/${m.id}`,
            meta:       opMeta(m.status, '', m.scheduled_start),
            personName: emp.name,
          })
        }
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

  // ── 10. Gmail multi-account search ────────────────────────────────────────
  //
  // Search all connected Gmail accounts (those with gmail.readonly scope).
  // Results are deduplicated by threadId and capped at 5.
  // Email bodies are UNTRUSTED source material — they are passed to the AI
  // as data and never treated as instructions (enforced in system prompt).
  const emailContexts: BrainEmailContext[] = []
  const emailSources:  BrainEmailSource[]  = []

  try {
    const serviceClient = createServiceClient()
    const { data: tokenRows } = await serviceClient
      .from('google_oauth_tokens')
      .select('user_id, google_account_email, scopes')

    const gmailUsers = (tokenRows ?? []).filter(row =>
      hasGmailScope((row.scopes as string[] | null) ?? [])
    )

    if (gmailUsers.length > 0) {
      const mentionedNames = [
        ...mentionedLocations.map(l => l.name),
        ...mentionedEmployees.map(e => e.name),
        ...mentionedProjects.map(p => p.title),
      ]
      const keywords = extractKeywords(q)
      const gmailQuery = buildGmailSearchQuery(mentionedNames, keywords)

      if (gmailQuery) {
        const searchResults = await Promise.allSettled(
          gmailUsers.map(async row => {
            const oauthClient = await getGoogleOAuth2Client(row.user_id as string)
            if (!oauthClient) return []
            return searchGmailForBrain(
              oauthClient,
              (row.google_account_email as string | null) ?? null,
              gmailQuery,
              8,
            )
          })
        )

        // Collect results, deduplicate by threadId, cap at 5
        const seenThreadIds = new Set<string>()
        for (const outcome of searchResults) {
          if (outcome.status !== 'fulfilled') continue
          for (const msg of outcome.value) {
            if (seenThreadIds.has(msg.threadId)) continue
            seenThreadIds.add(msg.threadId)

            emailContexts.push({
              threadId:     msg.threadId,
              subject:      msg.subject,
              from:         msg.from,
              dateIso:      msg.dateIso,
              body:         msg.body,
              accountEmail: msg.accountEmail,
            })
            emailSources.push({
              threadId:     msg.threadId,
              messageId:    msg.messageId,
              subject:      msg.subject,
              from:         msg.from,
              dateIso:      msg.dateIso,
              excerpt:      msg.excerpt,
              href:         msg.href,
              accountEmail: msg.accountEmail,
            })

            if (emailContexts.length >= 5) break
          }
          if (emailContexts.length >= 5) break
        }

        // Sort email contexts by date descending (most recent first)
        emailContexts.sort((a, b) => b.dateIso.localeCompare(a.dateIso))
        emailSources.sort((a, b) => b.dateIso.localeCompare(a.dateIso))
      }
    }
  } catch (gmailErr) {
    // Gmail search failure is non-fatal — log and continue without email context
    console.error('[brain] Gmail search failed:', (gmailErr as Error).message)
  }

  // ── 11. Call AI ───────────────────────────────────────────────────────────
  const aiResult = await queryBrain(q, contextUpdates, entityProfiles, operationalContexts, emailContexts)
  if (!aiResult.ok) return { error: aiResult.error }

  // ── 12. Build Update sources for UI display ───────────────────────────────
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

  return { data: { answer: aiResult.answer, profileSources, operationalSources, sources, emailSources } }
}
