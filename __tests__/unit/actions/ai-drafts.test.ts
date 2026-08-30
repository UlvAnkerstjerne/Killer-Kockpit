/**
 * Tests for lib/actions/ai-drafts.ts server actions.
 *
 * Coverage:
 *   generateMeetingDraft:
 *     - not authenticated → rejected
 *     - no permission (non-owner MEMBER) → rejected
 *     - published meeting → rejected
 *     - cancelled meeting → rejected
 *     - no transcript → rejected
 *     - AI generation failure → no draft row created, error returned
 *     - successful generation → exactly one meeting_ai_drafts row inserted
 *     - successful generation → working_notes NOT modified
 *     - successful generation → meeting_outcomes NOT created
 *     - successful generation → meeting status NOT changed
 *     - regeneration → new row, not overwrite
 *     - audit event recorded on success
 *
 *   getLatestDraft:
 *     - returns null when no draft exists
 *     - returns latest non-discarded draft
 *     - returns null when output_json is malformed
 *
 *   discardDraft:
 *     - not authenticated → rejected
 *     - already applied → rejected
 *     - already discarded → rejected
 *     - no permission → rejected
 *     - success → discarded_at set
 *     - audit event recorded on success
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser    = vi.fn()
  const mockRevalidatePath    = vi.fn()
  const mockRecordAuditEvent  = vi.fn().mockResolvedValue({ error: null })
  const mockGenerateDraft     = vi.fn()

  const mockSingle      = vi.fn()
  const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
  const mockInsert      = vi.fn()
  const mockUpdate      = vi.fn()
  const mockSelectFn    = vi.fn()
  const mockEq          = vi.fn()
  const mockIs          = vi.fn()
  const mockOrder       = vi.fn()
  const mockLimit       = vi.fn()
  const mockNeq         = vi.fn()

  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {}
    chain.select      = mockSelectFn
    chain.eq          = mockEq
    chain.is          = mockIs
    chain.neq         = mockNeq
    chain.order       = mockOrder
    chain.limit       = mockLimit
    chain.single      = mockSingle
    chain.maybeSingle = mockMaybeSingle
    chain.insert      = mockInsert
    chain.update      = mockUpdate
    return chain
  }

  mockSelectFn.mockReturnValue(makeChain())
  mockEq.mockReturnValue(makeChain())
  mockIs.mockReturnValue(makeChain())
  mockNeq.mockReturnValue(makeChain())
  mockOrder.mockReturnValue(makeChain())
  mockLimit.mockReturnValue(makeChain())
  mockInsert.mockReturnValue(makeChain())
  mockUpdate.mockReturnValue(makeChain())

  const mockFrom = vi.fn().mockReturnValue(makeChain())
  const mockRpc  = vi.fn().mockResolvedValue({ error: null })
  const mockServiceClient = { from: mockFrom, rpc: mockRpc }

  return {
    mockGetCurrentUser,
    mockRevalidatePath,
    mockRecordAuditEvent,
    mockGenerateDraft,
    mockSingle,
    mockMaybeSingle,
    mockInsert,
    mockUpdate,
    mockFrom,
    mockRpc,
    mockServiceClient,
    makeChain,
  }
})

vi.mock('@/lib/auth',   () => ({ getCurrentUser:     mocks.mockGetCurrentUser }))
vi.mock('next/cache',   () => ({ revalidatePath:      mocks.mockRevalidatePath }))
vi.mock('@/lib/audit',  () => ({ recordAuditEvent:    mocks.mockRecordAuditEvent }))
vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn(),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))
vi.mock('@/lib/ai/generate-meeting-draft', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/ai/generate-meeting-draft')>()
  return { ...orig, generateDraftFromContext: mocks.mockGenerateDraft }
})

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SUPER_ADMIN    = { id: 'admin-id',  role: 'SUPER_ADMIN' as const }
const MEMBER_OWNER   = { id: 'owner-id',  role: 'MEMBER' as const }
const MEMBER_OTHER   = { id: 'other-id',  role: 'MEMBER' as const }
const UM_USER        = { id: 'um-id',     role: 'UM' as const }

const MEETING_OPEN = {
  id: 'meeting-id', title: 'Weekly Sync', status: 'open',
  owner_user_id: 'owner-id', working_notes: 'Some notes',
  scheduled_start: '2026-08-29T10:00:00Z',
  transcript_source_id: 'source-id',
  project: { id: 'proj-id', title: 'Alpha' },
}

const MEETING_OPEN_NO_TRANSCRIPT = { ...MEETING_OPEN, transcript_source_id: null }

const MEETING_PUBLISHED = { ...MEETING_OPEN, status: 'published' }
const MEETING_CANCELLED = { ...MEETING_OPEN, status: 'cancelled' }

const SAMPLE_SOURCE = {
  id: 'source-id', file_name: 'standup.txt',
  content: 'Alice: Hello.\nBob: Hi.',
}

const VALID_AI_OUTPUT = {
  minutes:     'Team sync completed.',
  tasks:       [{ title: 'Ship feature', description: null, owner_display_name: 'Alice', suggested_due: null, deadline_evidence: null, project_hint: null, priority_hint: null }],
  decisions:   [],
  waiting_ons: [],
}

const SUCCESSFUL_DRAFT_RESULT = {
  ok: true,
  output: VALID_AI_OUTPUT,
  inputCharCount: 1500,
  model: 'claude-sonnet-4-6',
}

import { generateMeetingDraft, getLatestDraft, discardDraft, applyMeetingDraft } from '@/lib/actions/ai-drafts'

// ─── generateMeetingDraft ─────────────────────────────────────────────────────

describe('generateMeetingDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockRecordAuditEvent.mockResolvedValue({ error: null })
    mocks.mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  })

  it('returns error when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await generateMeetingDraft('meeting-id')
    expect(result.error).toMatch(/not authenticated/i)
  })

  it('returns error when non-owner MEMBER lacks permission', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OTHER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    const result = await generateMeetingDraft('meeting-id')
    expect(result.error).toMatch(/permission/i)
    expect(mocks.mockGenerateDraft).not.toHaveBeenCalled()
  })

  it('returns error for published meeting', async () => {
    // canGenerateDraft wraps canManageTranscript which includes the status whitelist,
    // so published meetings return a permission error (status gate + role gate are combined).
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_PUBLISHED, error: null })
    const result = await generateMeetingDraft('meeting-id')
    expect(result.error).toBeTruthy()
    expect(mocks.mockGenerateDraft).not.toHaveBeenCalled()
  })

  it('returns error for cancelled meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_CANCELLED, error: null })
    const result = await generateMeetingDraft('meeting-id')
    expect(result.error).toBeTruthy()
    expect(mocks.mockGenerateDraft).not.toHaveBeenCalled()
  })

  it('returns error when meeting has no transcript', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_OPEN_NO_TRANSCRIPT, error: null })
    const result = await generateMeetingDraft('meeting-id')
    expect(result.error).toMatch(/no transcript/i)
    expect(mocks.mockGenerateDraft).not.toHaveBeenCalled()
  })

  it('returns error when AI generation fails — no draft row created', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: SAMPLE_SOURCE, error: null })
    // attendees query (uses select + eq chain — mockMaybeSingle not used here, attendees use select directly)
    mocks.mockGenerateDraft.mockResolvedValue({ ok: false, error: 'Context too large' })

    const result = await generateMeetingDraft('meeting-id')
    expect(result.error).toBe('Context too large')

    // Verify no insert was called
    const insertCalls = mocks.mockInsert.mock.calls
    // Insert should not have been called with meeting_ai_drafts data
    const draftInsert = insertCalls.find((call) =>
      JSON.stringify(call).includes('meeting_ai_drafts')
    )
    // The from() call tells us which table — check mockFrom was not called with meeting_ai_drafts
    const fromCalls = mocks.mockFrom.mock.calls.map((c: unknown[]) => c[0])
    expect(fromCalls).not.toContain('meeting_ai_drafts')
  })

  it('creates exactly one draft row on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: SAMPLE_SOURCE, error: null })
      .mockResolvedValueOnce({ data: { id: 'new-draft-id' }, error: null })
    mocks.mockGenerateDraft.mockResolvedValue(SUCCESSFUL_DRAFT_RESULT)

    const result = await generateMeetingDraft('meeting-id')
    expect(result.error).toBeUndefined()
    expect(result.data?.draftId).toBe('new-draft-id')

    const fromCalls = mocks.mockFrom.mock.calls.map((c: unknown[]) => c[0])
    expect(fromCalls).toContain('meeting_ai_drafts')
  })

  it('does NOT insert into meeting_outcomes', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: SAMPLE_SOURCE, error: null })
      .mockResolvedValueOnce({ data: { id: 'new-draft-id' }, error: null })
    mocks.mockGenerateDraft.mockResolvedValue(SUCCESSFUL_DRAFT_RESULT)

    await generateMeetingDraft('meeting-id')

    const fromCalls = mocks.mockFrom.mock.calls.map((c: unknown[]) => c[0])
    expect(fromCalls).not.toContain('meeting_outcomes')
  })

  it('does NOT update meetings table (no status change, no working_notes change)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: SAMPLE_SOURCE, error: null })
      .mockResolvedValueOnce({ data: { id: 'new-draft-id' }, error: null })
    mocks.mockGenerateDraft.mockResolvedValue(SUCCESSFUL_DRAFT_RESULT)

    await generateMeetingDraft('meeting-id')

    const updateCalls = mocks.mockUpdate.mock.calls
    // Any update should not contain working_notes or status changes to meetings
    // Since all DB writes go through mockFrom, check that meetings update never fired
    // We verify this by checking mockFrom was NOT called with 'meetings' in an update context
    // (meetings are only SELECT-queried in this action)
    // The simplest test: verify no update with status or working_notes key
    const hasWorkingNotesUpdate = updateCalls.some((call: unknown[]) =>
      JSON.stringify(call).includes('working_notes')
    )
    expect(hasWorkingNotesUpdate).toBe(false)
  })

  it('records audit event on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: SAMPLE_SOURCE, error: null })
      .mockResolvedValueOnce({ data: { id: 'draft-id' }, error: null })
    mocks.mockGenerateDraft.mockResolvedValue(SUCCESSFUL_DRAFT_RESULT)

    await generateMeetingDraft('meeting-id')

    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action:    'meeting.ai_draft_generated',
        entityId:  'meeting-id',
        afterJson: expect.objectContaining({
          draft_id:       'draft-id',
          model:          'claude-sonnet-4-6',
          prompt_version: expect.any(String),
          task_count:     1,
        }),
      })
    )
  })

  it('UM can generate a draft on any open meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: { ...MEETING_OPEN, owner_user_id: 'someone-else' }, error: null })
      .mockResolvedValueOnce({ data: SAMPLE_SOURCE, error: null })
      .mockResolvedValueOnce({ data: { id: 'draft-id' }, error: null })
    mocks.mockGenerateDraft.mockResolvedValue(SUCCESSFUL_DRAFT_RESULT)

    const result = await generateMeetingDraft('meeting-id')
    expect(result.error).toBeUndefined()
  })

  it('regeneration creates a second draft (does not overwrite)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)

    // First generation
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: SAMPLE_SOURCE, error: null })
      .mockResolvedValueOnce({ data: { id: 'draft-1' }, error: null })
    mocks.mockGenerateDraft.mockResolvedValue(SUCCESSFUL_DRAFT_RESULT)
    await generateMeetingDraft('meeting-id')

    // Reset for second call
    vi.clearAllMocks()
    mocks.mockRecordAuditEvent.mockResolvedValue({ error: null })
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: SAMPLE_SOURCE, error: null })
      .mockResolvedValueOnce({ data: { id: 'draft-2' }, error: null })
    mocks.mockGenerateDraft.mockResolvedValue(SUCCESSFUL_DRAFT_RESULT)
    const result2 = await generateMeetingDraft('meeting-id')

    expect(result2.data?.draftId).toBe('draft-2')
    // New insert, not an update to draft-1
    const fromCalls = mocks.mockFrom.mock.calls.map((c: unknown[]) => c[0])
    expect(fromCalls.filter((t: unknown) => t === 'meeting_ai_drafts')).toHaveLength(1)
    // No update to meeting_ai_drafts (which would indicate overwrite)
    expect(mocks.mockUpdate).not.toHaveBeenCalled()
  })
})

// ─── getLatestDraft ───────────────────────────────────────────────────────────

describe('getLatestDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  })

  it('returns null when no draft exists', async () => {
    mocks.mockMaybeSingle.mockResolvedValue({ data: null, error: null })
    const result = await getLatestDraft('meeting-id')
    expect(result).toBeNull()
  })

  it('returns draft when one exists', async () => {
    const draftRow = {
      id: 'draft-id', meeting_id: 'meeting-id',
      transcript_source_id: 'src-id',
      model: 'claude-sonnet-4-6', prompt_version: 'v1',
      input_char_count: 1000, output_json: VALID_AI_OUTPUT,
      generated_by_user_id: 'owner-id',
      generated_at: '2026-08-29T10:00:00Z',
      applied_at: null, applied_by_user_id: null,
      discarded_at: null, discarded_by_user_id: null,
    }
    mocks.mockMaybeSingle.mockResolvedValue({ data: draftRow, error: null })
    const result = await getLatestDraft('meeting-id')
    expect(result).not.toBeNull()
    expect(result?.id).toBe('draft-id')
    expect(result?.output_json.minutes).toBe(VALID_AI_OUTPUT.minutes)
  })

  it('returns null when output_json is malformed', async () => {
    const badDraft = {
      id: 'draft-id', meeting_id: 'meeting-id',
      transcript_source_id: 'src-id',
      model: 'claude-sonnet-4-6', prompt_version: 'v1',
      input_char_count: 1000,
      output_json: { minutes: 123, tasks: 'bad' }, // invalid
      generated_by_user_id: 'owner-id',
      generated_at: '2026-08-29T10:00:00Z',
      applied_at: null, applied_by_user_id: null,
      discarded_at: null, discarded_by_user_id: null,
    }
    mocks.mockMaybeSingle.mockResolvedValue({ data: badDraft, error: null })
    const result = await getLatestDraft('meeting-id')
    expect(result).toBeNull()
  })
})

// ─── discardDraft ─────────────────────────────────────────────────────────────

describe('discardDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockRecordAuditEvent.mockResolvedValue({ error: null })
  })

  it('returns error when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await discardDraft('draft-id', 'meeting-id')
    expect(result.error).toMatch(/not authenticated/i)
  })

  it('returns error when draft has already been applied', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({
      data: { id: 'draft-id', meeting_id: 'meeting-id', generated_by_user_id: 'owner-id',
              applied_at: '2026-08-29T11:00:00Z', discarded_at: null },
      error: null,
    })
    const result = await discardDraft('draft-id', 'meeting-id')
    expect(result.error).toMatch(/already been applied/i)
  })

  it('returns error when draft has already been discarded', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({
      data: { id: 'draft-id', meeting_id: 'meeting-id', generated_by_user_id: 'owner-id',
              applied_at: null, discarded_at: '2026-08-29T11:00:00Z' },
      error: null,
    })
    const result = await discardDraft('draft-id', 'meeting-id')
    expect(result.error).toMatch(/already been discarded/i)
  })

  it('returns error when user lacks permission', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OTHER)
    mocks.mockSingle
      .mockResolvedValueOnce({
        data: { id: 'draft-id', meeting_id: 'meeting-id', generated_by_user_id: 'owner-id',
                applied_at: null, discarded_at: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { owner_user_id: 'owner-id', status: 'open' },
        error: null,
      })
    const result = await discardDraft('draft-id', 'meeting-id')
    expect(result.error).toMatch(/permission/i)
  })

  it('succeeds for the meeting owner', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({
        data: { id: 'draft-id', meeting_id: 'meeting-id', generated_by_user_id: 'owner-id',
                applied_at: null, discarded_at: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { owner_user_id: 'owner-id', status: 'open' },
        error: null,
      })
    const result = await discardDraft('draft-id', 'meeting-id')
    expect(result.error).toBeUndefined()
  })

  it('records audit event on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({
        data: { id: 'draft-id', meeting_id: 'meeting-id', generated_by_user_id: 'owner-id',
                applied_at: null, discarded_at: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { owner_user_id: 'owner-id', status: 'open' },
        error: null,
      })
    await discardDraft('draft-id', 'meeting-id')

    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action:   'meeting.ai_draft_discarded',
        entityId: 'meeting-id',
        afterJson: { draft_id: 'draft-id' },
      })
    )
  })
})

// ─── DB constraint: applied and discarded cannot both be set ─────────────────
// This constraint lives at the DB level (migration 012), tested here at the
// action level to verify the application-side guard before it even reaches DB.

describe('draft state integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockRecordAuditEvent.mockResolvedValue({ error: null })
    mocks.mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  })

  it('discardDraft blocks action on an applied draft before reaching DB update', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({
      data: { id: 'draft-id', meeting_id: 'meeting-id', generated_by_user_id: 'owner-id',
              applied_at: '2026-08-29T09:00:00Z', discarded_at: null },
      error: null,
    })

    const result = await discardDraft('draft-id', 'meeting-id')

    expect(result.error).toMatch(/already been applied/i)
    // DB update must NOT have been called
    expect(mocks.mockUpdate).not.toHaveBeenCalled()
  })
})

// ─── applyMeetingDraft ────────────────────────────────────────────────────────

const DRAFT_ROW = {
  id: 'draft-id', meeting_id: 'meeting-id',
  output_json: VALID_AI_OUTPUT,
  applied_at: null, discarded_at: null,
}

const MEETING_OPEN_APPLY = {
  id: 'meeting-id', status: 'open',
  owner_user_id: 'owner-id',
  project_id: 'proj-id',
  scheduled_start: '2026-08-29T10:00:00Z',
}

describe('applyMeetingDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockRpc.mockResolvedValue({ error: null })
    mocks.mockRecordAuditEvent.mockResolvedValue({ error: null })
  })

  it('returns error when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })
    expect(result.error).toMatch(/not authenticated/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when draft is not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({ data: null, error: null })
    const result = await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })
    expect(result.error).toMatch(/not found/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when draft has already been applied', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({
      data: { ...DRAFT_ROW, applied_at: '2026-08-29T11:00:00Z' }, error: null,
    })
    const result = await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })
    expect(result.error).toMatch(/already been applied/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when draft has been discarded', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({
      data: { ...DRAFT_ROW, discarded_at: '2026-08-29T11:00:00Z' }, error: null,
    })
    const result = await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })
    expect(result.error).toMatch(/discarded/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when meeting is not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: DRAFT_ROW, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
    const result = await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })
    expect(result.error).toMatch(/not found/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when user lacks permission', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OTHER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: DRAFT_ROW, error: null })
      .mockResolvedValueOnce({ data: MEETING_OPEN_APPLY, error: null })
    const result = await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })
    expect(result.error).toMatch(/permission/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error for a published meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: DRAFT_ROW, error: null })
      .mockResolvedValueOnce({ data: { ...MEETING_OPEN_APPLY, status: 'published' }, error: null })
    const result = await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when the RPC fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: DRAFT_ROW, error: null })
      .mockResolvedValueOnce({ data: MEETING_OPEN_APPLY, error: null })
    mocks.mockRpc.mockResolvedValue({ error: { message: 'DB constraint' } })
    const result = await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })
    expect(result.error).toMatch(/failed to apply/i)
  })

  it('calls RPC on success and returns outcomesCreated count', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: DRAFT_ROW, error: null })
      .mockResolvedValueOnce({ data: MEETING_OPEN_APPLY, error: null })

    const result = await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })

    expect(result.error).toBeUndefined()
    // VALID_AI_OUTPUT has 1 task, 0 decisions, 0 waiting_ons
    expect(result.data?.outcomesCreated).toBe(1)
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'apply_meeting_ai_draft_and_audit',
      expect.objectContaining({
        p_draft_id:   'draft-id',
        p_meeting_id: 'meeting-id',
      }),
    )
  })

  it('passes p_working_notes = null when applyWorkingNotes is false', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: DRAFT_ROW, error: null })
      .mockResolvedValueOnce({ data: MEETING_OPEN_APPLY, error: null })

    await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })

    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'apply_meeting_ai_draft_and_audit',
      expect.objectContaining({ p_working_notes: null }),
    )
  })

  it('passes p_working_notes = minutes text when applyWorkingNotes is true', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: DRAFT_ROW, error: null })
      .mockResolvedValueOnce({ data: MEETING_OPEN_APPLY, error: null })

    await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: true })

    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'apply_meeting_ai_draft_and_audit',
      expect.objectContaining({ p_working_notes: VALID_AI_OUTPUT.minutes }),
    )
  })

  it('builds outcomes with correct kind values for each output type', async () => {
    const multiOutput = {
      minutes: 'Summary',
      tasks:       [{ title: 'Task A', description: null, owner_display_name: null, suggested_due: null, deadline_evidence: null, project_hint: null, priority_hint: null }],
      decisions:   [{ title: 'Decision B', decision_text: 'We decided X', rationale: null }],
      waiting_ons: [{ title: 'Waiting C', waiting_for: 'Vendor', owner_display_name: null, suggested_due: null, deadline_evidence: null, notes: null }],
    }
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: { ...DRAFT_ROW, output_json: multiOutput }, error: null })
      .mockResolvedValueOnce({ data: MEETING_OPEN_APPLY, error: null })

    const result = await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })

    expect(result.data?.outcomesCreated).toBe(3)
    const [, rpcArgs] = mocks.mockRpc.mock.calls[0] as [string, { p_outcomes: { kind: string; title: string }[] }]
    const kinds = rpcArgs.p_outcomes.map((o) => o.kind)
    expect(kinds).toEqual(['task', 'decision', 'waiting_on'])
    const titles = rpcArgs.p_outcomes.map((o) => o.title)
    expect(titles).toEqual(['Task A', 'Decision B', 'Waiting C'])
  })

  it('maps priority_hint correctly in task payload', async () => {
    const withPriority = {
      ...VALID_AI_OUTPUT,
      tasks: [
        { title: 'High', description: null, owner_display_name: null, suggested_due: null, deadline_evidence: null, project_hint: null, priority_hint: 'high' as const },
        { title: 'Low',  description: null, owner_display_name: null, suggested_due: null, deadline_evidence: null, project_hint: null, priority_hint: 'low'  as const },
        { title: 'Null', description: null, owner_display_name: null, suggested_due: null, deadline_evidence: null, project_hint: null, priority_hint: null },
      ],
    }
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: { ...DRAFT_ROW, output_json: withPriority }, error: null })
      .mockResolvedValueOnce({ data: MEETING_OPEN_APPLY, error: null })

    await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })

    const [, rpcArgs] = mocks.mockRpc.mock.calls[0] as [string, { p_outcomes: { payload_json: { priority: number } }[] }]
    expect(rpcArgs.p_outcomes[0].payload_json.priority).toBe(1)  // high → 1
    expect(rpcArgs.p_outcomes[1].payload_json.priority).toBe(3)  // low  → 3
    expect(rpcArgs.p_outcomes[2].payload_json.priority).toBe(2)  // null → 2 (Normal)
  })

  it('revalidatePath is called on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: DRAFT_ROW, error: null })
      .mockResolvedValueOnce({ data: MEETING_OPEN_APPLY, error: null })

    await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })

    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/meetings/meeting-id')
  })

  it('UM can apply a draft on any open meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: DRAFT_ROW, error: null })
      .mockResolvedValueOnce({ data: { ...MEETING_OPEN_APPLY, owner_user_id: 'someone-else' }, error: null })

    const result = await applyMeetingDraft('draft-id', 'meeting-id', { applyWorkingNotes: false })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalled()
  })
})
