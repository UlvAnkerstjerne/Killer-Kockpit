/**
 * Tests for lib/actions/transcripts.ts server actions.
 *
 * Coverage:
 *   addTranscript     — auth gate, permission check, already-has-transcript guard,
 *                       format validation, size validation, happy path + audit
 *   replaceTranscript — auth gate, permission check, format validation, happy path
 *   removeTranscript  — auth gate, permission check, no-transcript guard, happy path
 *   canManageTranscript (from lib/permissions) — role × status matrix
 *
 * Strategy:
 *   DB calls are fully mocked via vi.mock('@/lib/supabase/server').
 *   createServiceClient() returns a chainable mock builder.
 *   No real DB or network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { canManageTranscript, canReadTranscript } from '@/lib/permissions'

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser  = vi.fn()
  const mockRevalidatePath  = vi.fn()
  const mockRecordAuditEvent = vi.fn().mockResolvedValue({ error: null })

  // Flexible query chain mock — each method returns the chain or a final result
  // We override `.mockResolvedValue` on the terminal method per test.
  const mockSingle    = vi.fn()
  const mockMaybeSingle = vi.fn()
  const mockInsert    = vi.fn()
  const mockUpdate    = vi.fn()
  const mockSelectFn  = vi.fn()
  const mockLimit     = vi.fn()
  const mockOrder     = vi.fn()
  const mockEq        = vi.fn()

  // Build a minimal chainable Supabase mock
  // Each call returns { select, eq, single, maybeSingle, insert, update }
  function makeChain() {
    return {
      select:      mockSelectFn,
      eq:          mockEq,
      single:      mockSingle,
      maybeSingle: mockMaybeSingle,
      insert:      mockInsert,
      update:      mockUpdate,
      order:       mockOrder,
      limit:       mockLimit,
    }
  }

  mockSelectFn.mockReturnValue(makeChain())
  mockEq.mockReturnValue(makeChain())
  mockOrder.mockReturnValue(makeChain())
  mockLimit.mockReturnValue(makeChain())
  mockInsert.mockReturnValue(makeChain())
  mockUpdate.mockReturnValue(makeChain())

  const mockFrom = vi.fn().mockReturnValue(makeChain())
  const mockServiceClient = { from: mockFrom }

  return {
    mockGetCurrentUser,
    mockRevalidatePath,
    mockRecordAuditEvent,
    mockSingle,
    mockMaybeSingle,
    mockInsert,
    mockUpdate,
    mockFrom,
    mockServiceClient,
    makeChain,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/audit', () => ({ recordAuditEvent: mocks.mockRecordAuditEvent }))
vi.mock('@/lib/supabase/server', () => ({
  createClient:       vi.fn(),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))

// ─── Additional mocks for checkGoogleMeetTranscript ───────────────────────────

const gmMocks = vi.hoisted(() => {
  const mockGetGoogleOAuth2Client      = vi.fn()
  const mockHasMeetScope               = vi.fn()
  const mockFetchGoogleMeetTranscript  = vi.fn()
  return { mockGetGoogleOAuth2Client, mockHasMeetScope, mockFetchGoogleMeetTranscript }
})

vi.mock('@/lib/google/auth', () => ({
  getGoogleOAuth2Client: gmMocks.mockGetGoogleOAuth2Client,
  hasMeetScope:          gmMocks.mockHasMeetScope,
}))

vi.mock('@/lib/google/transcripts', () => ({
  fetchGoogleMeetTranscript: gmMocks.mockFetchGoogleMeetTranscript,
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SUPER_ADMIN = { id: 'admin-id', role: 'SUPER_ADMIN' as const }
const MEMBER_OWNER = { id: 'owner-id', role: 'MEMBER' as const }
const MEMBER_OTHER = { id: 'other-id', role: 'MEMBER' as const }
const UM_USER      = { id: 'um-id',    role: 'UM'    as const }

const MEETING_OPEN = {
  owner_user_id:        'owner-id',
  status:               'open',
  transcript_source_id: null,
}

const MEETING_WITH_TRANSCRIPT = {
  owner_user_id:        'owner-id',
  status:               'open',
  transcript_source_id: 'existing-source-id',
}

const MEETING_PUBLISHED = {
  owner_user_id:        'owner-id',
  status:               'published',
  transcript_source_id: null,
}

const MEETING_CANCELLED = {
  owner_user_id:        'owner-id',
  status:               'cancelled',
  transcript_source_id: null,
}

const SAMPLE_VTT = `WEBVTT

00:00:00.000 --> 00:00:05.000
Hello world`

const SAMPLE_SRT = `1
00:00:00,000 --> 00:00:05,000
Hello world`

import { addTranscript, replaceTranscript, removeTranscript, getTranscriptContent, checkGoogleMeetTranscript } from '@/lib/actions/transcripts'

// ─── canManageTranscript ──────────────────────────────────────────────────────

describe('canManageTranscript', () => {
  it('SUPER_ADMIN can manage on any non-terminal status', () => {
    for (const status of ['scheduled', 'open', 'draft']) {
      expect(canManageTranscript('SUPER_ADMIN', 'other-id', 'admin-id', status)).toBe(true)
    }
  })

  it('SUPER_ADMIN cannot manage on published meeting', () => {
    expect(canManageTranscript('SUPER_ADMIN', 'other-id', 'admin-id', 'published')).toBe(false)
  })

  it('SUPER_ADMIN cannot manage on cancelled meeting', () => {
    expect(canManageTranscript('SUPER_ADMIN', 'other-id', 'admin-id', 'cancelled')).toBe(false)
  })

  it('meeting owner can manage their own open meeting', () => {
    expect(canManageTranscript('MEMBER', 'owner-id', 'owner-id', 'open')).toBe(true)
  })

  it('meeting owner cannot manage published meeting', () => {
    expect(canManageTranscript('MEMBER', 'owner-id', 'owner-id', 'published')).toBe(false)
  })

  it('non-owner MEMBER cannot manage', () => {
    expect(canManageTranscript('MEMBER', 'owner-id', 'other-id', 'open')).toBe(false)
  })

  it('UM can manage any open meeting regardless of ownership', () => {
    expect(canManageTranscript('UM', 'owner-id', 'um-id', 'open')).toBe(true)
  })

  it('UM can manage scheduled meetings', () => {
    expect(canManageTranscript('UM', 'owner-id', 'um-id', 'scheduled')).toBe(true)
  })

  it('UM can manage draft meetings', () => {
    expect(canManageTranscript('UM', 'owner-id', 'um-id', 'draft')).toBe(true)
  })

  it('UM cannot manage published meeting', () => {
    expect(canManageTranscript('UM', 'owner-id', 'um-id', 'published')).toBe(false)
  })

  it('UM cannot manage cancelled meeting', () => {
    expect(canManageTranscript('UM', 'owner-id', 'um-id', 'cancelled')).toBe(false)
  })

  it('MEMBER non-owner cannot manage even on open meeting', () => {
    expect(canManageTranscript('MEMBER', 'owner-id', 'other-id', 'open')).toBe(false)
  })

  it('MEMBER non-owner cannot manage on any allowed status', () => {
    for (const status of ['scheduled', 'open', 'draft']) {
      expect(canManageTranscript('MEMBER', 'owner-id', 'other-id', status)).toBe(false)
    }
  })

  it('returns false for null status', () => {
    expect(canManageTranscript('SUPER_ADMIN', null, 'admin-id', null)).toBe(false)
  })
})

// ─── addTranscript ────────────────────────────────────────────────────────────

describe('addTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockRecordAuditEvent.mockResolvedValue({ error: null })
  })

  it('returns error if not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await addTranscript('meeting-id', 'transcript.vtt', SAMPLE_VTT)
    expect(result.error).toMatch(/not authenticated/i)
  })

  it('returns error if user lacks permission', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OTHER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    const result = await addTranscript('meeting-id', 'transcript.vtt', SAMPLE_VTT)
    expect(result.error).toMatch(/permission/i)
  })

  it('returns error if meeting already has a transcript', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_WITH_TRANSCRIPT, error: null })
    const result = await addTranscript('meeting-id', 'transcript.vtt', SAMPLE_VTT)
    expect(result.error).toMatch(/already has a transcript/i)
  })

  it('returns error for unsupported file extension', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    const result = await addTranscript('meeting-id', 'transcript.docx', 'content')
    expect(result.error).toMatch(/unsupported file type/i)
    expect(result.error).toContain('.vtt, .srt, .md, or .txt')
  })

  it('returns error for empty content', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    const result = await addTranscript('meeting-id', 'transcript.vtt', '   ')
    expect(result.error).toMatch(/empty/i)
  })

  it('returns error for empty paste content (null fileName)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    const result = await addTranscript('meeting-id', null, '   ')
    expect(result.error).toMatch(/empty/i)
  })

  it('returns error if content exceeds 5 MB', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    // Create a string just over 5 MB
    const bigContent = 'x'.repeat(5 * 1024 * 1024 + 1)
    const result = await addTranscript('meeting-id', 'transcript.vtt', bigContent)
    expect(result.error).toMatch(/too large/i)
  })

  it('returns error if paste content exceeds 5 MB', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    const bigContent = 'x'.repeat(5 * 1024 * 1024 + 1)
    const result = await addTranscript('meeting-id', null, bigContent)
    expect(result.error).toMatch(/too large/i)
  })

  it('succeeds for SUPER_ADMIN on another user\'s meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: { id: 'new-source-id', created_at: '2026-08-29T10:00:00Z' }, error: null })
    // entity_sources.insert() and meetings.update().eq() use default chain (error: undefined → falsy)

    const result = await addTranscript('meeting-id', 'notes.vtt', SAMPLE_VTT)
    expect(result.error).toBeUndefined()
    expect(result.data?.fileName).toBe('notes.vtt')
    expect(result.data?.format).toBe('vtt')
  })

  it('accepts .srt files', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: { id: 'src-id', created_at: '2026-08-29T10:00:00Z' }, error: null })

    const result = await addTranscript('meeting-id', 'standup.srt', SAMPLE_SRT)
    expect(result.error).toBeUndefined()
    expect(result.data?.format).toBe('srt')
  })

  it('accepts .txt files', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: { id: 'src-id', created_at: '2026-08-29T10:00:00Z' }, error: null })

    const result = await addTranscript('meeting-id', 'notes.txt', 'Alice: hello')
    expect(result.error).toBeUndefined()
    expect(result.data?.format).toBe('txt')
  })

  it('accepts .md files', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: { id: 'src-id', created_at: '2026-08-29T10:00:00Z' }, error: null })

    const result = await addTranscript('meeting-id', 'notes.md', '# Meeting\n\nAlice: hello')
    expect(result.error).toBeUndefined()
    expect(result.data?.format).toBe('md')
    expect(result.data?.provider).toBe('file_upload')
  })

  it('accepts manual paste (null fileName)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: { id: 'src-id', created_at: '2026-08-29T10:00:00Z' }, error: null })

    const result = await addTranscript('meeting-id', null, 'Alice: hello\nBob: world')
    expect(result.error).toBeUndefined()
    expect(result.data?.fileName).toBeNull()
    expect(result.data?.format).toBe('text')
    expect(result.data?.provider).toBe('manual_paste')
  })

  it('records an audit event on success with provider=file_upload', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: { id: 'src-id', created_at: '2026-08-29T10:00:00Z' }, error: null })

    await addTranscript('meeting-id', 'transcript.vtt', SAMPLE_VTT)

    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action:    'transcript_attached',
        entityId:  'meeting-id',
        afterJson: expect.objectContaining({ provider: 'file_upload' }),
      })
    )
  })

  it('records provider=manual_paste in audit event for paste', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: { id: 'src-id', created_at: '2026-08-29T10:00:00Z' }, error: null })

    await addTranscript('meeting-id', null, 'Some transcript text')

    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action:    'transcript_attached',
        afterJson: expect.objectContaining({ provider: 'manual_paste', file_name: null }),
      })
    )
  })

  it('calls revalidatePath on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_OPEN, error: null })
      .mockResolvedValueOnce({ data: { id: 'src-id', created_at: '2026-08-29T10:00:00Z' }, error: null })

    await addTranscript('meeting-id', 'transcript.vtt', SAMPLE_VTT)

    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/meetings/meeting-id')
  })
})

// ─── replaceTranscript ────────────────────────────────────────────────────────

describe('replaceTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockRecordAuditEvent.mockResolvedValue({ error: null })
  })

  it('returns error if not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await replaceTranscript('meeting-id', 'new.vtt', SAMPLE_VTT)
    expect(result.error).toMatch(/not authenticated/i)
  })

  it('returns error if user lacks permission', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OTHER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_WITH_TRANSCRIPT, error: null })
    const result = await replaceTranscript('meeting-id', 'new.vtt', SAMPLE_VTT)
    expect(result.error).toMatch(/permission/i)
  })

  it('returns error for unsupported extension', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_WITH_TRANSCRIPT, error: null })
    const result = await replaceTranscript('meeting-id', 'file.pdf', 'content')
    expect(result.error).toMatch(/unsupported file type/i)
  })

  it('accepts manual paste as replacement (null fileName)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_WITH_TRANSCRIPT, error: null })
      .mockResolvedValueOnce({ data: { id: 'new-src', created_at: '2026-08-29T11:00:00Z' }, error: null })

    const result = await replaceTranscript('meeting-id', null, 'Corrected transcript text')
    expect(result.error).toBeUndefined()
    expect(result.data?.fileName).toBeNull()
    expect(result.data?.format).toBe('text')
    expect(result.data?.provider).toBe('manual_paste')
  })

  it('succeeds and records transcript_replaced audit event', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_WITH_TRANSCRIPT, error: null })
      .mockResolvedValueOnce({ data: { id: 'new-src', created_at: '2026-08-29T11:00:00Z' }, error: null })

    const result = await replaceTranscript('meeting-id', 'new.vtt', SAMPLE_VTT)
    expect(result.error).toBeUndefined()
    expect(result.data?.fileName).toBe('new.vtt')

    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'transcript_replaced' })
    )
  })

  it('includes previous source id in audit beforeJson', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_WITH_TRANSCRIPT, error: null })
      .mockResolvedValueOnce({ data: { id: 'new-src', created_at: '2026-08-29T11:00:00Z' }, error: null })

    await replaceTranscript('meeting-id', 'new.vtt', SAMPLE_VTT)

    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeJson: expect.objectContaining({ source_id: 'existing-source-id' }),
      })
    )
  })
})

// ─── removeTranscript ─────────────────────────────────────────────────────────

describe('removeTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockRecordAuditEvent.mockResolvedValue({ error: null })
  })

  it('returns error if not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await removeTranscript('meeting-id')
    expect(result.error).toMatch(/not authenticated/i)
  })

  it('returns error if user lacks permission', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OTHER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_WITH_TRANSCRIPT, error: null })
    const result = await removeTranscript('meeting-id')
    expect(result.error).toMatch(/permission/i)
  })

  it('returns error if meeting has no transcript', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    const result = await removeTranscript('meeting-id')
    expect(result.error).toMatch(/no transcript/i)
  })

  it('succeeds and clears transcript reference', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_WITH_TRANSCRIPT, error: null })
      .mockResolvedValueOnce({ data: { file_name: 'old.vtt', metadata: {} }, error: null })
    // meetings.update().eq() uses default chain — error is undefined (falsy)

    const result = await removeTranscript('meeting-id')
    expect(result.error).toBeUndefined()
  })

  it('records transcript_removed audit event', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_WITH_TRANSCRIPT, error: null })
      .mockResolvedValueOnce({ data: { file_name: 'old.vtt', metadata: {} }, error: null })

    await removeTranscript('meeting-id')

    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'transcript_removed', entityId: 'meeting-id' })
    )
  })

  it('calls revalidatePath on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_WITH_TRANSCRIPT, error: null })
      .mockResolvedValueOnce({ data: { file_name: 'old.vtt', metadata: {} }, error: null })

    await removeTranscript('meeting-id')
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/meetings/meeting-id')
  })

  it('allows UM to remove transcript from any open meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_WITH_TRANSCRIPT, error: null })
      .mockResolvedValueOnce({ data: { file_name: 'old.vtt', metadata: {} }, error: null })
    const result = await removeTranscript('meeting-id')
    expect(result.error).toBeUndefined()
  })

  it('blocks action on published meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSingle.mockResolvedValue({
      data: { ...MEETING_PUBLISHED, transcript_source_id: 'some-id' },
      error: null,
    })
    const result = await removeTranscript('meeting-id')
    expect(result.error).toMatch(/permission/i)
  })
})

// ─── canReadTranscript ────────────────────────────────────────────────────────

describe('canReadTranscript', () => {
  it('SUPER_ADMIN can read regardless of ownership', () => {
    expect(canReadTranscript('SUPER_ADMIN', 'other-id', 'admin-id')).toBe(true)
  })

  it('UM can read any meeting', () => {
    expect(canReadTranscript('UM', 'other-id', 'um-id')).toBe(true)
  })

  it('meeting owner can read their own meeting', () => {
    expect(canReadTranscript('MEMBER', 'owner-id', 'owner-id')).toBe(true)
  })

  it('MEMBER non-owner without attendee flag cannot read', () => {
    expect(canReadTranscript('MEMBER', 'owner-id', 'other-id')).toBe(false)
  })

  it('MEMBER non-owner who is an attendee can read (isAttendee=true)', () => {
    expect(canReadTranscript('MEMBER', 'owner-id', 'other-id', true)).toBe(true)
  })

  it('MEMBER non-owner who is NOT an attendee cannot read (isAttendee=false)', () => {
    expect(canReadTranscript('MEMBER', 'owner-id', 'other-id', false)).toBe(false)
  })

  it('has no status gate — published meetings remain readable', () => {
    // canReadTranscript takes no status param; caller (getTranscriptContent) does
    // not gate on status either. Published meetings are readable.
    expect(canReadTranscript('SUPER_ADMIN', 'owner-id', 'admin-id')).toBe(true)
    expect(canReadTranscript('MEMBER', 'owner-id', 'owner-id')).toBe(true)
  })
})

// ─── getTranscriptContent ─────────────────────────────────────────────────────

describe('getTranscriptContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns error if not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await getTranscriptContent('meeting-id')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/not authenticated/i)
  })

  it('returns error if user lacks read permission and is not an attendee', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OTHER)
    mocks.mockSingle.mockResolvedValue({
      data: { owner_user_id: 'owner-id', transcript_source_id: 'src-id' },
      error: null,
    })
    // Attendee lookup — not found
    mocks.mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })
    const result = await getTranscriptContent('meeting-id')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/permission/i)
  })

  it('returns error if meeting has no transcript', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle.mockResolvedValue({
      data: { owner_user_id: 'owner-id', transcript_source_id: null },
      error: null,
    })
    const result = await getTranscriptContent('meeting-id')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/no transcript/i)
  })

  it('returns content for meeting owner', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({
        data: { owner_user_id: 'owner-id', transcript_source_id: 'src-id' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { content: 'Alice: Hello\nBob: World' },
        error: null,
      })
    const result = await getTranscriptContent('meeting-id')
    expect('content' in result).toBe(true)
    if ('content' in result) {
      expect(result.content).toBe('Alice: Hello\nBob: World')
    }
  })

  it('returns content for SUPER_ADMIN on any meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSingle
      .mockResolvedValueOnce({
        data: { owner_user_id: 'owner-id', transcript_source_id: 'src-id' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { content: 'Transcript text' },
        error: null,
      })
    const result = await getTranscriptContent('meeting-id')
    expect('content' in result).toBe(true)
  })

  it('returns content for UM on any meeting regardless of ownership', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSingle
      .mockResolvedValueOnce({
        data: { owner_user_id: 'owner-id', transcript_source_id: 'src-id' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { content: 'Transcript text' },
        error: null,
      })
    const result = await getTranscriptContent('meeting-id')
    expect('content' in result).toBe(true)
  })

  it('allows reading transcript on a published meeting', async () => {
    // Published status is not checked — transcript remains readable after publication
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({
        // Note: status is not fetched in getTranscriptContent — no status gate
        data: { owner_user_id: 'owner-id', transcript_source_id: 'src-id' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { content: 'Published meeting transcript' },
        error: null,
      })
    const result = await getTranscriptContent('meeting-id')
    expect('content' in result).toBe(true)
  })

  it('returns error if source content is missing', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    mocks.mockSingle
      .mockResolvedValueOnce({
        data: { owner_user_id: 'owner-id', transcript_source_id: 'src-id' },
        error: null,
      })
      .mockResolvedValueOnce({ data: { content: null }, error: null })
    const result = await getTranscriptContent('meeting-id')
    expect('error' in result).toBe(true)
  })

  it('returns content for a MEMBER who is an attendee but not the owner', async () => {
    // MEMBER_OTHER is not the owner but is an attendee — transcript read is allowed
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OTHER)
    mocks.mockSingle
      .mockResolvedValueOnce({
        data: { owner_user_id: 'owner-id', transcript_source_id: 'src-id' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { content: 'Attendee-readable transcript' },
        error: null,
      })
    // Attendee lookup — found
    mocks.mockMaybeSingle.mockResolvedValueOnce({ data: { id: 'attendee-row-id' }, error: null })

    const result = await getTranscriptContent('meeting-id')
    expect('content' in result).toBe(true)
    if ('content' in result) expect(result.content).toBe('Attendee-readable transcript')
  })

  it('denies a MEMBER who is neither owner nor attendee', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OTHER)
    mocks.mockSingle.mockResolvedValueOnce({
      data: { owner_user_id: 'owner-id', transcript_source_id: 'src-id' },
      error: null,
    })
    // Attendee lookup — not found
    mocks.mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await getTranscriptContent('meeting-id')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/permission/i)
  })
})

// ─── checkGoogleMeetTranscript ────────────────────────────────────────────────

const BASE_SCHEDULED = '2026-08-30T10:00:00Z'

const MEETING_WITH_MEET = {
  owner_user_id:             'owner-id',
  status:                    'open',
  transcript_source_id:      null as string | null,
  meet_space_name:           'spaces/TestSpace',
  calendar_synced_by_user_id: null as string | null,
  scheduled_start:           BASE_SCHEDULED,
  scheduled_end:             null as string | null,
}

const FETCH_SUCCESS = {
  ok:                     true as const,
  transcriptResourceName: 'conferenceRecords/rec-1/transcripts/tr-1',
  conferenceRecordName:   'conferenceRecords/rec-1',
  conferenceRecordStart:  BASE_SCHEDULED,
  content:                'Alice: Hello world',
  metadata: {
    provider:                 'google_meet' as const,
    meet_space_name:          'spaces/TestSpace',
    conference_record_name:   'conferenceRecords/rec-1',
    transcript_resource_name: 'conferenceRecords/rec-1/transcripts/tr-1',
    transcript_state:         'FILE_GENERATED',
    language_code:            null,
    entry_count:              1,
    word_count:               3,
    speaker_count:            1,
    fetched_at:               '2026-08-30T12:00:00Z',
    speakers:                 [{ display_name: 'Alice', participant_resource: 'cr/rec-1/participants/p-1' }],
  },
}

/** Default oauth client fixture — has credentials.scope set so hasMeetScope can check it. */
const OAUTH_CLIENT = { credentials: { scope: 'https://www.googleapis.com/auth/meetings.space.readonly' } }

describe('checkGoogleMeetTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockRecordAuditEvent.mockResolvedValue({ error: null })

    // Default: authenticated owner with Meet scope and successful fetch
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OWNER)
    gmMocks.mockGetGoogleOAuth2Client.mockResolvedValue(OAUTH_CLIENT)
    gmMocks.mockHasMeetScope.mockReturnValue(true)
    gmMocks.mockFetchGoogleMeetTranscript.mockResolvedValue(FETCH_SUCCESS)
  })

  // ── Auth + permission gates ───────────────────────────────────────────────

  it('returns error if not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await checkGoogleMeetTranscript('meeting-id')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/not authenticated/i)
  })

  it('returns error if user lacks canManageTranscript permission', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_OTHER)
    mocks.mockSingle.mockResolvedValueOnce({ data: MEETING_WITH_MEET, error: null })

    const result = await checkGoogleMeetTranscript('meeting-id')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/permission/i)
  })

  it('returns error if meeting has no meet_space_name', async () => {
    mocks.mockSingle.mockResolvedValueOnce({
      data: { ...MEETING_WITH_MEET, meet_space_name: null },
      error: null,
    })

    const result = await checkGoogleMeetTranscript('meeting-id')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/no google meet conference/i)
  })

  // ── Credential routing ────────────────────────────────────────────────────

  it('returns error if no Google credential is available', async () => {
    mocks.mockSingle.mockResolvedValueOnce({ data: MEETING_WITH_MEET, error: null })
    gmMocks.mockGetGoogleOAuth2Client.mockResolvedValue(null)

    const result = await checkGoogleMeetTranscript('meeting-id')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/google is not connected/i)
  })

  it('prefers calendar_synced_by_user_id credential over requesting user', async () => {
    mocks.mockSingle.mockResolvedValueOnce({
      data: { ...MEETING_WITH_MEET, calendar_synced_by_user_id: 'syncer-id' },
      error: null,
    })
    // idempotency: no existing Google source
    mocks.mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })
    // insertTranscript sources.insert → single
    mocks.mockSingle.mockResolvedValueOnce({ data: { id: 'new-src', created_at: '2026-08-30T12:00:00Z' }, error: null })

    await checkGoogleMeetTranscript('meeting-id')

    // First getGoogleOAuth2Client call should be for syncer-id
    expect(gmMocks.mockGetGoogleOAuth2Client).toHaveBeenCalledWith('syncer-id')
  })

  it('falls back to requesting user credential if preferred user has none', async () => {
    mocks.mockSingle.mockResolvedValueOnce({
      data: { ...MEETING_WITH_MEET, calendar_synced_by_user_id: 'syncer-id' },
      error: null,
    })
    // idempotency: no existing Google source
    mocks.mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })
    mocks.mockSingle.mockResolvedValueOnce({ data: { id: 'new-src', created_at: '2026-08-30T12:00:00Z' }, error: null })

    // syncer-id has no credential; owner-id does
    gmMocks.mockGetGoogleOAuth2Client
      .mockResolvedValueOnce(null)           // syncer-id → no credential
      .mockResolvedValueOnce(OAUTH_CLIENT)   // owner-id → credential

    await checkGoogleMeetTranscript('meeting-id')

    expect(gmMocks.mockGetGoogleOAuth2Client).toHaveBeenCalledWith('owner-id')
  })

  // ── Scope gate ────────────────────────────────────────────────────────────

  it('returns error if credential lacks Meet scope', async () => {
    mocks.mockSingle.mockResolvedValueOnce({ data: MEETING_WITH_MEET, error: null })
    gmMocks.mockHasMeetScope.mockReturnValue(false)

    const result = await checkGoogleMeetTranscript('meeting-id')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/google meet is not authorised/i)
  })

  // ── Fetch result states ───────────────────────────────────────────────────

  it('returns processing result when Google is still processing', async () => {
    mocks.mockSingle.mockResolvedValueOnce({ data: MEETING_WITH_MEET, error: null })
    gmMocks.mockFetchGoogleMeetTranscript.mockResolvedValue({
      ok:                  false,
      status:              'processing',
      conferenceRecordName: 'cr/1',
      transcriptName:      'cr/1/transcripts/tr-1',
    })

    const result = await checkGoogleMeetTranscript('meeting-id')
    expect('result' in result).toBe(true)
    if ('result' in result) expect(result.result.status).toBe('processing')
  })

  it('returns not_found result with reason when no transcript found', async () => {
    mocks.mockSingle.mockResolvedValueOnce({ data: MEETING_WITH_MEET, error: null })
    gmMocks.mockFetchGoogleMeetTranscript.mockResolvedValue({
      ok:     false,
      status: 'not_found',
      reason: 'No conference record found.',
    })

    const result = await checkGoogleMeetTranscript('meeting-id')
    expect('result' in result).toBe(true)
    if ('result' in result) {
      expect(result.result.status).toBe('not_found')
      if (result.result.status === 'not_found') {
        expect(result.result.reason).toBe('No conference record found.')
      }
    }
  })

  it('returns ambiguous result when multiple conference records match', async () => {
    mocks.mockSingle.mockResolvedValueOnce({ data: MEETING_WITH_MEET, error: null })
    gmMocks.mockFetchGoogleMeetTranscript.mockResolvedValue({
      ok:            false,
      status:        'ambiguous',
      plausibleCount: 3,
    })

    const result = await checkGoogleMeetTranscript('meeting-id')
    expect('result' in result).toBe(true)
    if ('result' in result) expect(result.result.status).toBe('ambiguous')
  })

  it('returns error when fetch returns error status', async () => {
    mocks.mockSingle.mockResolvedValueOnce({ data: MEETING_WITH_MEET, error: null })
    gmMocks.mockFetchGoogleMeetTranscript.mockResolvedValue({
      ok:     false,
      status: 'error',
      error:  'Access denied.',
    })

    const result = await checkGoogleMeetTranscript('meeting-id')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toBe('Access denied.')
  })

  // ── Idempotency ───────────────────────────────────────────────────────────

  it('returns already_attached when same Google transcript is already the current one', async () => {
    const googleSrcId = 'google-source-id'
    mocks.mockSingle.mockResolvedValueOnce({
      data: { ...MEETING_WITH_MEET, transcript_source_id: googleSrcId },
      error: null,
    })
    // idempotency: existing Google source found with same id as current
    mocks.mockMaybeSingle.mockResolvedValueOnce({ data: { id: googleSrcId }, error: null })

    const result = await checkGoogleMeetTranscript('meeting-id')
    expect('result' in result).toBe(true)
    if ('result' in result) expect(result.result.status).toBe('already_attached')
  })

  it('does not insert a duplicate source on repeated calls (already_attached)', async () => {
    const googleSrcId = 'google-source-id'
    mocks.mockSingle.mockResolvedValueOnce({
      data: { ...MEETING_WITH_MEET, transcript_source_id: googleSrcId },
      error: null,
    })
    mocks.mockMaybeSingle.mockResolvedValueOnce({ data: { id: googleSrcId }, error: null })

    await checkGoogleMeetTranscript('meeting-id')
    // No insert should have been called
    expect(mocks.mockInsert).not.toHaveBeenCalled()
  })

  // ── Conflict handling ─────────────────────────────────────────────────────

  it('returns conflict when meeting has a different existing transcript and replaceExisting=false', async () => {
    mocks.mockSingle
      .mockResolvedValueOnce({
        // Meeting row: has a different (manual) transcript
        data: { ...MEETING_WITH_MEET, transcript_source_id: 'existing-manual-id' },
        error: null,
      })
      // getTranscriptSource → from('meetings').select.eq.single
      .mockResolvedValueOnce({ data: { transcript_source_id: 'existing-manual-id' }, error: null })
      // getTranscriptSource → from('sources').select.eq.single
      .mockResolvedValueOnce({
        data: {
          id:         'existing-manual-id',
          file_name:  'old.vtt',
          metadata:   { provider: 'file_upload', format: 'vtt', byte_size: 1000, char_count: 500 },
          created_at: '2026-01-01T00:00:00Z',
        },
        error: null,
      })

    mocks.mockMaybeSingle
      // idempotency: no existing Google source for this transcript resource name
      .mockResolvedValueOnce({ data: null, error: null })
      // getTranscriptSource → entity_sources link
      .mockResolvedValueOnce({ data: { created_at: '2026-01-01T00:00:00Z' }, error: null })

    const result = await checkGoogleMeetTranscript('meeting-id', false)
    expect('result' in result).toBe(true)
    if ('result' in result) {
      expect(result.result.status).toBe('conflict')
      if (result.result.status === 'conflict') {
        expect(result.result.existingSource.sourceId).toBe('existing-manual-id')
      }
    }
  })

  it('proceeds with insert when replaceExisting=true bypasses conflict', async () => {
    mocks.mockSingle
      .mockResolvedValueOnce({
        data: { ...MEETING_WITH_MEET, transcript_source_id: 'existing-manual-id' },
        error: null,
      })
      // insertTranscript sources.insert → single
      .mockResolvedValueOnce({ data: { id: 'new-google-src', created_at: '2026-08-30T12:00:00Z' }, error: null })

    // idempotency: no existing Google source
    mocks.mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await checkGoogleMeetTranscript('meeting-id', true)
    expect('result' in result).toBe(true)
    if ('result' in result) expect(result.result.status).toBe('attached')
  })

  // ── Happy path: new insert ────────────────────────────────────────────────

  it('inserts new source and returns attached on happy path (no prior transcript)', async () => {
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_WITH_MEET, error: null })
      // insertTranscript sources.insert → single
      .mockResolvedValueOnce({ data: { id: 'new-src', created_at: '2026-08-30T12:00:00Z' }, error: null })

    // idempotency: no existing Google source
    mocks.mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await checkGoogleMeetTranscript('meeting-id')
    expect('result' in result).toBe(true)
    if ('result' in result) {
      expect(result.result.status).toBe('attached')
      if (result.result.status === 'attached') {
        expect(result.result.source.provider).toBe('google_meet')
        expect(result.result.source.sourceId).toBe('new-src')
      }
    }
  })

  it('records transcript_attached audit event on new insert', async () => {
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_WITH_MEET, error: null })
      .mockResolvedValueOnce({ data: { id: 'new-src', created_at: '2026-08-30T12:00:00Z' }, error: null })
    mocks.mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })

    await checkGoogleMeetTranscript('meeting-id')

    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action:    'transcript_attached',
        entityId:  'meeting-id',
        afterJson: expect.objectContaining({ provider: 'google_meet' }),
      })
    )
  })

  it('calls revalidatePath after successful insert', async () => {
    mocks.mockSingle
      .mockResolvedValueOnce({ data: MEETING_WITH_MEET, error: null })
      .mockResolvedValueOnce({ data: { id: 'new-src', created_at: '2026-08-30T12:00:00Z' }, error: null })
    mocks.mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })

    await checkGoogleMeetTranscript('meeting-id')
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/meetings/meeting-id')
  })
})
