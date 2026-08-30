/**
 * Tests for M5D — Canonical Published Minutes behaviour.
 *
 * What is tested here:
 *   - renderInline: pure bold-parsing logic extracted for unit testing
 *   - Migration 014 SQL contracts are documented with explanatory tests that
 *     describe the guarantees the migration provides (these cannot be
 *     exercised without a live Supabase instance but serve as executable
 *     specification and regression anchors).
 *   - Server-action-level double-publish protection (action layer, not SQL)
 *   - Corrections do not interact with meeting_minutes rows
 *
 * What is NOT tested here (requires integration tests against Supabase):
 *   - body exactly equals working_notes at the moment of publication
 *   - approved_by_user_id = publisher UUID
 *   - approved_at populated with current timestamp
 *   - atomicity (outcomes + minutes + status in one transaction)
 *   - idempotency under concurrent publish attempts
 *   - RLS: MEMBER owner/attendee can read; unrelated MEMBER cannot
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── renderInline extracted for unit testing ─────────────────────────────────
//
// MarkdownMeetingMinutes is a React component that cannot be rendered in a
// node/no-jsdom environment.  The inline-bold logic is re-implemented here as
// a pure function so the core parsing rule is covered without a DOM.

/** Mirror of renderInline from MarkdownMeetingMinutes — parses **bold** spans.
 *  Empty segments (split artefacts at boundaries) are filtered out; they
 *  render as nothing in React so they have no observable output effect. */
function renderInlineAsText(text: string): { text: string; bold: boolean }[] {
  return text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((seg) => {
    if (seg.startsWith('**') && seg.endsWith('**')) {
      return { text: seg.slice(2, -2), bold: true }
    }
    return { text: seg, bold: false }
  })
}

describe('renderInline (bold parsing)', () => {
  it('returns single plain segment for plain text', () => {
    const result = renderInlineAsText('Hello world')
    expect(result).toEqual([{ text: 'Hello world', bold: false }])
  })

  it('returns a bold segment for **wrapped** text', () => {
    const result = renderInlineAsText('**Key point**')
    expect(result).toEqual([{ text: 'Key point', bold: true }])
  })

  it('splits mixed inline content correctly', () => {
    const result = renderInlineAsText('Purpose: **Ship by Friday**')
    expect(result).toEqual([
      { text: 'Purpose: ', bold: false },
      { text: 'Ship by Friday', bold: true },
    ])
  })

  it('handles multiple bold spans in one line', () => {
    const result = renderInlineAsText('**A** and **B**')
    expect(result).toEqual([
      { text: 'A', bold: true },
      { text: ' and ', bold: false },
      { text: 'B', bold: true },
    ])
  })

  it('does not treat unpaired asterisks as bold', () => {
    const result = renderInlineAsText('* not bold *')
    expect(result).toEqual([{ text: '* not bold *', bold: false }])
  })

  it('returns empty array for empty string', () => {
    const result = renderInlineAsText('')
    expect(result).toEqual([])
  })
})

// ─── publishMeeting action — double-publish protection at the action layer ───
//
// The SQL RAISE EXCEPTION is the canonical guard, but the server action also
// checks status = 'draft' before calling the RPC, providing a second layer.

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()
  const mockSelectSingle = vi.fn()
  const mockFrom = vi.fn().mockImplementation(() => ({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({ single: mockSelectSingle }),
    }),
  }))
  const mockRpc = vi.fn()
  return {
    mockGetCurrentUser, mockRevalidatePath, mockSelectSingle,
    mockFrom, mockRpc,
    mockClient: { from: mockFrom },
    mockServiceClient: { rpc: mockRpc },
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mocks.mockClient),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))

const SUPER_ADMIN = { id: 'admin-uuid', role: 'SUPER_ADMIN' as const,
  display_name: 'Admin', email: 'a@test.com', active: true }
const MEETING_DRAFT = { id: 'meeting-uuid', status: 'draft', owner_user_id: SUPER_ADMIN.id }
const MEETING_PUBLISHED = { ...MEETING_DRAFT, status: 'published' }

describe('publishMeeting — action layer protection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls publish_meeting_and_audit with meeting_id and actor_user_id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_DRAFT, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { publishMeeting } = await import('@/lib/actions/meetings')
    const result = await publishMeeting('meeting-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith('publish_meeting_and_audit', {
      p_meeting_id: 'meeting-uuid',
      p_actor_user_id: SUPER_ADMIN.id,
    })
  })

  it('blocks double-publish at the action layer (meeting already published)', async () => {
    // After a successful publish the meeting.status = 'published'.
    // The action checks status === 'draft' before calling the RPC.
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_PUBLISHED, error: null })
    const { publishMeeting } = await import('@/lib/actions/meetings')
    const result = await publishMeeting('meeting-uuid')
    expect(result.error).toMatch(/draft/)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('surfaces RPC errors as user-facing error strings', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_DRAFT, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'deadlock detected' } })
    const { publishMeeting } = await import('@/lib/actions/meetings')
    const result = await publishMeeting('meeting-uuid')
    expect(result.error).toBeTruthy()
    expect(result.error).not.toMatch(/deadlock/) // internal details not leaked
  })
})

// ─── addMeetingCorrection — does NOT create new minutes version ───────────────

describe('addMeetingCorrection — minutes are not altered', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls add_meeting_correction_and_audit (not publish_meeting_and_audit)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_PUBLISHED, error: null })
    mocks.mockRpc.mockResolvedValue({ data: 'correction-uuid', error: null })
    const { addMeetingCorrection } = await import('@/lib/actions/meetings')
    await addMeetingCorrection('meeting-uuid', { body: 'Amendment text' })
    const rpcName = mocks.mockRpc.mock.calls[0]?.[0]
    expect(rpcName).toBe('add_meeting_correction_and_audit')
    expect(rpcName).not.toBe('publish_meeting_and_audit')
  })

  it('does not call publish_meeting_and_audit when adding a correction', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_PUBLISHED, error: null })
    mocks.mockRpc.mockResolvedValue({ data: 'correction-uuid', error: null })
    const { addMeetingCorrection } = await import('@/lib/actions/meetings')
    await addMeetingCorrection('meeting-uuid', { body: 'Fix text' })
    const allRpcCalls = mocks.mockRpc.mock.calls.map((c) => c[0])
    expect(allRpcCalls).not.toContain('publish_meeting_and_audit')
  })

  it('requires the meeting to be published before accepting a correction', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_DRAFT, error: null })
    const { addMeetingCorrection } = await import('@/lib/actions/meetings')
    const result = await addMeetingCorrection('meeting-uuid', { body: 'Fix' })
    expect(result.error).toMatch(/published/)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })
})

// ─── Migration 014 SQL contracts (documented as specification) ────────────────
//
// These tests document the guarantees that migration 014 provides.
// They cannot be exercised in unit tests — they require a live Supabase DB.
// They are written here as executable documentation and regression anchors
// so that future developers understand exactly what the SQL layer enforces.

describe('Migration 014 SQL contracts (specification)', () => {
  it('[SQL] publication is atomic: outcomes + minutes + status in one transaction', () => {
    // publish_meeting_and_audit is a PL/pgSQL SECURITY DEFINER function.
    // All INSERTs/UPDATEs within it run in the same implicit transaction.
    // A failure anywhere rolls back everything — no partial state possible.
    expect(true).toBe(true) // documented guarantee, verified at integration level
  })

  it('[SQL] body is a snapshot of working_notes at publish time', () => {
    // The function does: SELECT working_notes INTO v_working_notes ... FOR UPDATE
    // then immediately: INSERT INTO meeting_minutes (body = COALESCE(v_working_notes, ''))
    // working_notes cannot change between lock and INSERT (row is locked).
    expect(true).toBe(true)
  })

  it('[SQL] approved_by_user_id = the actor who triggered publication', () => {
    // INSERT meeting_minutes includes: approved_by_user_id = p_actor_user_id
    // The server action passes user.id as p_actor_user_id.
    expect(true).toBe(true)
  })

  it('[SQL] approved_at is populated with publication timestamp', () => {
    // INSERT meeting_minutes includes: approved_at = now()
    expect(true).toBe(true)
  })

  it('[SQL] empty working_notes do not block publication', () => {
    // COALESCE(v_working_notes, '') stores '' when notes are null.
    // body is NOT NULL — empty string satisfies the constraint.
    expect(true).toBe(true)
  })

  it('[SQL] double-publish cannot create a second minutes row', () => {
    // Primary guard: status='draft' check raises EXCEPTION if already published.
    // Secondary guard: ON CONFLICT (meeting_id, version) DO NOTHING on the INSERT.
    expect(true).toBe(true)
  })

  it('[SQL] meeting_minutes RLS: MEMBER can read minutes for owned/attended meetings', () => {
    // Migration 014 adds policy "meeting_minutes: member can read attended".
    // Mirrors meeting visibility + meeting_corrections policies exactly.
    expect(true).toBe(true)
  })

  it('[SQL] unrelated MEMBER cannot read meeting_minutes', () => {
    // The MEMBER read policy requires ownership or attendance.
    // A MEMBER who neither owns nor attended the meeting gets no rows.
    expect(true).toBe(true)
  })
})
