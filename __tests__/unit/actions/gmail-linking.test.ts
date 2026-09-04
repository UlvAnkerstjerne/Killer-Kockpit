/**
 * M7C: Tests for the email → entity linking functions in lib/actions/gmail.ts
 *
 * Verifies:
 *   - batchGetEmailActionStatus returns only actioned messageIds
 *   - getMessageActions returns EmailAction[] with correct labels
 *   - linkEmailToEntity is idempotent and writes relation='related_to'
 *   - unlinkEmailFromEntity rejects originated_from rows
 *   - unlinkEmailFromEntity rejects rows owned by a different user
 *   - All actions reject unauthenticated callers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser      = vi.fn()
  const mockGetConnectionStatus = vi.fn()
  const mockHasGmailScope       = vi.fn()

  // Chainable query builder helpers
  const makeSingleChain = (resolved: unknown) => ({
    maybeSingle: vi.fn().mockResolvedValue(resolved),
    single:      vi.fn().mockResolvedValue(resolved),
  })

  const makeSelectChain = (data: unknown, error: unknown = null) => ({
    select: vi.fn().mockReturnValue({
      eq:     vi.fn().mockReturnValue({
        eq:  vi.fn().mockReturnValue({
          eq:          vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
          in:          vi.fn().mockResolvedValue({ data, error }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
        in:  vi.fn().mockResolvedValue({ data, error }),
        order: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
      in:     vi.fn().mockResolvedValue({ data, error }),
      order:  vi.fn().mockResolvedValue({ data, error }),
    }),
  })

  // Simple from() mock — overridden per-test
  const mockFrom = vi.fn()

  const mockServiceClient = { from: mockFrom }
  const mockCreateServiceClient = vi.fn().mockReturnValue(mockServiceClient)
  const mockEnsureGmailSource   = vi.fn()

  return {
    mockGetCurrentUser,
    mockGetConnectionStatus,
    mockHasGmailScope,
    mockFrom,
    mockServiceClient,
    mockCreateServiceClient,
    mockEnsureGmailSource,
    makeSingleChain,
    makeSelectChain,
  }
})

// ---- Module mocks -----------------------------------------------------------

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/google/auth', () => ({
  getGoogleConnectionStatus: mocks.mockGetConnectionStatus,
  hasGmailScope:             mocks.mockHasGmailScope,
  getGoogleOAuth2Client:     vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: mocks.mockCreateServiceClient,
  createClient:        vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/actions/tasks',       () => ({ createTask:      vi.fn() }))
vi.mock('@/lib/actions/waiting-ons', () => ({ createWaitingOn: vi.fn() }))
vi.mock('@/lib/google/gmail', () => ({
  listInboxMessages:  vi.fn(),
  getMessageFull:     vi.fn(),
  buildGmailDeepLink: vi.fn().mockReturnValue('https://mail.google.com/mail/#inbox/msg1'),
}))

import {
  batchGetEmailActionStatus,
  getMessageActions,
  linkEmailToEntity,
  unlinkEmailFromEntity,
} from '@/lib/actions/gmail'

// ---- Shared test user -------------------------------------------------------

const USER = { id: 'user-uuid-1', role: 'UM' }

// ---- batchGetEmailActionStatus ----------------------------------------------

describe('batchGetEmailActionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(USER)
    mocks.mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({
              data: [
                { external_id: 'msg1', entity_sources: [{ id: 'es-1' }] },
                { external_id: 'msg2', entity_sources: [] },
              ],
              error: null,
            }),
          }),
        }),
      }),
    }))
  })

  it('returns only messageIds that have at least one entity_sources row', async () => {
    const result = await batchGetEmailActionStatus(['msg1', 'msg2', 'msg3'])
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual(['msg1'])
  })

  it('returns empty array when called with no messageIds', async () => {
    const result = await batchGetEmailActionStatus([])
    expect(result.data).toEqual([])
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated callers', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await batchGetEmailActionStatus(['msg1'])
    expect(result.error).toBeTruthy()
  })
})

// ---- getMessageActions ------------------------------------------------------

describe('getMessageActions', () => {
  const SOURCE_ID = 'source-uuid-1'
  const ENTITY_SOURCE_ROWS = [
    { id: 'es-1', entity_type: 'project', entity_id: 'proj-1', relation: 'originated_from' },
    { id: 'es-2', entity_type: 'meeting', entity_id: 'mtg-1',  relation: 'related_to' },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(USER)
  })

  it('returns empty array when no source row exists for this user+message', async () => {
    mocks.mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }))
    const result = await getMessageActions('msg-no-source')
    expect(result.data).toEqual([])
  })

  it('returns EmailAction[] with labels resolved from correct tables', async () => {
    let callCount = 0
    mocks.mockFrom.mockImplementation((table: string) => {
      callCount++
      if (table === 'sources') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: { id: SOURCE_ID }, error: null }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'entity_sources') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: ENTITY_SOURCE_ROWS, error: null }),
            }),
          }),
        }
      }
      // Label tables
      if (table === 'projects') {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ data: [{ id: 'proj-1', title: 'Alpha' }], error: null }),
          }),
        }
      }
      if (table === 'meetings') {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ data: [{ id: 'mtg-1', title: 'Q3 Kickoff' }], error: null }),
          }),
        }
      }
      return { select: vi.fn().mockReturnValue({ in: vi.fn().mockResolvedValue({ data: [], error: null }) }) }
    })

    const result = await getMessageActions('msg1')
    expect(result.error).toBeUndefined()
    expect(result.data).toHaveLength(2)
    expect(result.data![0]).toMatchObject({ entityType: 'project', label: 'Alpha', relation: 'originated_from' })
    expect(result.data![1]).toMatchObject({ entityType: 'meeting', label: 'Q3 Kickoff', relation: 'related_to' })
  })

  it('rejects unauthenticated callers', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await getMessageActions('msg1')
    expect(result.error).toBeTruthy()
  })
})

// ---- linkEmailToEntity ------------------------------------------------------

describe('linkEmailToEntity', () => {
  const META = { subject: 'Test', from: 'a@b.com', date: '2026-01-01', threadId: 'thread-1' }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(USER)
    mocks.mockGetConnectionStatus.mockResolvedValue({
      connected: true, googleAccountEmail: 'user@gmail.com', scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    })
    mocks.mockHasGmailScope.mockReturnValue(true)
  })

  it('writes entity_sources with relation=related_to and returns entitySourceId', async () => {
    const mockUpsert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'es-new' }, error: null }) }),
    })

    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'sources') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'source-1' }, error: null }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'entity_sources') {
        return { upsert: mockUpsert }
      }
      return {}
    })

    const result = await linkEmailToEntity('msg1', META, 'project', 'proj-1')
    expect(result.error).toBeUndefined()
    expect(result.data?.entitySourceId).toBe('es-new')

    // Verify relation is 'related_to', not 'originated_from'
    const upsertArg = mockUpsert.mock.calls[0][0]
    expect(upsertArg.relation).toBe('related_to')
    expect(upsertArg.entity_type).toBe('project')
    expect(upsertArg.entity_id).toBe('proj-1')
  })

  it('rejects when Gmail is not connected', async () => {
    mocks.mockHasGmailScope.mockReturnValue(false)
    mocks.mockGetConnectionStatus.mockResolvedValue({ connected: false, scopes: [] })
    const result = await linkEmailToEntity('msg1', META, 'location', 'loc-1')
    expect(result.error).toBeTruthy()
  })

  it('rejects unauthenticated callers', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await linkEmailToEntity('msg1', META, 'meeting', 'mtg-1')
    expect(result.error).toBeTruthy()
  })
})

// ---- unlinkEmailFromEntity --------------------------------------------------

describe('unlinkEmailFromEntity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(USER)
  })

  it('removes a related_to row owned by the current user', async () => {
    const mockDelete = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    })

    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'entity_sources') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: 'es-1', relation: 'related_to', source_id: 'src-1' }, error: null,
              }),
            }),
          }),
          delete: mockDelete,
        }
      }
      if (table === 'sources') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { source_account_user_id: USER.id }, error: null,
              }),
            }),
          }),
        }
      }
      return {}
    })

    const result = await unlinkEmailFromEntity('es-1')
    expect(result.error).toBeUndefined()
    expect(mockDelete).toHaveBeenCalled()
  })

  it('rejects unlinking an originated_from row', async () => {
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'entity_sources') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: 'es-orig', relation: 'originated_from', source_id: 'src-1' }, error: null,
              }),
            }),
          }),
        }
      }
      return {}
    })

    const result = await unlinkEmailFromEntity('es-orig')
    expect(result.error).toMatch(/originated_from|task|waiting-on/i)
  })

  it('rejects when source belongs to a different user', async () => {
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'entity_sources') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: 'es-1', relation: 'related_to', source_id: 'src-1' }, error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'sources') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { source_account_user_id: 'other-user-uuid' }, error: null,
              }),
            }),
          }),
        }
      }
      return {}
    })

    const result = await unlinkEmailFromEntity('es-1')
    expect(result.error).toMatch(/not authorised/i)
  })

  it('rejects unauthenticated callers', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await unlinkEmailFromEntity('es-1')
    expect(result.error).toBeTruthy()
  })
})
