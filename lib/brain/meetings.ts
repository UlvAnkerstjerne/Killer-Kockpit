/**
 * lib/brain/meetings.ts
 *
 * Meeting knowledge retrieval layer for Kockpit Brain.
 *
 * Fetches structured meeting data from Supabase so Brain can answer questions like:
 *   "What was decided about X?"
 *   "What came out of the last Upper Management meeting?"
 *   "When did we discuss Frederiksberg?"
 *
 * Source authority hierarchy (enforced in AI system prompt):
 *   1. Published minutes       (highest authority)
 *   2. Corrections             (addenda to minutes)
 *   3. Structured outcomes     (Decisions / Tasks / Waiting Ons with full body)
 *   4. Context                 (meeting topic/agenda notes)
 *   5. Transcript excerpts     (lowest — raw, unverified)
 *
 * Security
 * ────────
 * • Uses createServiceClient() — brain action has already authenticated the user
 *   and verified they hold a management role (canAccessManagementView).
 * • Meeting content is passed to the AI as data, never as instructions.
 * • Transcript content is only fetched when: no published minutes AND transcript
 *   exists AND the meeting is relevant to the query.
 * • This module never reads or logs user credentials.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { extractKeywordExcerpt } from '@/lib/extractors/text'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BrainMeetingDecision {
  id:           string
  title:        string
  decisionText: string | null
  rationale:    string | null
  status:       string
  decidedAt:    string | null   // YYYY-MM-DD
}

export interface BrainMeetingTask {
  id:    string
  title: string
}

export interface BrainMeetingWaitingOn {
  id:    string
  title: string
}

export interface BrainMeetingCorrection {
  body:      string
  reason:    string | null
  createdAt: string   // YYYY-MM-DD
}

export interface BrainMeetingAttachment {
  fileName:  string
  /** Full text content. Truncated to 4 000 chars when included in Brain context. */
  content:   string
  attachedAt: string   // ISO timestamp
}

export interface BrainMeetingRecord {
  id:             string
  title:          string
  status:         string
  scheduledStart: string | null   // YYYY-MM-DD
  /** Meeting topic / agenda description (pre-meeting intent). */
  context:        string | null
  /** Published minutes body — highest authority. Truncated to 3 000 chars. */
  minutesBody:    string | null
  /** Date the minutes were approved. */
  minutesAt:      string | null   // YYYY-MM-DD
  /** Corrections / addenda — second authority. */
  corrections:    BrainMeetingCorrection[]
  /** Structured outcomes (published decisions with full body, tasks, waiting ons). */
  decisions:      BrainMeetingDecision[]
  tasks:          BrainMeetingTask[]
  waitingOns:     BrainMeetingWaitingOn[]
  /** Keyword-relevant excerpt from transcript — lowest authority, only when no published minutes. */
  transcriptExcerpt: string | null
  /** Whether a transcript exists for this meeting (even if excerpt was not extracted). */
  hasTranscript:  boolean
  /** Plain-text documents attached directly to the meeting (agendas, briefing notes, etc.). */
  attachments:    BrainMeetingAttachment[]
}

export interface BrainMeetingContext {
  /** Meetings matched by the search (most recent first). */
  meetings:            BrainMeetingRecord[]
  /** Decisions searched directly (not via meeting route) — includes full decision body. */
  standaloneDecisions: BrainMeetingDecision[]
}

// ─── Transcript helpers ───────────────────────────────────────────────────────

/**
 * Strips VTT, SRT, and Google Meet timestamp/speaker markup from transcript
 * content, leaving only the spoken text.
 */
export function stripTranscriptMarkup(content: string): string {
  let text = content

  // VTT header
  text = text.replace(/^WEBVTT\b[^\n]*\n?/m, '')

  // VTT NOTE blocks
  text = text.replace(/^NOTE\b[^\n]*(?:\n[^\n]+)*/gm, '')

  // VTT / SRT cue timestamp lines
  // Matches: "00:00:00.000 --> 00:00:05.000" or "00:01 --> 00:03" plus any cue settings on the same line.
  // Uses [^\n]*$ (not \s*...\s*) to avoid crossing into subsequent content lines.
  text = text.replace(
    /^\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d{1,3})?)? --> \d{1,2}:\d{2}(?::\d{2}(?:[.,]\d{1,3})?)?[^\n]*$/gm,
    '',
  )

  // SRT sequence numbers (lines that are only digits)
  text = text.replace(/^\d+\s*$/gm, '')

  // Speaker labels that prefix a line: "Jane Doe: text" (common in Google Meet / Otter)
  // Only strips the label, not the spoken text that follows on the same line.
  text = text.replace(/^[A-ZÆØÅa-zæøå][^:\n]{0,50}:\s*/gm, '')

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  return text
}

/**
 * Extracts a keyword-relevant excerpt from stripped transcript content.
 * Returns the most relevant lines around keyword / entity name matches.
 */
export function extractTranscriptExcerpt(
  content:     string,
  keywords:    string[],
  entityNames: string[],
  maxChars = 800,
): string {
  if (!content.trim()) return ''

  const stripped = stripTranscriptMarkup(content)
  if (!stripped) return ''

  // Build lower-cased search terms
  const terms = [
    ...entityNames.map(n => n.toLowerCase().trim()).filter(n => n.length >= 3),
    ...keywords.map(k => k.toLowerCase().trim()).filter(k => k.length >= 4),
  ]

  if (terms.length === 0) {
    return stripped.length > maxChars ? stripped.slice(0, maxChars) + '…' : stripped
  }

  // Score each non-empty line by how many terms it contains
  const lines = stripped.split(/\n+/).filter(l => l.trim().length > 0)
  const scored: { line: string; score: number }[] = lines
    .map(line => {
      const lower = line.toLowerCase()
      const score = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0)
      return { line, score }
    })
    .filter(({ score }) => score > 0)

  if (scored.length === 0) {
    // No term matches — return leading content as context
    return stripped.length > maxChars ? stripped.slice(0, maxChars) + '…' : stripped
  }

  // Sort by score descending, then build excerpt up to maxChars
  scored.sort((a, b) => b.score - a.score)

  let totalChars = 0
  const excerptLines: string[] = []

  for (const { line } of scored) {
    if (totalChars + line.length + 1 > maxChars) break
    excerptLines.push(line)
    totalChars += line.length + 1
  }

  const excerpt = excerptLines.join('\n')
  return excerpt.length > maxChars ? excerpt.slice(0, maxChars) + '…' : excerpt
}

// ─── Meeting fetcher ──────────────────────────────────────────────────────────

/**
 * Fetches meeting knowledge context for Brain.
 *
 * Search paths:
 *   1. ILIKE across meetings.title, meetings.context
 *   2. ILIKE across meeting_minutes.body (published minutes)
 *
 * For each matched meeting, fetches:
 *   - Published minutes (most recent version)
 *   - Corrections
 *   - Published outcomes (decisions with full body via published_entity_id, tasks, waiting ons)
 *   - Transcript excerpt (only when no published minutes exist)
 */
export async function fetchMeetingContext({
  entityNames,
  keywords,
  maxMeetings = 5,
}: {
  entityNames:  string[]
  keywords:     string[]
  maxMeetings?: number
}): Promise<BrainMeetingRecord[]> {
  const db = createServiceClient()

  // Build search terms — entity names ≥3 chars, keywords ≥4 chars
  const searchTerms = [
    ...entityNames.map(n => n.trim()).filter(n => n.length >= 3),
    ...keywords.filter(k => k.length >= 4),
  ]

  if (searchTerms.length === 0) return []

  const meetingIds = new Set<string>()

  // Path 1: Search meetings directly via title / context
  const meetingFilter = searchTerms
    .flatMap(t => [`title.ilike.%${t}%`, `context.ilike.%${t}%`])
    .join(',')

  const { data: directRows } = await db
    .from('meetings')
    .select('id')
    .or(meetingFilter)
    .not('status', 'in', '(cancelled)')
    .order('scheduled_start', { ascending: false })
    .limit(maxMeetings * 2)

  for (const m of directRows ?? []) meetingIds.add((m as { id: string }).id)

  // Path 2: Search meeting_minutes body
  const minutesFilter = searchTerms.map(t => `body.ilike.%${t}%`).join(',')
  const { data: minutesRows } = await db
    .from('meeting_minutes')
    .select('meeting_id')
    .or(minutesFilter)
    .eq('status', 'published')
    .limit(maxMeetings * 2)

  for (const m of minutesRows ?? []) meetingIds.add((m as { meeting_id: string }).meeting_id)

  if (meetingIds.size === 0) return []

  const idList = [...meetingIds].slice(0, maxMeetings * 2)

  // Fetch full meeting records (title, status, context, scheduled_start, transcript_source_id)
  const { data: meetingRows } = await db
    .from('meetings')
    .select('id, title, status, context, scheduled_start, transcript_source_id')
    .in('id', idList)
    .not('status', 'in', '(cancelled)')
    .order('scheduled_start', { ascending: false })
    .limit(maxMeetings)

  if (!meetingRows || meetingRows.length === 0) return []

  type MeetingRow = {
    id: string; title: string; status: string; context: string | null;
    scheduled_start: string | null; transcript_source_id: string | null
  }
  const typedMeetings = meetingRows as MeetingRow[]
  const finalIds = typedMeetings.map(m => m.id)

  // Batch fetch related data in parallel
  const [minutesResult, correctionsResult, outcomesResult, attachmentsResult] = await Promise.all([
    db
      .from('meeting_minutes')
      .select('meeting_id, body, approved_at, version')
      .in('meeting_id', finalIds)
      .eq('status', 'published')
      .order('version', { ascending: false }),

    db
      .from('meeting_corrections')
      .select('meeting_id, body, reason, created_at')
      .in('meeting_id', finalIds)
      .order('created_at', { ascending: false }),

    db
      .from('meeting_outcomes')
      .select('meeting_id, kind, title, payload_json, status, published_entity_id')
      .in('meeting_id', finalIds)
      .eq('status', 'published')
      .order('sort_order', { ascending: true }),

    // Plain-text documents attached to the meeting (agendas, briefing notes, etc.)
    db
      .from('entity_sources')
      .select('entity_id, created_at, source:source_id(file_name, content)')
      .in('entity_id', finalIds)
      .eq('entity_type', 'meeting')
      .eq('relation', 'meeting_attachment')
      .order('created_at', { ascending: true }),
  ])

  // ── Build lookup maps ──────────────────────────────────────────────────────

  type MinutesRow      = { meeting_id: string; body: string; approved_at: string | null; version: number }
  type CorrectionRow   = { meeting_id: string; body: string; reason: string | null; created_at: string }
  type OutcomeRow      = { meeting_id: string; kind: string; title: string; payload_json: unknown; status: string; published_entity_id: string | null }
  type AttachmentRow   = { entity_id: string; created_at: string; source: { file_name: string | null; content: string | null } | { file_name: string | null; content: string | null }[] | null }

  // Minutes: take first per meeting (highest version, because ordered desc)
  const minutesMap = new Map<string, MinutesRow>()
  for (const m of (minutesResult.data as MinutesRow[] | null) ?? []) {
    if (!minutesMap.has(m.meeting_id)) minutesMap.set(m.meeting_id, m)
  }

  // Corrections: group by meeting
  const correctionsByMeeting = new Map<string, CorrectionRow[]>()
  for (const c of (correctionsResult.data as CorrectionRow[] | null) ?? []) {
    if (!correctionsByMeeting.has(c.meeting_id)) correctionsByMeeting.set(c.meeting_id, [])
    correctionsByMeeting.get(c.meeting_id)!.push(c)
  }

  // Attachments: group by meeting
  const attachmentsByMeeting = new Map<string, BrainMeetingAttachment[]>()
  for (const row of (attachmentsResult.data as AttachmentRow[] | null) ?? []) {
    const src = Array.isArray(row.source) ? row.source[0] : row.source
    if (!src || !src.content) continue
    // Use keyword-based excerpt extraction so long documents remain searchable
    const excerpt = extractKeywordExcerpt(src.content, [...keywords, ...entityNames], 4_000)
    const att: BrainMeetingAttachment = {
      fileName:  src.file_name ?? 'document',
      content:   excerpt,
      attachedAt: row.created_at,
    }
    if (!attachmentsByMeeting.has(row.entity_id)) attachmentsByMeeting.set(row.entity_id, [])
    attachmentsByMeeting.get(row.entity_id)!.push(att)
  }

  // Outcomes: group by meeting; collect decision entity IDs for full-body lookup
  const outcomesByMeeting = new Map<string, OutcomeRow[]>()
  const decisionEntityIds: string[] = []
  for (const o of (outcomesResult.data as OutcomeRow[] | null) ?? []) {
    if (!outcomesByMeeting.has(o.meeting_id)) outcomesByMeeting.set(o.meeting_id, [])
    outcomesByMeeting.get(o.meeting_id)!.push(o)
    if (o.kind === 'decision' && o.published_entity_id) {
      decisionEntityIds.push(o.published_entity_id)
    }
  }

  // Fetch actual decision records for full body content
  type DecisionRow = { id: string; title: string; decision_text: string | null; rationale: string | null; status: string; decided_at: string | null }
  const decisionMap = new Map<string, DecisionRow>()
  if (decisionEntityIds.length > 0) {
    const { data: dRows } = await db
      .from('decisions')
      .select('id, title, decision_text, rationale, status, decided_at')
      .in('id', decisionEntityIds)
    for (const d of (dRows as DecisionRow[] | null) ?? []) {
      decisionMap.set(d.id, d)
    }
  }

  // Fetch transcript content for meetings without published minutes
  const transcriptMap = new Map<string, string>()
  const meetingsNeedingTranscript = typedMeetings.filter(m =>
    !minutesMap.has(m.id) && !!m.transcript_source_id,
  )

  if (meetingsNeedingTranscript.length > 0) {
    const transcriptSourceIds = meetingsNeedingTranscript
      .map(m => m.transcript_source_id!)
      .filter(Boolean)

    if (transcriptSourceIds.length > 0) {
      const { data: sourceRows } = await db
        .from('sources')
        .select('id, content')
        .in('id', transcriptSourceIds)

      type SourceRow = { id: string; content: string | null }
      for (const src of (sourceRows as SourceRow[] | null) ?? []) {
        if (!src.content) continue
        const meeting = meetingsNeedingTranscript.find(m => m.transcript_source_id === src.id)
        if (!meeting) continue
        const excerpt = extractTranscriptExcerpt(src.content, keywords, entityNames)
        if (excerpt) transcriptMap.set(meeting.id, excerpt)
      }
    }
  }

  // ── Build typed BrainMeetingRecord objects ─────────────────────────────────

  return typedMeetings.map(m => {
    const minutes    = minutesMap.get(m.id)
    const corrections = (correctionsByMeeting.get(m.id) ?? []).map(c => ({
      body:      c.body,
      reason:    c.reason,
      createdAt: c.created_at.slice(0, 10),
    }))

    const outcomes = outcomesByMeeting.get(m.id) ?? []

    const decisions:  BrainMeetingDecision[]  = []
    const tasks:      BrainMeetingTask[]      = []
    const waitingOns: BrainMeetingWaitingOn[] = []

    for (const o of outcomes) {
      if (o.kind === 'decision' && o.published_entity_id) {
        const d = decisionMap.get(o.published_entity_id)
        if (d) {
          decisions.push({
            id:           d.id,
            title:        d.title,
            decisionText: d.decision_text,
            rationale:    d.rationale,
            status:       d.status,
            decidedAt:    d.decided_at ? d.decided_at.slice(0, 10) : null,
          })
        } else {
          // Fallback: use outcome payload_json when decision record isn't found
          const payload = o.payload_json as { decision_text?: string; rationale?: string } | null
          decisions.push({
            id:           o.published_entity_id,
            title:        o.title,
            decisionText: payload?.decision_text ?? null,
            rationale:    payload?.rationale ?? null,
            status:       'active',
            decidedAt:    null,
          })
        }
      } else if (o.kind === 'task') {
        tasks.push({ id: o.published_entity_id ?? '', title: o.title })
      } else if (o.kind === 'waiting_on') {
        waitingOns.push({ id: o.published_entity_id ?? '', title: o.title })
      }
    }

    // Truncate minutes body to 3 000 chars for AI context
    let minutesBody: string | null = null
    if (minutes) {
      minutesBody = minutes.body.length > 3_000
        ? minutes.body.slice(0, 3_000) + '…'
        : minutes.body
    }

    return {
      id:             m.id,
      title:          m.title,
      status:         m.status,
      scheduledStart: m.scheduled_start ? m.scheduled_start.slice(0, 10) : null,
      context:        m.context,
      minutesBody,
      minutesAt:      minutes?.approved_at ? minutes.approved_at.slice(0, 10) : null,
      corrections,
      decisions,
      tasks,
      waitingOns,
      transcriptExcerpt: transcriptMap.get(m.id) ?? null,
      hasTranscript:  !!m.transcript_source_id,
      attachments:    attachmentsByMeeting.get(m.id) ?? [],
    }
  })
}

// ─── Standalone decisions fetcher ─────────────────────────────────────────────

/**
 * Fetches decisions with full body content, independent of the meeting route.
 * Used when the question is specifically about decisions.
 */
export async function fetchStandaloneDecisions({
  entityNames,
  keywords,
  max = 5,
}: {
  entityNames: string[]
  keywords:    string[]
  max?:        number
}): Promise<BrainMeetingDecision[]> {
  const db = createServiceClient()

  const searchTerms = [
    ...entityNames.map(n => n.trim()).filter(n => n.length >= 3),
    ...keywords.filter(k => k.length >= 4),
  ]

  if (searchTerms.length === 0) return []

  const ilikeFilter = searchTerms
    .flatMap(t => [`title.ilike.%${t}%`, `decision_text.ilike.%${t}%`])
    .join(',')

  const { data } = await db
    .from('decisions')
    .select('id, title, decision_text, rationale, status, decided_at')
    .or(ilikeFilter)
    .neq('status', 'superseded')
    .is('archived_at', null)
    .order('decided_at', { ascending: false, nullsFirst: false })
    .limit(max)

  type DecisionRow = { id: string; title: string; decision_text: string | null; rationale: string | null; status: string; decided_at: string | null }

  return ((data as DecisionRow[] | null) ?? []).map(d => ({
    id:           d.id,
    title:        d.title,
    decisionText: d.decision_text,
    rationale:    d.rationale,
    status:       d.status,
    decidedAt:    d.decided_at ? d.decided_at.slice(0, 10) : null,
  }))
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Fetches all meeting knowledge context for Brain.
 *
 * @param entityNames     Display names of entities mentioned in the question.
 * @param keywords        Extracted keyword tokens from the question.
 * @param includeDecisions Whether to also run a standalone decision search.
 */
export async function fetchBrainMeetingContext({
  entityNames,
  keywords,
  includeDecisions = false,
}: {
  entityNames:       string[]
  keywords:          string[]
  includeDecisions?: boolean
}): Promise<BrainMeetingContext> {
  const [meetings, standaloneDecisions] = await Promise.all([
    fetchMeetingContext({ entityNames, keywords }).catch(() => [] as BrainMeetingRecord[]),
    includeDecisions
      ? fetchStandaloneDecisions({ entityNames, keywords }).catch(() => [] as BrainMeetingDecision[])
      : Promise.resolve([] as BrainMeetingDecision[]),
  ])

  return { meetings, standaloneDecisions }
}
