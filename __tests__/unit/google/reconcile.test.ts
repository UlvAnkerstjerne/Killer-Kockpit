/**
 * Tests for lib/google/reconcile.ts
 *
 * Scenarios covered:
 *   attemptAutoTranscript:
 *     - Returns 'not_ready' when transcript is still processing
 *     - Returns 'attached' + creates new source when transcript is available
 *     - Returns 'attached' + skips insert when source already exists (idempotency)
 *   runMeetingReconcileJob:
 *     - Pass A: lifecycle ended + immediate transcript → resolved=1, transcripts=1
 *     - Pass A: lifecycle ended, transcript still processing → resolved=1, transcripts=0
 *     - Pass B: transcript attaches on retry cycle → resolved=0, transcripts=1
 *     - No conference started → meeting unchanged (no RPC, no transcript)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const reconcileMocks = vi.hoisted(() => {
  const mockGetOAuth2Client     = vi.fn()
  const mockHasMeetScope        = vi.fn()
  const mockCheckLifecycle      = vi.fn()
  const mockFetchTranscript     = vi.fn()
  const mockCreateServiceClient = vi.fn()

  return {
    mockGetOAuth2Client,
    mockHasMeetScope,
    mockCheckLifecycle,
    mockFetchTranscript,
    mockCreateServiceClient,
  }
})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: reconcileMocks.mockCreateServiceClient,
}))

vi.mock('@/lib/google/auth', () => ({
  getGoogleOAuth2Client:         reconcileMocks.mockGetOAuth2Client,
  getManagementCalendarClient:   reconcileMocks.mockGetOAuth2Client,  // system writer = same mock
  hasMeetScope:                  reconcileMocks.mockHasMeetScope,
}))

vi.mock('@/lib/google/meet', () => ({
  checkConferenceLifecycle: reconcileMocks.mockCheckLifecycle,
}))

vi.mock('@/lib/google/transcripts', () => ({
  fetchGoogleMeetTranscript: reconcileMocks.mockFetchTranscript,
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_OAUTH_CLIENT = {
  credentials: { scope: 'https://www.googleapis.com/auth/meetings.space.readonly' },
}

const SPACE_NAME      = 'spaces/TestSpaceId'
const RECORD_NAME     = 'conferenceRecords/rec-001'
const TRANSCRIPT_NAME = 'conferenceRecords/rec-001/transcripts/tr-001'
const ACTUAL_START    = '2026-09-19T09:00:00Z'
const ACTUAL_END      = '2026-09-19T10:00:00Z'

const UNRESOLVED_MEETING = {
  id:                           'mtg-0001',
  status:                       'scheduled',
  meet_space_name:              SPACE_NAME,
  scheduled_start:              '2026-09-19T09:00:00Z',
  scheduled_end:                '2026-09-19T10:00:00Z',
  calendar_synced_by_user_id:   'user-001',
  transcript_source_id:         null,
}

const RESOLVED_MEETING = {
  id:                         'mtg-0002',
  meet_space_name:            SPACE_NAME,
  scheduled_start:            '2026-09-19T09:00:00Z',
  scheduled_end:              '2026-09-19T10:00:00Z',
  calendar_synced_by_user_id: 'user-001',
}

const TRANSCRIPT_RESULT = {
  ok:                    true as const,
  transcriptResourceName: TRANSCRIPT_NAME,
  conferenceRecordStart: ACTUAL_START,
  content:               'Alice: Hello\nBob: Hi',
  metadata:              { format: 'google_meet', provider: 'google_meet' },
}

// ─── Chain helpers ────────────────────────────────────────────────────────────

/**
 * A thenable chain where every method returns itself.
 * Awaiting the chain resolves to { data, error }.
 * .maybeSingle() and .single() resolve to their own configured values.
 */
function makeChain(opts: {
  data?: unknown
  error?: unknown
  maybeSingleData?: unknown
  singleData?: unknown
  singleError?: unknown
} = {}) {
  const self: Record<string, unknown> = {
    select:     () => self,
    eq:         () => self,
    is:         () => self,
    not:        () => self,
    in:         () => self,
    or:         () => self,
    order:      () => self,
    limit:      () => self,
    gte:        () => self,
    update:     () => self,
    insert:     () => self,
    upsert:     () => self,
    maybeSingle: () => Promise.resolve({ data: opts.maybeSingleData ?? null, error: null }),
    single:     () => Promise.resolve({
      data:  opts.singleData  ?? null,
      error: opts.singleError ?? null,
    }),
    then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve(resolve({ data: opts.data ?? null, error: opts.error ?? null })),
  }
  return self
}

// ─── attemptAutoTranscript ────────────────────────────────────────────────────

describe('attemptAutoTranscript', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('returns not_ready when transcript is still processing', async () => {
    reconcileMocks.mockFetchTranscript.mockResolvedValue({ ok: false, status: 'processing' })

    const dbFrom = vi.fn()
    const db = { from: dbFrom } as never
    const { attemptAutoTranscript } = await import('@/lib/google/reconcile')
    const result = await attemptAutoTranscript(
      db, MOCK_OAUTH_CLIENT as never, 'mtg-001', SPACE_NAME, null, null,
    )

    expect(result).toBe('not_ready')
    expect(dbFrom).not.toHaveBeenCalled()
  })

  it('returns skipped when transcript fetch fails for non-processing reason', async () => {
    reconcileMocks.mockFetchTranscript.mockResolvedValue({ ok: false, status: 'error' })

    const db = { from: vi.fn() } as never
    const { attemptAutoTranscript } = await import('@/lib/google/reconcile')
    const result = await attemptAutoTranscript(
      db, MOCK_OAUTH_CLIENT as never, 'mtg-001', SPACE_NAME, null, null,
    )

    expect(result).toBe('skipped')
  })

  it('attaches new transcript source when external_id does not yet exist', async () => {
    reconcileMocks.mockFetchTranscript.mockResolvedValue(TRANSCRIPT_RESULT)

    const insertedId = 'src-new-001'
    const fromMock = vi.fn()
      .mockReturnValueOnce(makeChain({ maybeSingleData: null }))        // sources.maybeSingle → null
      .mockReturnValueOnce(makeChain({ singleData: { id: insertedId } }))  // sources.insert.single
      .mockReturnValueOnce(makeChain())                                   // entity_sources.insert
      .mockReturnValueOnce(makeChain())                                   // meetings.update
      .mockReturnValueOnce(makeChain())                                   // audit_events.insert

    const db = { from: fromMock } as never
    const { attemptAutoTranscript } = await import('@/lib/google/reconcile')
    const result = await attemptAutoTranscript(
      db, MOCK_OAUTH_CLIENT as never, 'mtg-001', SPACE_NAME,
      '2026-09-19T09:00:00Z', '2026-09-19T10:00:00Z',
    )

    expect(result).toBe('attached')
    // 5 from() calls: sources check, sources insert, entity_sources, meetings update, audit
    expect(fromMock).toHaveBeenCalledTimes(5)
    // Sources and entity_sources tables touched
    const tables = fromMock.mock.calls.map((c) => c[0])
    expect(tables).toContain('sources')
    expect(tables).toContain('entity_sources')
    expect(tables).toContain('meetings')
    expect(tables).toContain('audit_events')
  })

  it('skips source insert and only updates meeting pointer when source already exists (idempotency)', async () => {
    reconcileMocks.mockFetchTranscript.mockResolvedValue(TRANSCRIPT_RESULT)

    const existingSource = { id: 'src-existing-001' }
    const fromMock = vi.fn()
      .mockReturnValueOnce(makeChain({ maybeSingleData: existingSource })) // sources.maybySingle → existing
      .mockReturnValueOnce(makeChain())                                      // meetings.update pointer

    const db = { from: fromMock } as never
    const { attemptAutoTranscript } = await import('@/lib/google/reconcile')
    const result = await attemptAutoTranscript(
      db, MOCK_OAUTH_CLIENT as never, 'mtg-001', SPACE_NAME, null, null,
    )

    expect(result).toBe('attached')
    // Only 2 from() calls: sources check and meetings update (no insert)
    expect(fromMock).toHaveBeenCalledTimes(2)
    const tables = fromMock.mock.calls.map((c) => c[0])
    expect(tables).not.toContain('entity_sources')
    expect(tables).not.toContain('audit_events')
  })
})

// ─── runMeetingReconcileJob ───────────────────────────────────────────────────

describe('runMeetingReconcileJob', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    // Default: credentials present + meet scope
    reconcileMocks.mockGetOAuth2Client.mockResolvedValue(MOCK_OAUTH_CLIENT)
    reconcileMocks.mockHasMeetScope.mockReturnValue(true)
    // Default: RPC succeeds
  })

  it('Pass A: resolves lifecycle and attaches transcript immediately when both are ready', async () => {
    reconcileMocks.mockCheckLifecycle.mockResolvedValue({
      status:     'ended',
      recordName: RECORD_NAME,
      startTime:  ACTUAL_START,
      endTime:    ACTUAL_END,
    })
    reconcileMocks.mockFetchTranscript.mockResolvedValue(TRANSCRIPT_RESULT)

    const rpcMock = vi.fn().mockResolvedValue({ error: null })
    const fromMock = vi.fn()
      .mockReturnValueOnce(makeChain({ data: [UNRESOLVED_MEETING] }))   // Pass A query
      .mockReturnValueOnce(makeChain({ maybeSingleData: null }))         // sources check
      .mockReturnValueOnce(makeChain({ singleData: { id: 'src-001' } })) // sources insert
      .mockReturnValueOnce(makeChain())                                   // entity_sources
      .mockReturnValueOnce(makeChain())                                   // meetings update
      .mockReturnValueOnce(makeChain())                                   // audit_events
      .mockReturnValueOnce(makeChain({ data: [] }))                      // Pass B query (nothing pending)

    reconcileMocks.mockCreateServiceClient.mockReturnValue({ from: fromMock, rpc: rpcMock })

    const { runMeetingReconcileJob } = await import('@/lib/google/reconcile')
    const result = await runMeetingReconcileJob()

    expect(result.resolved).toBe(1)
    expect(result.transcripts).toBe(1)
    expect(result.errors).toBe(0)
    expect(rpcMock).toHaveBeenCalledWith('reconcile_meeting_from_meet', expect.objectContaining({
      p_meeting_id:             UNRESOLVED_MEETING.id,
      p_conference_record_name: RECORD_NAME,
      p_actual_end:             ACTUAL_END,
    }))
  })

  it('Pass A: resolves lifecycle but transcripts=0 when transcript is still processing', async () => {
    reconcileMocks.mockCheckLifecycle.mockResolvedValue({
      status:     'ended',
      recordName: RECORD_NAME,
      startTime:  ACTUAL_START,
      endTime:    ACTUAL_END,
    })
    reconcileMocks.mockFetchTranscript.mockResolvedValue({ ok: false, status: 'processing' })

    const rpcMock = vi.fn().mockResolvedValue({ error: null })
    const fromMock = vi.fn()
      .mockReturnValueOnce(makeChain({ data: [UNRESOLVED_MEETING] }))  // Pass A query
      .mockReturnValueOnce(makeChain({ data: [] }))                     // Pass B query

    reconcileMocks.mockCreateServiceClient.mockReturnValue({ from: fromMock, rpc: rpcMock })

    const { runMeetingReconcileJob } = await import('@/lib/google/reconcile')
    const result = await runMeetingReconcileJob()

    expect(result.resolved).toBe(1)
    expect(result.transcripts).toBe(0)
    expect(result.errors).toBe(0)
  })

  it('Pass B: attaches transcript on a subsequent cycle after lifecycle was already resolved', async () => {
    reconcileMocks.mockFetchTranscript.mockResolvedValue(TRANSCRIPT_RESULT)

    const rpcMock = vi.fn()
    const fromMock = vi.fn()
      .mockReturnValueOnce(makeChain({ data: [] }))                       // Pass A: nothing unresolved
      .mockReturnValueOnce(makeChain({ data: [RESOLVED_MEETING] }))       // Pass B: 1 meeting pending transcript
      .mockReturnValueOnce(makeChain({ maybeSingleData: null }))           // sources check
      .mockReturnValueOnce(makeChain({ singleData: { id: 'src-002' } }))  // sources insert
      .mockReturnValueOnce(makeChain())                                    // entity_sources
      .mockReturnValueOnce(makeChain())                                    // meetings update
      .mockReturnValueOnce(makeChain())                                    // audit_events

    reconcileMocks.mockCreateServiceClient.mockReturnValue({ from: fromMock, rpc: rpcMock })

    const { runMeetingReconcileJob } = await import('@/lib/google/reconcile')
    const result = await runMeetingReconcileJob()

    expect(result.resolved).toBe(0)
    expect(result.transcripts).toBe(1)
    // No lifecycle check ran (Pass B skips it)
    expect(reconcileMocks.mockCheckLifecycle).not.toHaveBeenCalled()
    // No RPC ran (lifecycle already resolved)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('Pass B: does not create duplicate source when external_id already exists', async () => {
    reconcileMocks.mockFetchTranscript.mockResolvedValue(TRANSCRIPT_RESULT)

    const existingSource = { id: 'src-existing-002' }
    const rpcMock = vi.fn()
    const fromMock = vi.fn()
      .mockReturnValueOnce(makeChain({ data: [] }))                      // Pass A: nothing
      .mockReturnValueOnce(makeChain({ data: [RESOLVED_MEETING] }))      // Pass B: 1 meeting
      .mockReturnValueOnce(makeChain({ maybeSingleData: existingSource })) // sources check → existing
      .mockReturnValueOnce(makeChain())                                   // meetings update pointer

    reconcileMocks.mockCreateServiceClient.mockReturnValue({ from: fromMock, rpc: rpcMock })

    const { runMeetingReconcileJob } = await import('@/lib/google/reconcile')
    const result = await runMeetingReconcileJob()

    expect(result.transcripts).toBe(1)
    // No insert into sources or entity_sources
    const tables = fromMock.mock.calls.map((c) => c[0])
    expect(tables).not.toContain('entity_sources')
    expect(tables).not.toContain('audit_events')
  })

  it('no conference started → meeting unchanged (no RPC, no transcript attempt)', async () => {
    reconcileMocks.mockCheckLifecycle.mockResolvedValue({ status: 'not_started' })

    const rpcMock = vi.fn()
    const fromMock = vi.fn()
      .mockReturnValueOnce(makeChain({ data: [UNRESOLVED_MEETING] }))  // Pass A
      .mockReturnValueOnce(makeChain({ data: [] }))                     // Pass B

    reconcileMocks.mockCreateServiceClient.mockReturnValue({ from: fromMock, rpc: rpcMock })

    const { runMeetingReconcileJob } = await import('@/lib/google/reconcile')
    const result = await runMeetingReconcileJob()

    expect(result.checked).toBe(1)
    expect(result.resolved).toBe(0)
    expect(result.transcripts).toBe(0)
    expect(rpcMock).not.toHaveBeenCalled()
    expect(reconcileMocks.mockFetchTranscript).not.toHaveBeenCalled()
  })

  it('skips meeting when credentials are missing — counts as skipped not error', async () => {
    reconcileMocks.mockGetOAuth2Client.mockResolvedValue(null)

    const rpcMock = vi.fn()
    const fromMock = vi.fn()
      .mockReturnValueOnce(makeChain({ data: [UNRESOLVED_MEETING] }))
      .mockReturnValueOnce(makeChain({ data: [] }))

    reconcileMocks.mockCreateServiceClient.mockReturnValue({ from: fromMock, rpc: rpcMock })

    const { runMeetingReconcileJob } = await import('@/lib/google/reconcile')
    const result = await runMeetingReconcileJob()

    expect(result.skipped).toBe(1)
    expect(result.resolved).toBe(0)
    expect(reconcileMocks.mockCheckLifecycle).not.toHaveBeenCalled()
  })
})
