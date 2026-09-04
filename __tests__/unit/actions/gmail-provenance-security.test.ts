/**
 * Security tests for getEntityGmailSources in lib/actions/gmail.ts
 *
 * Verifies:
 *   1.  Unauthenticated callers are rejected.
 *   2.  Non-management roles are blocked from employee sources.
 *   3.  Non-management roles are blocked from location sources.
 *   4.  Entity access is gated via the user's RLS-enforced client (not service client).
 *   5.  Entity not found via user client returns empty array (no metadata leak).
 *   6.  gmailUrl is returned only when current user === source owner (owner sees link).
 *   7.  gmailUrl is null for non-owners (viewer cannot follow deep link into another user's mailbox).
 *   8.  Non-gmail source types are filtered out from results.
 *   9.  Sources with no source_account_user_id are filtered out.
 *  10.  Batch user name lookup uses a single query (no N+1).
 *  11.  capturedByName falls back to 'Unknown' when user is not in app_users.
 *  12.  SUPER_ADMIN can read employee provenance.
 *  13.  UM can read project provenance.
 *  14.  MEMBER is blocked from employee provenance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()

  // User-JWT client: used for entity access verification.
  // Chainable: .from(table).select('id').eq('id', id).maybeSingle()
  const mockUserMaybySingle = vi.fn()
  const mockUserClientFrom = vi.fn().mockImplementation(() => ({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: mockUserMaybySingle,
      }),
    }),
  }))
  const mockUserClient = { from: mockUserClientFrom }
  const mockCreateClient = vi.fn().mockResolvedValue(mockUserClient)

  // Service client: used for sources + entity_sources + app_users queries.
  // entity_sources: .from('entity_sources').select(...).eq(...).eq(...)
  const mockEntitySourcesResult = vi.fn()
  // app_users: .from('app_users').select(...).in(...)
  const mockAppUsersResult = vi.fn()

  const mockServiceFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'entity_sources') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue(mockEntitySourcesResult()),
          }),
        }),
      }
    }
    if (table === 'app_users') {
      return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue(mockAppUsersResult()),
        }),
      }
    }
    throw new Error(`Unexpected table in service client: ${table}`)
  })
  const mockServiceClient = { from: mockServiceFrom }
  const mockCreateServiceClient = vi.fn().mockReturnValue(mockServiceClient)

  return {
    mockGetCurrentUser,
    mockUserMaybySingle,
    mockUserClientFrom,
    mockCreateClient,
    mockEntitySourcesResult,
    mockAppUsersResult,
    mockServiceFrom,
    mockCreateServiceClient,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/supabase/server', () => ({
  createClient:        mocks.mockCreateClient,
  createServiceClient: mocks.mockCreateServiceClient,
}))
// Silence server-only restrictions inside lib/actions/gmail.ts
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/google/auth', () => ({
  getGoogleOAuth2Client:     vi.fn(),
  getGoogleConnectionStatus: vi.fn(),
  hasGmailScope:             vi.fn().mockReturnValue(true),
}))
vi.mock('@/lib/google/gmail', () => ({
  listInboxMessages:  vi.fn(),
  getMessageFull:     vi.fn(),
  buildGmailDeepLink: vi.fn(),
}))
vi.mock('@/lib/actions/tasks',       () => ({ createTask:      vi.fn() }))
vi.mock('@/lib/actions/waiting-ons', () => ({ createWaitingOn: vi.fn() }))

// ---- Fixtures ----------------------------------------------------------------

const SUPER_ADMIN = { id: 'admin-id', role: 'SUPER_ADMIN' as const, display_name: 'Admin', email: 'a@kk.com', active: true }
const UM_USER     = { id: 'um-id',    role: 'UM'          as const, display_name: 'Mgr',   email: 'm@kk.com', active: true }
const MEMBER      = { id: 'mbr-id',   role: 'MEMBER'      as const, display_name: 'Emp',   email: 'e@kk.com', active: true }

const ENTITY_ID   = 'entity-uuid-1'
const SOURCE_ID   = 'source-uuid-1'
const ES_ID       = 'es-uuid-1'
const OWNER_ID    = 'admin-id'       // matches SUPER_ADMIN.id
const OTHER_ID    = 'other-user-id'  // does NOT match viewer

function makeGmailLink(overrides: Partial<{
  esId: string; sourceId: string; ownerId: string; url: string | null; sourceType: string
}> = {}) {
  const {
    esId       = ES_ID,
    sourceId   = SOURCE_ID,
    ownerId    = OWNER_ID,
    url        = 'https://mail.google.com/mail/?authuser=a%40kk.com#all/msg1',
    sourceType = 'gmail_message',
  } = overrides
  return {
    id:       esId,
    relation: 'related_to',
    source:   {
      id:                     sourceId,
      source_type:            sourceType,
      title:                  'Subject: quarterly report',
      url,
      metadata:               { from: 'sender@example.com' },
      occurred_at:            '2026-09-01T09:00:00Z',
      source_account_user_id: ownerId,
    },
  }
}

function makeAppUser(id: string, display_name: string) {
  return { id, display_name }
}

// ---- Import (after mocks) ----------------------------------------------------

import { getEntityGmailSources } from '@/lib/actions/gmail'

// ---- Tests -------------------------------------------------------------------

describe('getEntityGmailSources — authentication', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('rejects unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)

    const result = await getEntityGmailSources('project', ENTITY_ID)

    expect(result.error).toBe('Not authenticated')
    expect(mocks.mockCreateClient).not.toHaveBeenCalled()
    expect(mocks.mockCreateServiceClient).not.toHaveBeenCalled()
  })
})

describe('getEntityGmailSources — role guards', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('blocks MEMBER from reading employee provenance', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)

    const result = await getEntityGmailSources('employee', ENTITY_ID)

    expect(result.error).toBe('Not authorised')
    expect(mocks.mockCreateClient).not.toHaveBeenCalled()
  })

  it('blocks MEMBER from reading location provenance', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)

    const result = await getEntityGmailSources('location', ENTITY_ID)

    expect(result.error).toBe('Not authorised')
    expect(mocks.mockCreateClient).not.toHaveBeenCalled()
  })

  it('allows SUPER_ADMIN to read employee provenance (role check passes)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockUserMaybySingle.mockResolvedValue({ data: { id: ENTITY_ID } })
    mocks.mockEntitySourcesResult.mockReturnValue({ data: [], error: null })
    mocks.mockAppUsersResult.mockReturnValue({ data: [] })

    const result = await getEntityGmailSources('employee', ENTITY_ID)

    expect(result.error).toBeUndefined()
  })

  it('allows UM to read project provenance (no role guard on projects)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockUserMaybySingle.mockResolvedValue({ data: { id: ENTITY_ID } })
    mocks.mockEntitySourcesResult.mockReturnValue({ data: [], error: null })
    mocks.mockAppUsersResult.mockReturnValue({ data: [] })

    const result = await getEntityGmailSources('project', ENTITY_ID)

    expect(result.error).toBeUndefined()
  })
})

describe('getEntityGmailSources — entity access gate', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('uses the user-JWT client (not service client) to verify entity access', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockUserMaybySingle.mockResolvedValue({ data: { id: ENTITY_ID } })
    mocks.mockEntitySourcesResult.mockReturnValue({ data: [], error: null })
    mocks.mockAppUsersResult.mockReturnValue({ data: [] })

    await getEntityGmailSources('project', ENTITY_ID)

    // Entity lookup must go through the RLS-enforced user client
    expect(mocks.mockUserClientFrom).toHaveBeenCalledWith('projects')
  })

  it('returns empty array (no error) when entity is not visible to the user', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    // Simulates RLS returning null — entity not found / not accessible
    mocks.mockUserMaybySingle.mockResolvedValue({ data: null })

    const result = await getEntityGmailSources('project', ENTITY_ID)

    expect(result.error).toBeUndefined()
    expect(result.data).toEqual([])
    // Service client must NOT be called — no metadata should leak
    expect(mocks.mockServiceFrom).not.toHaveBeenCalled()
  })
})

describe('getEntityGmailSources — owner-aware gmailUrl', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns gmailUrl for the source owner', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)  // SUPER_ADMIN.id === OWNER_ID
    mocks.mockUserMaybySingle.mockResolvedValue({ data: { id: ENTITY_ID } })
    mocks.mockEntitySourcesResult.mockReturnValue({
      data: [makeGmailLink({ ownerId: OWNER_ID })],
      error: null,
    })
    mocks.mockAppUsersResult.mockReturnValue({
      data: [makeAppUser(OWNER_ID, 'Admin')],
    })

    const result = await getEntityGmailSources('project', ENTITY_ID)

    expect(result.error).toBeUndefined()
    expect(result.data).toHaveLength(1)
    // Owner sees the deep link
    expect(result.data![0].gmailUrl).toBeTruthy()
    expect(result.data![0].gmailUrl).toContain('mail.google.com')
  })

  it('returns null gmailUrl for a non-owner viewer', async () => {
    // UM_USER views a source owned by OWNER_ID (different user)
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockUserMaybySingle.mockResolvedValue({ data: { id: ENTITY_ID } })
    mocks.mockEntitySourcesResult.mockReturnValue({
      data: [makeGmailLink({ ownerId: OWNER_ID })],  // owned by admin-id, not um-id
      error: null,
    })
    mocks.mockAppUsersResult.mockReturnValue({
      data: [makeAppUser(OWNER_ID, 'Admin')],
    })

    const result = await getEntityGmailSources('project', ENTITY_ID)

    expect(result.error).toBeUndefined()
    expect(result.data).toHaveLength(1)
    // Non-owner never gets the deep link
    expect(result.data![0].gmailUrl).toBeNull()
  })

  it('gmailUrl is null for non-owner even when source.url is present', async () => {
    // Explicit: the source row has a url, but the viewer is not the owner
    const deepLink = 'https://mail.google.com/mail/?authuser=owner%40kk.com#all/msg999'
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockUserMaybySingle.mockResolvedValue({ data: { id: ENTITY_ID } })
    mocks.mockEntitySourcesResult.mockReturnValue({
      data: [makeGmailLink({ ownerId: OWNER_ID, url: deepLink })],
      error: null,
    })
    mocks.mockAppUsersResult.mockReturnValue({
      data: [makeAppUser(OWNER_ID, 'Admin')],
    })

    const result = await getEntityGmailSources('project', ENTITY_ID)

    // The raw URL must NOT appear in any returned entry for a non-owner
    const entry = result.data![0]
    expect(entry.gmailUrl).toBeNull()
    // Sanity: no other field on the entry should contain the deep link
    const serialised = JSON.stringify(entry)
    expect(serialised).not.toContain(deepLink)
  })
})

describe('getEntityGmailSources — source type filtering', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('filters out non-gmail source types', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockUserMaybySingle.mockResolvedValue({ data: { id: ENTITY_ID } })
    mocks.mockEntitySourcesResult.mockReturnValue({
      data: [
        makeGmailLink({ esId: 'es-1', sourceType: 'gmail_message' }),
        makeGmailLink({ esId: 'es-2', sourceType: 'google_drive_file' }),
        makeGmailLink({ esId: 'es-3', sourceType: 'unknown_type' }),
      ],
      error: null,
    })
    mocks.mockAppUsersResult.mockReturnValue({
      data: [makeAppUser(OWNER_ID, 'Admin')],
    })

    const result = await getEntityGmailSources('project', ENTITY_ID)

    expect(result.data).toHaveLength(1)
    expect(result.data![0].entitySourceId).toBe('es-1')
  })

  it('filters out sources with null source_account_user_id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockUserMaybySingle.mockResolvedValue({ data: { id: ENTITY_ID } })
    mocks.mockEntitySourcesResult.mockReturnValue({
      data: [
        // null source_account_user_id — should be filtered
        {
          id:       'es-null',
          relation: 'related_to',
          source:   { id: 'src-null', source_type: 'gmail_message', title: 'Sub', url: null, metadata: null, occurred_at: null, source_account_user_id: null },
        },
        makeGmailLink({ esId: 'es-valid', ownerId: OWNER_ID }),
      ],
      error: null,
    })
    mocks.mockAppUsersResult.mockReturnValue({
      data: [makeAppUser(OWNER_ID, 'Admin')],
    })

    const result = await getEntityGmailSources('project', ENTITY_ID)

    expect(result.data).toHaveLength(1)
    expect(result.data![0].entitySourceId).toBe('es-valid')
  })
})

describe('getEntityGmailSources — batch user lookup', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('performs a single app_users query regardless of number of sources', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockUserMaybySingle.mockResolvedValue({ data: { id: ENTITY_ID } })

    const links = [
      makeGmailLink({ esId: 'es-1', ownerId: 'user-a' }),
      makeGmailLink({ esId: 'es-2', ownerId: 'user-b' }),
      makeGmailLink({ esId: 'es-3', ownerId: 'user-a' }),  // duplicate — should be deduped
    ]
    mocks.mockEntitySourcesResult.mockReturnValue({ data: links, error: null })
    mocks.mockAppUsersResult.mockReturnValue({
      data: [makeAppUser('user-a', 'Alice'), makeAppUser('user-b', 'Bob')],
    })

    await getEntityGmailSources('project', ENTITY_ID)

    // app_users must be queried exactly once
    const appUsersCalls = mocks.mockServiceFrom.mock.calls.filter((args: unknown[]) => args[0] === 'app_users')
    expect(appUsersCalls).toHaveLength(1)
  })

  it("falls back capturedByName to 'Unknown' when user is not in app_users", async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockUserMaybySingle.mockResolvedValue({ data: { id: ENTITY_ID } })
    mocks.mockEntitySourcesResult.mockReturnValue({
      data: [makeGmailLink({ ownerId: 'ghost-user-id' })],
      error: null,
    })
    // app_users returns empty — ghost-user-id is not found
    mocks.mockAppUsersResult.mockReturnValue({ data: [] })

    const result = await getEntityGmailSources('project', ENTITY_ID)

    expect(result.data).toHaveLength(1)
    expect(result.data![0].capturedByName).toBe('Unknown')
  })
})

describe('getEntityGmailSources — safe fields', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returned entries contain only safe metadata fields', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockUserMaybySingle.mockResolvedValue({ data: { id: ENTITY_ID } })
    mocks.mockEntitySourcesResult.mockReturnValue({
      data: [makeGmailLink({ ownerId: OWNER_ID })],
      error: null,
    })
    mocks.mockAppUsersResult.mockReturnValue({
      data: [makeAppUser(OWNER_ID, 'Admin')],
    })

    const result = await getEntityGmailSources('project', ENTITY_ID)

    const entry = result.data![0]
    const keys  = Object.keys(entry)

    // Required safe fields
    expect(keys).toContain('entitySourceId')
    expect(keys).toContain('sourceId')
    expect(keys).toContain('relation')
    expect(keys).toContain('subject')
    expect(keys).toContain('sender')
    expect(keys).toContain('occurredAt')
    expect(keys).toContain('capturedById')
    expect(keys).toContain('capturedByName')
    expect(keys).toContain('gmailUrl')

    // Sensitive fields must not be present
    expect(keys).not.toContain('body')
    expect(keys).not.toContain('token')
    expect(keys).not.toContain('refresh_token')
    expect(keys).not.toContain('access_token')
    expect(keys).not.toContain('metadata')  // raw metadata object must not be exposed
  })
})
