/**
 * lib/brain/quality.ts
 *
 * Quality retrieval layer for Kockpit Brain.
 *
 * Fetches structured quality data from all three Killer Kuality Check systems:
 *   - Operational Audit (Supabase — audit_submissions)
 *   - Mystery Diner    (Supabase — diner_submissions)
 *   - SSP / CPH KQC   (Google Sheets via lib/kkc/ssp-cph.ts)
 *
 * Security
 * ────────
 * • Uses createServiceClient() — brain action has already authenticated the user
 *   and verified they hold a management role (canAccessManagementView).
 * • Quality data is passed to the AI as data, never as instructions.
 * • This module never reads or logs user credentials.
 */

import { createServiceClient }   from '@/lib/supabase/server'
import { getSSPCphData }         from '@/lib/kkc/ssp-cph'
import { buildSubmissionDetail } from '@/lib/kkc/detail'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BrainAuditFailedCheckpoint {
  section:   string
  title:     string
  isCore:    boolean
  isRedFlag: boolean
}

export interface BrainAuditSubmission {
  submittedAt:       string         // YYYY-MM-DD
  scorePct:          number | null
  coreScorePct:      number | null
  redFlagCount:      number | null
  auditStatus:       string | null  // GREEN | LIGHT_GREEN | YELLOW | ORANGE | RED
  auditorName:       string | null
  failedCheckpoints: BrainAuditFailedCheckpoint[]
  topActions:        string[]
  donWell:           string | null
  correctiveAction:  string | null
  followUpRequested: boolean
}

export interface BrainAuditContext {
  locationId:   string
  locationName: string
  submissions:  BrainAuditSubmission[]
}

export interface BrainDinerCriticalFailure {
  label:   string
  section: string
  notes:   string | null
}

export interface BrainDinerSubmission {
  submittedAt:       string
  scorePct:          number | null
  criticalFailCount: number | null
  goldStarCount:     number | null
  waitingTimeBand:   string | null
  finalStatus:       string | null
  dinerName:         string | null
  criticalFailures:  BrainDinerCriticalFailure[]
}

export interface BrainDinerContext {
  locationId:   string
  locationName: string
  submissions:  BrainDinerSubmission[]
}

export interface BrainSSPSubmission {
  date:                   string
  overallScore:           number
  criticalScore:          number
  criticalFailures:       number
  criticalFailureDetails: { section: string; checkpoint: string }[]
  overallComments:        string | null
}

export interface BrainSSPContext {
  submissions: BrainSSPSubmission[]
}

export interface BrainQualityContext {
  audit: BrainAuditContext[]
  diner: BrainDinerContext[]
  ssp:   BrainSSPContext | null
}

// ─── Audit fetcher ────────────────────────────────────────────────────────────

export async function fetchAuditContext(
  locationIds:   string[],
  locationNames: Map<string, string>,
): Promise<BrainAuditContext[]> {
  if (locationIds.length === 0) return []

  const db = createServiceClient()

  // Find the published operational audit template
  const { data: template } = await db
    .from('audit_templates')
    .select('id')
    .eq('audit_key', 'operational_audit')
    .eq('status', 'published')
    .maybeSingle()

  if (!template) return []

  // Fetch up to 3 submitted submissions per location in parallel
  const perLocResults = await Promise.all(
    locationIds.map(locationId =>
      db
        .from('audit_submissions')
        .select(`
          id, score_pct, core_score_pct, red_flag_count, audit_status,
          submitted_at, final_done_well, final_corrective_action,
          follow_up_requested,
          app_users!auditor_user_id ( display_name )
        `)
        .eq('template_id', template.id)
        .eq('location_id', locationId)
        .eq('status', 'submitted')
        .order('submitted_at', { ascending: false })
        .limit(3),
    ),
  )

  // Collect all rows with their location context
  const allRows: { locationId: string; row: Record<string, unknown> }[] = []
  for (let i = 0; i < locationIds.length; i++) {
    for (const row of (perLocResults[i].data as Record<string, unknown>[] | null) ?? []) {
      allRows.push({ locationId: locationIds[i], row })
    }
  }

  if (allRows.length === 0) return []

  const allIds = allRows.map(r => r.row.id as string)

  // Batch fetch failed responses, top actions, section comments
  const [responsesResult, topActionsResult, sectionCommentsResult] = await Promise.all([
    db
      .from('audit_responses')
      .select('submission_id, checkpoint_id, result')
      .in('submission_id', allIds)
      .eq('result', 'fail'),
    db
      .from('audit_top_actions')
      .select('submission_id, action')
      .in('submission_id', allIds)
      .order('sort_order', { ascending: true }),
    db
      .from('audit_section_comments')
      .select('submission_id, section, comment')
      .in('submission_id', allIds),
  ])

  // Collect unique checkpoint IDs from failed responses
  const failedCpIds = [
    ...new Set(
      ((responsesResult.data as { checkpoint_id: string }[] | null) ?? [])
        .map(r => r.checkpoint_id),
    ),
  ]

  // Fetch checkpoint metadata
  const cpMap = new Map<string, {
    section: string; title: string; is_core_standard: boolean; is_red_flag: boolean
  }>()
  if (failedCpIds.length > 0) {
    const { data: cpRows } = await db
      .from('audit_checkpoints')
      .select('id, section, title, is_core_standard, is_red_flag')
      .in('id', failedCpIds)
    for (const cp of (cpRows as Record<string, unknown>[] | null) ?? []) {
      cpMap.set(cp.id as string, cp as typeof cpMap extends Map<string, infer V> ? V : never)
    }
  }

  // Build per-submission lookup maps
  type FailedRow        = { submission_id: string; checkpoint_id: string }
  type ActionRow        = { submission_id: string; action: string }
  type SectionCommentRow = { submission_id: string; section: string; comment: string }

  const failedBySub = new Map<string, string[]>()
  for (const r of (responsesResult.data as FailedRow[] | null) ?? []) {
    if (!failedBySub.has(r.submission_id)) failedBySub.set(r.submission_id, [])
    failedBySub.get(r.submission_id)!.push(r.checkpoint_id)
  }

  const actionsBySub = new Map<string, string[]>()
  for (const a of (topActionsResult.data as ActionRow[] | null) ?? []) {
    if (!actionsBySub.has(a.submission_id)) actionsBySub.set(a.submission_id, [])
    actionsBySub.get(a.submission_id)!.push(a.action)
  }

  const commentsBySub = new Map<string, { section: string; comment: string }[]>()
  for (const c of (sectionCommentsResult.data as SectionCommentRow[] | null) ?? []) {
    if (!commentsBySub.has(c.submission_id)) commentsBySub.set(c.submission_id, [])
    commentsBySub.get(c.submission_id)!.push({ section: c.section, comment: c.comment ?? '' })
  }

  // Group submissions by location and build typed results
  const byLoc = new Map<string, BrainAuditSubmission[]>()
  for (const { locationId, row } of allRows) {
    if (!byLoc.has(locationId)) byLoc.set(locationId, [])

    const cpIds = failedBySub.get(row.id as string) ?? []
    const failedCheckpoints: BrainAuditFailedCheckpoint[] = cpIds
      .map(cpId => {
        const cp = cpMap.get(cpId)
        if (!cp) return null
        return {
          section:   cp.section,
          title:     cp.title,
          isCore:    cp.is_core_standard,
          isRedFlag: cp.is_red_flag,
        }
      })
      .filter((x): x is BrainAuditFailedCheckpoint => x !== null)

    const auditorRaw = row.app_users as { display_name: string } | null
    const auditorName = auditorRaw?.display_name ?? null

    byLoc.get(locationId)!.push({
      submittedAt:       ((row.submitted_at as string) ?? '').slice(0, 10),
      scorePct:          row.score_pct as number | null,
      coreScorePct:      row.core_score_pct as number | null,
      redFlagCount:      row.red_flag_count as number | null,
      auditStatus:       row.audit_status as string | null,
      auditorName,
      failedCheckpoints,
      topActions:        actionsBySub.get(row.id as string) ?? [],
      donWell:           (row.final_done_well as string | null) ?? null,
      correctiveAction:  (row.final_corrective_action as string | null) ?? null,
      followUpRequested: (row.follow_up_requested as boolean | null) ?? false,
    })
  }

  return locationIds
    .filter(id => byLoc.has(id))
    .map(id => ({
      locationId:   id,
      locationName: locationNames.get(id) ?? id,
      submissions:  byLoc.get(id)!,
    }))
}

// ─── Diner fetcher ────────────────────────────────────────────────────────────

export async function fetchDinerContext(
  locationIds:   string[],
  locationNames: Map<string, string>,
): Promise<BrainDinerContext[]> {
  if (locationIds.length === 0) return []

  const db = createServiceClient()

  // Step 1 — find invitations for these locations
  const { data: invRows } = await db
    .from('diner_invitations')
    .select('id, diner_name, location_id')
    .in('location_id', locationIds)

  if (!invRows || invRows.length === 0) return []

  type InvRow = { id: string; diner_name: string | null; location_id: string }
  const invMap = new Map((invRows as InvRow[]).map(i => [i.id, i]))
  const invIds = (invRows as InvRow[]).map(i => i.id)

  // Step 2 — fetch recent submitted submissions
  const { data: subs } = await db
    .from('diner_submissions')
    .select('id, invitation_id, score_pct, critical_fail_count, gold_star_count, waiting_time_band, final_status, submitted_at')
    .in('invitation_id', invIds)
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false })
    .limit(20)

  if (!subs || subs.length === 0) return []

  type SubRow = {
    id:                  string
    invitation_id:       string
    score_pct:           number | null
    critical_fail_count: number | null
    gold_star_count:     number | null
    waiting_time_band:   string | null
    final_status:        string | null
    submitted_at:        string
  }

  const typedSubs = subs as SubRow[]
  const subIds = typedSubs.map(s => s.id)

  // Step 3 — fetch failed diner responses
  const { data: responses } = await db
    .from('diner_responses')
    .select('submission_id, checkpoint_id, result, notes')
    .in('submission_id', subIds)
    .eq('result', 'fail')

  // Step 4 — fetch checkpoint metadata for failed checkpoints where is_critical
  type DinerRespRow = { submission_id: string; checkpoint_id: string; notes: string | null }
  const failedCpIds = [
    ...new Set(
      ((responses as DinerRespRow[] | null) ?? []).map(r => r.checkpoint_id),
    ),
  ]

  const cpMap = new Map<string, { section: string; label: string; is_critical: boolean }>()
  if (failedCpIds.length > 0) {
    const { data: cpRows } = await db
      .from('diner_checkpoints')
      .select('id, section, label, is_critical')
      .in('id', failedCpIds)
    for (const cp of (cpRows as Record<string, unknown>[] | null) ?? []) {
      cpMap.set(cp.id as string, cp as typeof cpMap extends Map<string, infer V> ? V : never)
    }
  }

  // Build per-submission critical failures lookup
  const failuresBySub = new Map<string, BrainDinerCriticalFailure[]>()
  for (const r of (responses as DinerRespRow[] | null) ?? []) {
    const cp = cpMap.get(r.checkpoint_id)
    if (!cp?.is_critical) continue
    if (!failuresBySub.has(r.submission_id)) failuresBySub.set(r.submission_id, [])
    failuresBySub.get(r.submission_id)!.push({
      label:   cp.label,
      section: cp.section,
      notes:   r.notes ?? null,
    })
  }

  // Group by location, cap at 3 per location
  const byLoc = new Map<string, BrainDinerSubmission[]>()
  for (const sub of typedSubs) {
    const inv = invMap.get(sub.invitation_id)
    if (!inv) continue
    const locationId = inv.location_id
    if (!locationIds.includes(locationId)) continue

    const existing = byLoc.get(locationId) ?? []
    if (existing.length >= 3) continue
    if (!byLoc.has(locationId)) byLoc.set(locationId, [])

    byLoc.get(locationId)!.push({
      submittedAt:       sub.submitted_at.slice(0, 10),
      scorePct:          sub.score_pct,
      criticalFailCount: sub.critical_fail_count,
      goldStarCount:     sub.gold_star_count,
      waitingTimeBand:   sub.waiting_time_band,
      finalStatus:       sub.final_status,
      dinerName:         inv.diner_name ?? null,
      criticalFailures:  failuresBySub.get(sub.id) ?? [],
    })
  }

  return locationIds
    .filter(id => byLoc.has(id))
    .map(id => ({
      locationId:   id,
      locationName: locationNames.get(id) ?? id,
      submissions:  byLoc.get(id)!,
    }))
}

// ─── SSP fetcher ──────────────────────────────────────────────────────────────

export async function fetchSSPContext(): Promise<BrainSSPContext | null> {
  let data
  try {
    data = await getSSPCphData()
  } catch {
    return null
  }

  if (!data.scores.length) return null

  // Most recent 5 entries (sheet is oldest-first, so take from end)
  const recent = data.scores.slice(-5).reverse()

  const submissions: BrainSSPSubmission[] = recent.map(score => {
    const detail = buildSubmissionDetail(data, score.timestamp)
    return {
      date:                   score.date,
      overallScore:           score.overallScore,
      criticalScore:          score.criticalScore,
      criticalFailures:       score.criticalFailures,
      criticalFailureDetails: (detail?.criticalFailureDetails ?? []).map(cp => ({
        section:    cp.section,
        checkpoint: cp.checkpoint,
      })),
      overallComments: detail?.overallComments ?? null,
    }
  })

  return { submissions }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Fetches quality context for the Brain from all three KQC systems.
 *
 * @param locationIds    IDs of locations mentioned in the question.
 * @param locationNames  Map of location_id → display name.
 * @param fetchSSP       Whether to include SSP/CPH Airport data.
 */
export async function fetchQualityContext({
  locationIds,
  locationNames,
  fetchSSP = false,
}: {
  locationIds:   string[]
  locationNames: Map<string, string>
  fetchSSP?:     boolean
}): Promise<BrainQualityContext> {
  const [audit, diner, ssp] = await Promise.all([
    fetchAuditContext(locationIds, locationNames).catch(() => [] as BrainAuditContext[]),
    fetchDinerContext(locationIds, locationNames).catch(() => [] as BrainDinerContext[]),
    fetchSSP ? fetchSSPContext().catch(() => null) : Promise.resolve(null),
  ])
  return { audit, diner, ssp }
}
