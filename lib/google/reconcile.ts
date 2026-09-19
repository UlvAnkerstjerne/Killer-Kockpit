/**
 * lib/google/reconcile.ts
 *
 * Automated meeting lifecycle reconciliation via Google Meet conference records.
 *
 * Called by the POST /api/meetings/reconcile cron route (Railway, every 15 min).
 * Not a server action — no user session required.
 *
 * Two independent passes per run:
 *
 * Pass A — lifecycle resolution:
 *   Finds unresolved meetings (scheduled/open) with a meet_space_name that are
 *   recent. For each, checks if the conference has ended. If so, calls
 *   reconcile_meeting_from_meet RPC → transitions to draft with actual times.
 *   Then immediately attempts transcript retrieval (transcript may already be ready).
 *
 * Pass B — transcript retry:
 *   Finds already-resolved meetings that still have no transcript, where
 *   actual_end is within TRANSCRIPT_RETRY_WINDOW_MS. Attempts transcript
 *   retrieval again. Transcripts can take 5–60 min to process after meeting end.
 *
 * Idempotency:
 *   - meet_lifecycle_resolved = true prevents double lifecycle transitions.
 *   - sources.external_id prevents duplicate transcript sources.
 *   - actual_end window stops retrying stale meetings eventually.
 *
 * Credential routing: uses calendar_synced_by_user_id's stored OAuth tokens.
 * Meetings where that credential is missing or lacks meetings.space.readonly
 * are skipped (Pass A) or skipped (Pass B) until a user re-syncs.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { getGoogleOAuth2Client, hasMeetScope } from '@/lib/google/auth'
import { checkConferenceLifecycle } from '@/lib/google/meet'
import { fetchGoogleMeetTranscript } from '@/lib/google/transcripts'
import type { Auth } from 'googleapis'

export interface ReconcileJobResult {
  checked:     number
  resolved:    number
  transcripts: number
  errors:      number
  skipped:     number
}

// Look-back window for Pass A: meetings scheduled in the past 7 days
const LIFECYCLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// Retry window for Pass B: attempt transcript for up to 24 hours after actual_end.
// Meet transcripts are typically ready within 30 min but can remain in ENDED state
// while file generation is still in progress. 24h covers extended processing delays
// and temporary Google API outages without permanently missing a transcript.
const TRANSCRIPT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000

export async function runMeetingReconcileJob(): Promise<ReconcileJobResult> {
  const serviceClient = createServiceClient()
  const result: ReconcileJobResult = {
    checked: 0, resolved: 0, transcripts: 0, errors: 0, skipped: 0,
  }

  const lifecycleWindowStart       = new Date(Date.now() - LIFECYCLE_WINDOW_MS).toISOString()
  const transcriptRetryWindowStart = new Date(Date.now() - TRANSCRIPT_RETRY_WINDOW_MS).toISOString()

  // ── Pass A: meetings that still need lifecycle resolution ──────────────────
  const { data: unresolvedMeetings, error: queryAError } = await serviceClient
    .from('meetings')
    .select('id, status, meet_space_name, scheduled_start, scheduled_end, calendar_synced_by_user_id, transcript_source_id')
    .in('status', ['scheduled', 'open'])
    .eq('meet_lifecycle_resolved', false)
    .not('meet_space_name', 'is', null)
    .or(`scheduled_start.gte.${lifecycleWindowStart},scheduled_start.is.null`)
    .order('scheduled_start', { ascending: true, nullsFirst: false })
    .limit(50)

  if (queryAError) {
    console.error('[reconcile] Pass A query failed:', queryAError.message)
  }

  for (const meeting of (unresolvedMeetings ?? [])) {
    result.checked++

    const oauthClient = await getCredentialWithMeetScope(meeting.calendar_synced_by_user_id as string | null)
    if (!oauthClient) { result.skipped++; continue }

    const lifecycle = await checkConferenceLifecycle(oauthClient, meeting.meet_space_name as string)

    if (lifecycle.status === 'error') { result.errors++; continue }
    if (lifecycle.status !== 'ended') continue

    const { error: rpcError } = await serviceClient.rpc('reconcile_meeting_from_meet', {
      p_meeting_id:             meeting.id,
      p_conference_record_name: lifecycle.recordName,
      p_actual_start:           lifecycle.startTime ?? lifecycle.endTime,
      p_actual_end:             lifecycle.endTime,
    })

    if (rpcError) {
      console.error('[reconcile] reconcile_meeting_from_meet failed for', meeting.id, ':', rpcError.message)
      result.errors++
      continue
    }

    result.resolved++
    console.log('[reconcile] Resolved meeting', meeting.id, '→ draft')

    // Attempt transcript immediately — may already be available
    if (!meeting.transcript_source_id) {
      const ts = await attemptAutoTranscript(
        serviceClient, oauthClient, meeting.id,
        meeting.meet_space_name as string,
        meeting.scheduled_start as string | null,
        meeting.scheduled_end   as string | null,
      )
      if (ts === 'attached') {
        result.transcripts++
        console.log('[reconcile] Transcript attached (immediate) for meeting', meeting.id)
      }
    }
  }

  // ── Pass B: resolved meetings still awaiting transcript ───────────────────
  // Runs independently so that transcripts which weren't ready immediately
  // (processing state at conference end) are collected on a later cycle.
  const { data: pendingTranscripts, error: queryBError } = await serviceClient
    .from('meetings')
    .select('id, meet_space_name, scheduled_start, scheduled_end, calendar_synced_by_user_id')
    .eq('meet_lifecycle_resolved', true)
    .not('conference_record_name', 'is', null)
    .is('transcript_source_id', null)
    .gte('actual_end', transcriptRetryWindowStart)
    .order('actual_end', { ascending: false })
    .limit(50)

  if (queryBError) {
    console.error('[reconcile] Pass B query failed:', queryBError.message)
  }

  for (const meeting of (pendingTranscripts ?? [])) {
    result.checked++

    const oauthClient = await getCredentialWithMeetScope(meeting.calendar_synced_by_user_id as string | null)
    if (!oauthClient) { result.skipped++; continue }

    const ts = await attemptAutoTranscript(
      serviceClient, oauthClient, meeting.id,
      meeting.meet_space_name as string,
      meeting.scheduled_start as string | null,
      meeting.scheduled_end   as string | null,
    )
    if (ts === 'attached') {
      result.transcripts++
      console.log('[reconcile] Transcript attached (retry) for meeting', meeting.id)
    }
  }

  return result
}

// ─── Credential helper ────────────────────────────────────────────────────────

async function getCredentialWithMeetScope(
  credUserId: string | null,
): Promise<Auth.OAuth2Client | null> {
  if (!credUserId) return null
  const client = await getGoogleOAuth2Client(credUserId)
  if (!client) return null
  const scopeString = typeof client.credentials.scope === 'string' ? client.credentials.scope : ''
  if (!hasMeetScope(scopeString.split(' ').filter(Boolean))) return null
  return client
}

// ─── Transcript storage ───────────────────────────────────────────────────────

type ServiceClient = ReturnType<typeof createServiceClient>

export async function attemptAutoTranscript(
  db:             ServiceClient,
  oauthClient:    Auth.OAuth2Client,
  meetingId:      string,
  meetSpaceName:  string,
  scheduledStart: string | null,
  scheduledEnd:   string | null,
): Promise<'attached' | 'not_ready' | 'skipped'> {
  const fetchResult = await fetchGoogleMeetTranscript(oauthClient, meetSpaceName, {
    scheduled_start: scheduledStart,
    scheduled_end:   scheduledEnd,
  })

  if (!fetchResult.ok) {
    if (fetchResult.status === 'processing') return 'not_ready'
    return 'skipped'
  }

  const { transcriptResourceName, conferenceRecordStart, content, metadata } = fetchResult

  // Idempotency: skip if the exact Google transcript source already exists
  const { data: existing } = await db
    .from('sources')
    .select('id')
    .eq('source_type', 'meeting_transcript')
    .eq('external_id', transcriptResourceName)
    .maybeSingle()

  if (existing) {
    // Source already stored — ensure the meeting pointer is set
    await db
      .from('meetings')
      .update({ transcript_source_id: existing.id })
      .eq('id', meetingId)
      .is('transcript_source_id', null)
    return 'attached'
  }

  const byteSize  = Buffer.byteLength(content, 'utf8')
  const charCount = content.length

  const { data: newSource, error: insertErr } = await db
    .from('sources')
    .insert({
      source_type:            'meeting_transcript',
      source_account_user_id: null,
      external_id:            transcriptResourceName,
      title:                  'Google Meet transcript',
      file_name:              null,
      url:                    null,
      occurred_at:            conferenceRecordStart ?? new Date().toISOString(),
      content,
      metadata: {
        format:       'google_meet',
        provider:     'google_meet',
        byte_size:    byteSize,
        char_count:   charCount,
        ...(metadata as unknown as Record<string, unknown>),
      },
    })
    .select('id')
    .single()

  if (insertErr || !newSource) {
    console.error('[reconcile] Failed to insert transcript source:', insertErr?.message)
    return 'skipped'
  }

  await db.from('entity_sources').insert({
    entity_type: 'meeting',
    entity_id:   meetingId,
    source_id:   newSource.id,
    relation:    'transcript',
  })

  await db
    .from('meetings')
    .update({ transcript_source_id: newSource.id })
    .eq('id', meetingId)

  await db.from('audit_events').insert({
    actor_user_id: null,
    actor_type:    'system',
    action:        'transcript_attached',
    entity_type:   'meeting',
    entity_id:     meetingId,
    after_json: {
      source_id:   newSource.id,
      provider:    'google_meet',
      external_id: transcriptResourceName,
      meet_space:  meetSpaceName,
    },
  })

  return 'attached'
}
