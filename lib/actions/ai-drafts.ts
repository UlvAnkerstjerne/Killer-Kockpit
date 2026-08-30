'use server'

/**
 * lib/actions/ai-drafts.ts
 *
 * Server actions for AI-generated staged meeting drafts (Phase M5B).
 *
 * Actions
 * ───────
 *   generateMeetingDraft — authenticate → authorise → fetch context →
 *                          call AI → store draft → audit → return draft ID
 *   getLatestDraft       — fetch the most recent non-discarded draft for a meeting
 *   discardDraft         — mark a draft as discarded
 *
 * Side-effect guarantee
 * ─────────────────────
 * generateMeetingDraft does NOT:
 *   • modify working_notes
 *   • create meeting_outcomes
 *   • create Tasks / Decisions / Waiting Ons
 *   • change meeting status
 *   • publish anything
 * It ONLY creates a meeting_ai_drafts row and an audit event.
 *
 * Security
 * ────────
 * All DB writes use createServiceClient() (service role, bypasses RLS).
 * Reads from app_users / meetings / sources go through service client too so
 * that the action works regardless of the calling user's own RLS visibility.
 * The Anthropic API key and transcript content are never logged or returned
 * to the browser.
 */

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import { canGenerateDraft, canManageTranscript } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import { recordAuditEvent } from '@/lib/audit'
import { generateDraftFromContext, PROMPT_VERSION } from '@/lib/ai/generate-meeting-draft'
import { MeetingDraftOutputSchema } from '@/lib/ai/meeting-draft-schema'
import { parseDeadlineFromEvidence } from '@/lib/ai/parse-deadline'
import type { ActionResult, MeetingAiDraft } from '@/lib/types'
import type { MeetingDraftContext } from '@/lib/ai/generate-meeting-draft'

// ─── Allowed statuses for draft generation ────────────────────────────────────
// Mirrors TRANSCRIPT_ALLOWED_STATUSES in permissions.ts — only meetings that
// could have a transcript attached are valid generation targets.
const GENERATION_ALLOWED_STATUSES = new Set(['scheduled', 'open', 'draft'])

// ─── generateMeetingDraft ─────────────────────────────────────────────────────

/**
 * Generates a structured AI draft for a meeting.
 *
 * Enforces:
 *   • Authentication
 *   • Permission (canGenerateDraft: owner / UM / SUPER_ADMIN)
 *   • Meeting status (scheduled / open / draft only)
 *   • Transcript must exist
 *
 * Creates exactly one meeting_ai_drafts row on success.
 * No meeting_outcomes, no working_notes change, no status change.
 */
export async function generateMeetingDraft(
  meetingId: string,
): Promise<ActionResult<{ draftId: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const db = createServiceClient()

  // ── Fetch meeting context ──────────────────────────────────────────────────
  const { data: meeting } = await db
    .from('meetings')
    .select(`
      id, title, status, owner_user_id, working_notes,
      scheduled_start, transcript_source_id,
      project:project_id (id, title)
    `)
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found.' }

  // ── Permission check ───────────────────────────────────────────────────────
  const owner = Array.isArray(meeting.project) ? meeting.project[0] : meeting.project

  if (!canGenerateDraft(user.role, meeting.owner_user_id, user.id, meeting.status)) {
    return { error: 'You do not have permission to generate an AI draft for this meeting.' }
  }

  // ── Status check ───────────────────────────────────────────────────────────
  if (!GENERATION_ALLOWED_STATUSES.has(meeting.status)) {
    return { error: `AI draft generation is not available for ${meeting.status} meetings.` }
  }

  // ── Transcript check ───────────────────────────────────────────────────────
  if (!meeting.transcript_source_id) {
    return { error: 'This meeting has no transcript. Attach a transcript before generating a draft.' }
  }

  // ── Fetch transcript content ───────────────────────────────────────────────
  const { data: source } = await db
    .from('sources')
    .select('id, file_name, content')
    .eq('id', meeting.transcript_source_id)
    .single()

  if (!source?.content) {
    return { error: 'Transcript content is unavailable.' }
  }

  // ── Fetch attendees (display names only — no emails, no UUIDs) ─────────────
  const { data: attendeeRows } = await db
    .from('meeting_attendees')
    .select('user_id, external_name, user:user_id (display_name)')
    .eq('meeting_id', meetingId)

  const attendeeNames: string[] = (attendeeRows ?? []).map((a) => {
    // Internal attendee with a linked user
    const linked = Array.isArray(a.user) ? a.user[0] : a.user
    if (linked?.display_name) return linked.display_name as string
    // External attendee (no user account)
    return a.external_name ?? ''
  }).filter(Boolean)

  // ── Build context (safe: no emails, UUIDs, roles, tokens) ─────────────────
  const ctx: MeetingDraftContext = {
    meetingTitle:       meeting.title,
    scheduledStart:     meeting.scheduled_start ?? null,
    projectTitle:       (Array.isArray(meeting.project) ? meeting.project[0] : meeting.project)?.title ?? null,
    attendeeNames,
    workingNotes:       meeting.working_notes ?? null,
    transcriptContent:  source.content,
    transcriptFileName: source.file_name ?? null,
  }

  // ── Call AI ───────────────────────────────────────────────────────────────
  const result = await generateDraftFromContext(ctx)

  if (!result.ok) {
    return { error: result.error }
  }

  // ── Persist draft (service role — no direct authenticated writes) ──────────
  const { data: draft, error: insertErr } = await db
    .from('meeting_ai_drafts')
    .insert({
      meeting_id:           meetingId,
      transcript_source_id: meeting.transcript_source_id,
      model:                result.model,
      prompt_version:       PROMPT_VERSION,
      input_char_count:     result.inputCharCount,
      output_json:          result.output,
      generated_by_user_id: user.id,
    })
    .select('id')
    .single()

  if (insertErr || !draft) {
    console.error('[ai-drafts] Failed to insert meeting_ai_drafts:', insertErr?.message)
    return { error: 'Failed to store the AI draft. Please try again.' }
  }

  // ── Audit ─────────────────────────────────────────────────────────────────
  await recordAuditEvent({
    actorUserId: user.id,
    action:      'meeting.ai_draft_generated',
    entityType:  'meeting',
    entityId:    meetingId,
    afterJson: {
      draft_id:        draft.id,
      model:           result.model,
      prompt_version:  PROMPT_VERSION,
      input_char_count: result.inputCharCount,
      task_count:      result.output.tasks.length,
      decision_count:  result.output.decisions.length,
      waiting_on_count: result.output.waiting_ons.length,
    },
  })

  revalidatePath(`/meetings/${meetingId}`)

  return { data: { draftId: draft.id } }
}

// ─── getLatestDraft ───────────────────────────────────────────────────────────

/**
 * Returns the most recent non-discarded draft for a meeting, or null if none.
 *
 * Used for initial page load — the page pre-fetches and passes it to the
 * AiDraftSection component as a prop to avoid a client-side loading state.
 */
export async function getLatestDraft(
  meetingId: string,
): Promise<MeetingAiDraft | null> {
  const db = createServiceClient()

  const { data } = await db
    .from('meeting_ai_drafts')
    .select('*')
    .eq('meeting_id', meetingId)
    .is('discarded_at', null)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data) return null

  // Validate output_json shape at runtime before returning to the UI
  const parsed = MeetingDraftOutputSchema.safeParse(data.output_json)
  if (!parsed.success) {
    console.error('[ai-drafts] Draft output_json failed validation:', data.id)
    return null
  }

  return {
    ...(data as Omit<MeetingAiDraft, 'output_json'>),
    output_json: parsed.data,
  }
}

// ─── discardDraft ─────────────────────────────────────────────────────────────

/**
 * Marks a draft as discarded.
 *
 * The row is preserved — discarding is a soft state transition, not a delete.
 * Only the draft author or someone with generate permission can discard.
 */
export async function discardDraft(
  draftId: string,
  meetingId: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const db = createServiceClient()

  // Fetch draft to verify it belongs to this meeting and isn't already acted on
  const { data: draft } = await db
    .from('meeting_ai_drafts')
    .select('id, meeting_id, generated_by_user_id, applied_at, discarded_at')
    .eq('id', draftId)
    .eq('meeting_id', meetingId)
    .single()

  if (!draft) return { error: 'Draft not found.' }
  if (draft.applied_at) return { error: 'This draft has already been applied and cannot be discarded.' }
  if (draft.discarded_at) return { error: 'This draft has already been discarded.' }

  // Permission: meeting-level generate permission (owner / UM / SUPER_ADMIN)
  const { data: meeting } = await db
    .from('meetings')
    .select('owner_user_id, status')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found.' }

  if (!canManageTranscript(user.role, meeting.owner_user_id, user.id, meeting.status)) {
    return { error: 'You do not have permission to discard this draft.' }
  }

  const { error: updateErr } = await db
    .from('meeting_ai_drafts')
    .update({ discarded_at: new Date().toISOString(), discarded_by_user_id: user.id })
    .eq('id', draftId)

  if (updateErr) {
    console.error('[ai-drafts] Failed to discard draft:', updateErr.message)
    return { error: 'Failed to discard draft. Please try again.' }
  }

  await recordAuditEvent({
    actorUserId: user.id,
    action:      'meeting.ai_draft_discarded',
    entityType:  'meeting',
    entityId:    meetingId,
    afterJson:   { draft_id: draftId },
  })

  revalidatePath(`/meetings/${meetingId}`)

  return {}
}

// ─── applyMeetingDraft ────────────────────────────────────────────────────────

/**
 * Applies an AI draft to a meeting — the M5C "Use this draft" action.
 *
 * Resolution steps performed in TypeScript before the atomic DB call:
 *   • Owner: exact case-insensitive display-name match → user UUID (null if no match)
 *   • Deadline: parsed from deadline_evidence text (ISO date > month+day > weekday)
 *   • Priority: high→1, low→3, everything else→2 (Normal)
 *   • Project: inherited from the meeting's project_id
 *
 * The RPC apply_meeting_ai_draft_and_audit() atomically:
 *   • Verifies the draft is unapplied/undiscarded
 *   • Verifies the meeting is in an editable status
 *   • Optionally overwrites working_notes with the draft's minutes
 *   • Creates proposed meeting_outcomes with ai_draft_id set for provenance
 *   • Marks the draft applied and records an audit event
 */
export async function applyMeetingDraft(
  draftId: string,
  meetingId: string,
  options: { applyWorkingNotes: boolean },
): Promise<ActionResult<{ outcomesCreated: number }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const db = createServiceClient()

  // ── Fetch draft ────────────────────────────────────────────────────────────
  const { data: draft } = await db
    .from('meeting_ai_drafts')
    .select('id, meeting_id, output_json, applied_at, discarded_at')
    .eq('id', draftId)
    .eq('meeting_id', meetingId)
    .single()

  if (!draft) return { error: 'Draft not found.' }
  if (draft.applied_at)   return { error: 'This draft has already been applied.' }
  if (draft.discarded_at) return { error: 'This draft has been discarded and cannot be applied.' }

  // ── Validate output_json at runtime ────────────────────────────────────────
  const parsed = MeetingDraftOutputSchema.safeParse(draft.output_json)
  if (!parsed.success) return { error: 'Draft output is malformed.' }
  const output = parsed.data

  // ── Fetch meeting ──────────────────────────────────────────────────────────
  const { data: meeting } = await db
    .from('meetings')
    .select('id, status, owner_user_id, scheduled_start')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found.' }

  // ── Permission check ───────────────────────────────────────────────────────
  if (!canManageTranscript(user.role, meeting.owner_user_id, user.id, meeting.status)) {
    return { error: 'You do not have permission to apply this draft.' }
  }

  const APPLY_ALLOWED_STATUSES = new Set(['scheduled', 'open', 'draft'])
  if (!APPLY_ALLOWED_STATUSES.has(meeting.status)) {
    return { error: `Cannot apply a draft to a ${meeting.status} meeting.` }
  }

  // ── Fetch active users for owner name resolution ───────────────────────────
  const { data: usersData } = await db
    .from('app_users')
    .select('id, display_name')
    .eq('active', true)

  const users: Array<{ id: string; display_name: string }> = usersData ?? []

  function resolveOwner(displayName: string | null): string | null {
    if (!displayName) return null
    const q = displayName.trim().toLowerCase()
    return users.find(u => u.display_name.trim().toLowerCase() === q)?.id ?? null
  }

  // ── Priority hint → numeric priority (1=Critical 2=Normal 3=Low 4=Background) ──
  function mapPriority(hint: 'high' | 'normal' | 'low' | null): number {
    if (hint === 'high') return 1
    if (hint === 'low')  return 3
    return 2
  }

  // ── Reference date for deadline parsing ────────────────────────────────────
  const refDate = meeting.scheduled_start ? new Date(meeting.scheduled_start) : null

  // ── Build outcomes array ──────────────────────────────────────────────────
  type OutcomeRow = {
    kind:         string
    title:        string
    payload_json: Record<string, unknown>
    sort_order:   number
  }
  const outcomes: OutcomeRow[] = []

  output.tasks.forEach((task, i) => {
    outcomes.push({
      kind:  'task',
      title: task.title,
      payload_json: {
        owner_user_id: resolveOwner(task.owner_display_name),
        priority:      mapPriority(task.priority_hint),
        due_at:        parseDeadlineFromEvidence(task.deadline_evidence, refDate),
      },
      sort_order: i,
    })
  })

  output.decisions.forEach((dec, i) => {
    outcomes.push({
      kind:  'decision',
      title: dec.title,
      payload_json: {
        decision_text: dec.decision_text,
        rationale:     dec.rationale ?? null,
        owner_user_id: null,
      },
      sort_order: output.tasks.length + i,
    })
  })

  output.waiting_ons.forEach((wo, i) => {
    outcomes.push({
      kind:  'waiting_on',
      title: wo.title,
      payload_json: {
        owner_user_id:       resolveOwner(wo.owner_display_name),
        waiting_for_name:    wo.waiting_for ?? null,
        waiting_for_user_id: null,
        due_at:              parseDeadlineFromEvidence(wo.deadline_evidence, refDate),
        notes:               wo.notes ?? null,
      },
      sort_order: output.tasks.length + output.decisions.length + i,
    })
  })

  // ── Determine working_notes to pass (null = don't overwrite) ───────────────
  const workingNotes = options.applyWorkingNotes ? (output.minutes || '') : null

  // ── Atomic RPC ────────────────────────────────────────────────────────────
  const { error: rpcError } = await db.rpc('apply_meeting_ai_draft_and_audit', {
    p_draft_id:      draftId,
    p_meeting_id:    meetingId,
    p_actor_user_id: user.id,
    p_working_notes: workingNotes,
    p_outcomes:      outcomes,
  })

  if (rpcError) {
    console.error('[ai-drafts] apply_meeting_ai_draft_and_audit failed:', rpcError.message)
    return { error: 'Failed to apply the draft. Please try again.' }
  }

  revalidatePath(`/meetings/${meetingId}`)

  return { data: { outcomesCreated: outcomes.length } }
}
