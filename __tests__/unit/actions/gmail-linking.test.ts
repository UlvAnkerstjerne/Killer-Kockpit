/**
 * M7C: Tests for the email → entity linking functions in lib/actions/gmail.ts
 *
 * Verifies:
 *   - batchGetEmailActionStatus returns only actioned messageIds (mailbox-scoped)
 *   - getMessageActions returns EmailAction[] with labels; cannot read another user's source
 *   - linkEmailToEntity: role guard, entity existence check, relation='related_to', idempotent
 *   - linkEmailToEntity: MEMBER rejected, manipulated entity ID rejected, cross-user source blocked
 *   - unlinkEmailFromEntity: rejects originated_from rows; rejects cross-user ownership
 *   - All actions reject unauthenticated callers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser       = vi.fn()
  const mockGetConnectionStatus  = vi.fn()
  const mockHasGmailScope        = vi.fn()
  const mockCanUseGmailInbox     = vi.fn()
  const mockFrom                 = vi.fn()
  const mockServiceClient        = { from: mockFrom }
  const mockCreateServiceClient  = vi.fn().mockReturnValue(mockServiceClient)

  return {
    mockGetCurrentUser,
    mockGetConnectionStatus,
    mockHasGmailScope,
    mockCanUseGmailInbox,
    mockFrom,
    mockServiceClient,
    mockCreateServiceClient,
  }
})

// ---- Module mocks -----------------------------------------------------------

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/google/auth', () => ({
  getGoogleConnectionStatus: mocks.mockGetConnectionStatus,
  hasGmailScope:             mocks.mockHasGmailScope,
  getGoogleOAuth2Client:     vi.fn(),
}))
vi.mock('@/lib/permissions', () => ({
  canUseGmailInbox: mocks.mockCanUseGmailInbox,
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: mocks.mockCreateServiceClient,
  createClient:        vi.fn(),
}))
vi.mock('next/cache',              () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/actions/tasks',     () => ({ createTask:      vi.fn() }))
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

// ---- Shared test users -------------------------------------------------------

const MGMT_USER   = { id: 'user-mgmt',  role: 'UM' as const }
const MEMBER_USER = { id: 'user-member', role: 'MEMBER' as const }

const CONNECTED_STATUS = {
  connected: true,
  googleAccountEmail: 'user@gmail.com',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
}
const META = { subject: 'Test', from: 'a@b.com', date: '2026-01-01', threadId: 'thread-1' }

// ---- batchGetEmailActionStatus ----------------------------------------------

describe('batchGetEmailActionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(MGMT_USER)
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

  it('returns only messageIds with at least one entity_sources row', async () => {
    const result = await batchGetEmailActionStatus(['msg1', 'msg2', 'msg3'])
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual(['msg1'])
  })

  it('returns empty array when called with no messageIds (no DB query)', async () => {
    const result = await batchGetEmailActionStatus([])
    expect(result.data).toEqual([])
  })

  it('rejects unauthenticated callers', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await batchGetEmailActionStatus(['msg1'])
    expect(result.error).toBeTruthy()
  })

  it('cannot expose another mailbox — source_account_user_id is always current user', async () => {
    // The query always includes .eq('source_account_user_id', user.id)
    // Verify the eq chain is called with the authenticated user's id
    let capturedEqArgs: string[] = []
    mocks.mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation((col: string, val: string) => {
          capturedEqArgs.push(`${col}=${val}`)
          return {
            eq: vi.fn().mockImplementation((col2: string, val2: string) => {
              capturedEqArgs.push(`${col2}=${val2}`)
              return {
                in: vi.fn().mockResolvedValue({ data: [], error: null }),
              }
            }),
          }
        }),
      }),
    }))
    await batchGetEmailActionStatus(['msg1'])
    expect(capturedEqArgs).toContain(`source_account_user_id=${MGMT_USER.id}`)
    // Must NOT contain any other user's id
    expect(capturedEqArgs).not.toContain(`source_account_user_id=other-user`)
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
    mocks.mockGetCurrentUser.mockResolvedValue(MGMT_USER)
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
    mocks.mockFrom.mockImplementation((table: string) => {
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

  it('cannot read another user\'s Gmail source — source lookup scoped to current user', async () => {
    let capturedEqArgs: string[] = []
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'sources') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockImplementation((col: string, val: string) => {
              capturedEqArgs.push(`${col}=${val}`)
              return {
                eq: vi.fn().mockImplementation((col2: string, val2: string) => {
                  capturedEqArgs.push(`${col2}=${val2}`)
                  return {
                    eq: vi.fn().mockImplementation((col3: string, val3: string) => {
                      capturedEqArgs.push(`${col3}=${val3}`)
                      return { maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }
                    }),
                  }
                }),
              }
            }),
          }),
        }
      }
      return {}
    })
    await getMessageActions('some-message-id')
    expect(capturedEqArgs).toContain(`source_account_user_id=${MGMT_USER.id}`)
  })

  it('rejects unauthenticated callers', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await getMessageActions('msg1')
    expect(result.error).toBeTruthy()
  })
})

// ---- linkEmailToEntity ------------------------------------------------------

describe('linkEmailToEntity', () => {
  function makeEntityExistsFromMock(entityTable: string) {
    return (table: string) => {
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
      if (table === entityTable) {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'entity-id' }, error: null }),
            }),
          }),
        }
      }
      if (table === 'entity_sources') {
        return {
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'es-new' }, error: null }),
            }),
          }),
        }
      }
      return {}
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(MGMT_USER)
    mocks.mockCanUseGmailInbox.mockReturnValue(true)
    mocks.mockGetConnectionStatus.mockResolvedValue(CONNECTED_STATUS)
    mocks.mockHasGmailScope.mockReturnValue(true)
  })

  it('writes entity_sources with relation=related_to and returns entitySourceId', async () => {
    const mockUpsert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'es-new' }, error: null }) }),
    })
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'projects') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'proj-1' }, error: null }) }),
          }),
        }
      }
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
      if (table === 'entity_sources') return { upsert: mockUpsert }
      return {}
    })

    const result = await linkEmailToEntity('msg1', META, 'project', 'proj-1')
    expect(result.error).toBeUndefined()
    expect(result.data?.entitySourceId).toBe('es-new')

    const upsertArg = mockUpsert.mock.calls[0][0]
    expect(upsertArg.relation).toBe('related_to')
    expect(upsertArg.entity_type).toBe('project')
    expect(upsertArg.entity_id).toBe('proj-1')
  })

  it('rejects MEMBER role — canUseGmailInbox guard enforced server-side', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockCanUseGmailInbox.mockReturnValue(false)
    const result = await linkEmailToEntity('msg1', META, 'project', 'proj-1')
    expect(result.error).toMatch(/not authorised/i)
  })

  it('rejects a manipulated project ID that does not exist', async () => {
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'projects') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
          }),
        }
      }
      return {}
    })
    const result = await linkEmailToEntity('msg1', META, 'project', 'nonexistent-uuid')
    expect(result.error).toMatch(/not found/i)
  })

  it('rejects a manipulated meeting ID that does not exist', async () => {
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'meetings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
          }),
        }
      }
      return {}
    })
    const result = await linkEmailToEntity('msg1', META, 'meeting', 'nonexistent-uuid')
    expect(result.error).toMatch(/not found/i)
  })

  it('rejects a manipulated employee ID that does not exist', async () => {
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'employees') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
          }),
        }
      }
      return {}
    })
    const result = await linkEmailToEntity('msg1', META, 'employee', 'nonexistent-uuid')
    expect(result.error).toMatch(/not found/i)
  })

  it('rejects a manipulated location ID that does not exist', async () => {
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'locations') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
          }),
        }
      }
      return {}
    })
    const result = await linkEmailToEntity('msg1', META, 'location', 'nonexistent-uuid')
    expect(result.error).toMatch(/not found/i)
  })

  it('link cannot hijack another user\'s Gmail source — source_account_user_id derived server-side', async () => {
    // The ensureGmailSource call always uses user.id from getCurrentUser(), never client input.
    // We verify the sources select always includes source_account_user_id = MGMT_USER.id
    let capturedEqArgs: string[] = []
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'projects') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'proj-1' }, error: null }) }),
          }),
        }
      }
      if (table === 'sources') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockImplementation((col: string, val: string) => {
              capturedEqArgs.push(`${col}=${val}`)
              return {
                eq: vi.fn().mockImplementation((col2: string, val2: string) => {
                  capturedEqArgs.push(`${col2}=${val2}`)
                  return {
                    eq: vi.fn().mockImplementation((col3: string, val3: string) => {
                      capturedEqArgs.push(`${col3}=${val3}`)
                      return { maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }
                    }),
                  }
                }),
              }
            }),
          }),
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'src-new' }, error: null }) }),
          }),
        }
      }
      if (table === 'entity_sources') {
        return {
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'es-new' }, error: null }) }),
          }),
        }
      }
      return {}
    })

    await linkEmailToEntity('msg1', META, 'project', 'proj-1')
    // source_account_user_id must always equal the authenticated user's id
    expect(capturedEqArgs).toContain(`source_account_user_id=${MGMT_USER.id}`)
  })

  it('duplicate link is idempotent — ignoreDuplicates prevents error on repeat call', async () => {
    const mockUpsert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'es-existing' }, error: null }) }),
    })
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'projects') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'proj-1' }, error: null }) }),
          }),
        }
      }
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
      if (table === 'entity_sources') return { upsert: mockUpsert }
      return {}
    })

    // Call twice — should succeed both times with same entity
    await linkEmailToEntity('msg1', META, 'project', 'proj-1')
    const result2 = await linkEmailToEntity('msg1', META, 'project', 'proj-1')
    expect(result2.error).toBeUndefined()
    // Verify ignoreDuplicates option is set
    const upsertOpts = mockUpsert.mock.calls[0][1]
    expect(upsertOpts.ignoreDuplicates).toBe(true)
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
    mocks.mockGetCurrentUser.mockResolvedValue(MGMT_USER)
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
                data: { source_account_user_id: MGMT_USER.id }, error: null,
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

  it('rejects unlinking an originated_from row (task/WO creation is permanent)', async () => {
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

  it('rejects when source belongs to a different user (cross-user ownership check)', async () => {
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
