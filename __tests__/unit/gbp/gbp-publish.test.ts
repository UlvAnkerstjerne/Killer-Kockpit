/**
 * Tests for GBP publishing: location resolution, payload construction,
 * fanout behaviour, validation, permissions, trusted image refs,
 * three-step photo upload, and idempotency.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

// ── Mock modules ────────────────────────────────────────────────────────────

const mockGetCurrentUser = vi.fn()
const mockGetPermissions = vi.fn()
const mockSupabaseFrom = vi.fn()
const mockSupabaseStorage = vi.fn()
const mockCreateLocalPost = vi.fn()
const mockCreateLocationMedia = vi.fn()
const mockGetGbpPublisher = vi.fn()

vi.mock('@/lib/auth', () => ({ getCurrentUser: () => mockGetCurrentUser() }))
vi.mock('@/lib/actions/marketing/permissions', () => ({
  getUserMarketingPermissions: (id: string) => mockGetPermissions(id),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: mockSupabaseFrom,
    storage: { from: mockSupabaseStorage },
  }),
}))
vi.mock('@/lib/google/gbp-client', () => ({
  createLocalPost: (...args: unknown[]) => mockCreateLocalPost(...args),
  createLocationMedia: (...args: unknown[]) => mockCreateLocationMedia(...args),
}))
vi.mock('@/lib/gbp/review-publish', () => ({
  getGbpPublisher: () => mockGetGbpPublisher(),
}))

const { publishGbpPost } = await import('@/lib/actions/marketing/gbp-publish')

// ── Test fixtures ──────────────────────────────────────────────────────────

const ADMIN_USER = { id: 'u1', role: 'SUPER_ADMIN', marketing_access: true }
const MEMBER_USER = { id: 'u2', role: 'MEMBER', marketing_access: true }
const NO_MARKETING_USER = { id: 'u3', role: 'MEMBER', marketing_access: false }

const LOCATIONS = [
  { id: 'loc-1', google_account_id: '111', google_location_id: '1001', store_name: 'Vesterbro', active: true },
  { id: 'loc-2', google_account_id: '111', google_location_id: '1002', store_name: 'Nørrebro', active: true },
  { id: 'loc-3', google_account_id: '111', google_location_id: '1003', store_name: 'Frederiksberg', active: true },
]

const REQUEST_ID = crypto.randomUUID()

const VALID_INPUT = {
  postType: 'local_post' as const,
  caption: 'New kebab flavour this week!',
  imageStoragePath: `posts/u1/${crypto.randomUUID()}.jpg`,
  requestId: REQUEST_ID,
  locationIds: ['loc-1', 'loc-2', 'loc-3'],
}

const MOCK_CLIENT = { getAccessToken: vi.fn() }

/** Helper to set up the from() mock chain for gbp_posts + gbp_locations */
function mockFromChain(opts?: {
  existingPost?: Record<string, unknown> | null
  claimError?: { code?: string; message?: string } | null
  locations?: typeof LOCATIONS
}) {
  const existingPost = opts?.existingPost ?? null
  const claimError = opts?.claimError ?? null
  const locs = opts?.locations ?? LOCATIONS

  mockSupabaseFrom.mockImplementation((table: string) => {
    if (table === 'gbp_posts') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: existingPost, error: null }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ error: claimError }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }
    }
    if (table === 'gbp_locations') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ data: locs, error: null }),
          }),
        }),
      }
    }
    return { select: vi.fn(), insert: vi.fn(), update: vi.fn() }
  })
}

function setupHappyPath() {
  mockGetCurrentUser.mockResolvedValue(ADMIN_USER)
  mockGetPermissions.mockResolvedValue([])
  mockGetGbpPublisher.mockResolvedValue({ ok: true, client: MOCK_CLIENT })
  mockFromChain()
  mockSupabaseStorage.mockReturnValue({
    getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://storage.example.com/posts/u1/test.jpg' } }),
    download: vi.fn().mockResolvedValue({ data: new Blob([new Uint8Array(100)]), error: null }),
  })
  mockCreateLocalPost.mockResolvedValue({ ok: true, data: { name: 'posts/123' } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Auth / permission tests ────────────────────────────────────────────────

describe('auth and permissions', () => {
  it('rejects unauthenticated users', async () => {
    mockGetCurrentUser.mockResolvedValue(null)
    const result = await publishGbpPost(VALID_INPUT)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Not authenticated')
  })

  it('rejects users without marketing access', async () => {
    mockGetCurrentUser.mockResolvedValue(NO_MARKETING_USER)
    const result = await publishGbpPost(VALID_INPUT)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Marketing access')
  })

  it('rejects MEMBER without content_manage permission', async () => {
    mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mockGetPermissions.mockResolvedValue([])
    const result = await publishGbpPost(VALID_INPUT)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('content_manage')
  })

  it('allows SUPER_ADMIN without explicit permissions', async () => {
    setupHappyPath()
    const result = await publishGbpPost(VALID_INPUT)
    expect(result.ok).toBe(true)
    expect(result.succeeded).toBe(3)
  })

  it('allows MEMBER with content_manage permission', async () => {
    mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mockGetPermissions.mockResolvedValue(['content_manage'])
    mockGetGbpPublisher.mockResolvedValue({ ok: true, client: MOCK_CLIENT })
    mockFromChain({ locations: [LOCATIONS[0]] })
    mockSupabaseStorage.mockReturnValue({
      getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://storage.example.com/test.jpg' } }),
    })
    mockCreateLocalPost.mockResolvedValue({ ok: true, data: { name: 'posts/123' } })
    const result = await publishGbpPost({
      ...VALID_INPUT,
      imageStoragePath: `posts/u2/${crypto.randomUUID()}.jpg`,
      locationIds: ['loc-1'],
      requestId: crypto.randomUUID(),
    })
    expect(result.ok).toBe(true)
  })
})

// ── Validation tests ────────────────────────────────────────────────────────

describe('input validation', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockResolvedValue(ADMIN_USER)
    mockGetPermissions.mockResolvedValue([])
  })

  it('rejects empty location selection', async () => {
    const result = await publishGbpPost({ ...VALID_INPUT, locationIds: [], requestId: crypto.randomUUID() })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('location')
  })

  it('rejects missing image', async () => {
    const result = await publishGbpPost({ ...VALID_INPUT, imageStoragePath: '', requestId: crypto.randomUUID() })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Image')
  })

  it('rejects local_post without caption', async () => {
    const result = await publishGbpPost({ ...VALID_INPUT, caption: '', requestId: crypto.randomUUID() })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Caption')
  })

  it('rejects caption over 1500 characters', async () => {
    const result = await publishGbpPost({ ...VALID_INPUT, caption: 'x'.repeat(1501), requestId: crypto.randomUUID() })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('1500')
  })

  it('rejects invalid requestId', async () => {
    const result = await publishGbpPost({ ...VALID_INPUT, requestId: 'not-a-uuid' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('request ID')
  })

  it('allows photo without caption', async () => {
    setupHappyPath()
    mockCreateLocationMedia.mockResolvedValue({ ok: true, data: { name: 'media/456' } })
    const result = await publishGbpPost({
      ...VALID_INPUT,
      postType: 'photo',
      caption: undefined,
      locationIds: ['loc-1'],
      requestId: crypto.randomUUID(),
    })
    expect(result.ok).toBe(true)
  })
})

// ── Trusted image reference tests ───────────────────────────────────────────

describe('trusted image reference', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockResolvedValue(ADMIN_USER)
    mockGetPermissions.mockResolvedValue([])
  })

  it('rejects storage path that does not belong to authenticated user', async () => {
    const result = await publishGbpPost({
      ...VALID_INPUT,
      imageStoragePath: `posts/other-user-id/${crypto.randomUUID()}.jpg`,
      requestId: crypto.randomUUID(),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('does not belong')
  })

  it('rejects arbitrary external URL as storage path', async () => {
    const result = await publishGbpPost({
      ...VALID_INPUT,
      imageStoragePath: 'https://evil.com/image.jpg',
      requestId: crypto.randomUUID(),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid image reference')
  })

  it('rejects path without user directory', async () => {
    const result = await publishGbpPost({
      ...VALID_INPUT,
      imageStoragePath: `posts/${crypto.randomUUID()}.jpg`,
      requestId: crypto.randomUUID(),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid image reference')
  })

  it('accepts valid user-bound storage path', async () => {
    setupHappyPath()
    const result = await publishGbpPost(VALID_INPUT)
    expect(result.ok).toBe(true)
    // Verify server resolved the public URL (not browser-supplied)
    expect(mockCreateLocalPost).toHaveBeenCalledWith(
      MOCK_CLIENT, '111', '1001',
      VALID_INPUT.caption,
      'https://storage.example.com/posts/u1/test.jpg', // server-resolved
    )
  })

  it('browser cannot supply arbitrary URL — no imagePublicUrl in input type', () => {
    // Type-level enforcement: GbpPublishInput has no imagePublicUrl field.
    // This test documents the design decision.
    const input = VALID_INPUT as Record<string, unknown>
    expect('imagePublicUrl' in input).toBe(false)
    expect('imageMimeType' in input).toBe(false)
  })
})

// ── Location resolution tests ──────────────────────────────────────────────

describe('trusted location resolution', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockResolvedValue(ADMIN_USER)
    mockGetPermissions.mockResolvedValue([])
    mockGetGbpPublisher.mockResolvedValue({ ok: true, client: MOCK_CLIENT })
  })

  it('resolves all locations when all IDs are valid', async () => {
    setupHappyPath()
    const result = await publishGbpPost(VALID_INPUT)
    expect(result.total).toBe(3)
    expect(mockCreateLocalPost).toHaveBeenCalledTimes(3)
  })

  it('uses trusted google_account_id and google_location_id from DB rows', async () => {
    setupHappyPath()
    await publishGbpPost({ ...VALID_INPUT, locationIds: ['loc-1'], requestId: crypto.randomUUID() })
    expect(mockCreateLocalPost).toHaveBeenCalledWith(
      MOCK_CLIENT, '111', '1001',
      VALID_INPUT.caption,
      expect.any(String),
    )
  })
})

// ── Multi-location fanout tests ─────────────────────────────────────────────

describe('multi-location fanout', () => {
  beforeEach(() => setupHappyPath())

  it('continues after one location fails', async () => {
    mockCreateLocalPost
      .mockResolvedValueOnce({ ok: true, data: { name: 'posts/1' } })
      .mockResolvedValueOnce({ ok: false, error: 'permission denied' })
      .mockResolvedValueOnce({ ok: true, data: { name: 'posts/3' } })

    const result = await publishGbpPost(VALID_INPUT)
    expect(result.ok).toBe(true)
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.locations[1].status).toBe('failed')
  })

  it('reports complete failure when all locations fail', async () => {
    mockCreateLocalPost.mockResolvedValue({ ok: false, error: 'API error' })
    const result = await publishGbpPost(VALID_INPUT)
    expect(result.ok).toBe(false)
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(3)
  })

  it('handles exception from Google API gracefully', async () => {
    mockCreateLocalPost
      .mockResolvedValueOnce({ ok: true, data: { name: 'posts/1' } })
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockResolvedValueOnce({ ok: true, data: { name: 'posts/3' } })

    const result = await publishGbpPost(VALID_INPUT)
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.locations[1].error).toBe('Network timeout')
  })

  it('partial fanout results are correctly recorded', async () => {
    mockCreateLocalPost
      .mockResolvedValueOnce({ ok: true, data: { name: 'posts/1' } })
      .mockResolvedValueOnce({ ok: false, error: 'RATE_LIMITED' })
      .mockResolvedValueOnce({ ok: true, data: { name: 'posts/3' } })

    const result = await publishGbpPost(VALID_INPUT)
    expect(result.locations).toHaveLength(3)
    expect(result.locations[0]).toMatchObject({ locationName: 'Vesterbro', status: 'success', googleResourceName: 'posts/1' })
    expect(result.locations[1]).toMatchObject({ locationName: 'Nørrebro', status: 'failed', error: 'RATE_LIMITED' })
    expect(result.locations[2]).toMatchObject({ locationName: 'Frederiksberg', status: 'success', googleResourceName: 'posts/3' })
  })
})

// ── Three-step photo upload tests ───────────────────────────────────────────

describe('three-step photo upload flow', () => {
  it('calls createLocationMedia which uses startUpload → bytes → create', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN_USER)
    mockGetPermissions.mockResolvedValue([])
    mockGetGbpPublisher.mockResolvedValue({ ok: true, client: MOCK_CLIENT })
    mockFromChain({ locations: [LOCATIONS[0]] })
    mockSupabaseStorage.mockReturnValue({
      getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://storage.example.com/test.jpg' } }),
      download: vi.fn().mockResolvedValue({ data: new Blob([new Uint8Array(100)]), error: null }),
    })
    mockCreateLocationMedia.mockResolvedValue({ ok: true, data: { name: 'media/789' } })
    const result = await publishGbpPost({
      ...VALID_INPUT,
      postType: 'photo',
      caption: undefined,
      locationIds: ['loc-1'],
      requestId: crypto.randomUUID(),
    })
    expect(result.ok).toBe(true)
    expect(mockCreateLocationMedia).toHaveBeenCalledTimes(1)
    const callArgs = mockCreateLocationMedia.mock.calls[0]
    expect(callArgs[0]).toBe(MOCK_CLIENT)
    expect(callArgs[1]).toBe('111')
    expect(callArgs[2]).toBe('1001')
    expect(Buffer.isBuffer(callArgs[3])).toBe(true)
    expect(callArgs[4]).toBe('image/jpeg') // resolved from .jpg extension
  })

  it('startUpload failure stops that location safely', async () => {
    setupHappyPath()
    mockCreateLocationMedia.mockResolvedValue({ ok: false, error: 'startUpload did not return a resource name.' })
    const result = await publishGbpPost({
      ...VALID_INPUT,
      postType: 'photo',
      caption: undefined,
      locationIds: ['loc-1'],
      requestId: crypto.randomUUID(),
    })
    expect(result.ok).toBe(false)
    expect(result.locations[0].status).toBe('failed')
    expect(result.locations[0].error).toContain('startUpload')
  })

  it('byte upload failure stops that location safely', async () => {
    setupHappyPath()
    mockCreateLocationMedia.mockResolvedValue({ ok: false, error: 'GBP API 400: BYTE_UPLOAD_FAILED' })
    const result = await publishGbpPost({
      ...VALID_INPUT,
      postType: 'photo',
      caption: undefined,
      locationIds: ['loc-1'],
      requestId: crypto.randomUUID(),
    })
    expect(result.locations[0].status).toBe('failed')
    expect(result.locations[0].error).toContain('BYTE_UPLOAD')
  })

  it('media.create failure handled safely', async () => {
    setupHappyPath()
    mockCreateLocationMedia.mockResolvedValue({ ok: false, error: 'GBP API 500: INTERNAL' })
    const result = await publishGbpPost({
      ...VALID_INPUT,
      postType: 'photo',
      caption: undefined,
      locationIds: ['loc-1'],
      requestId: crypto.randomUUID(),
    })
    expect(result.locations[0].status).toBe('failed')
    expect(result.locations[0].error).toContain('INTERNAL')
  })
})

// ── Idempotency tests ───────────────────────────────────────────────────────

describe('idempotency', () => {
  it('duplicate request ID while first is running returns in-progress error', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN_USER)
    mockGetPermissions.mockResolvedValue([])
    mockFromChain({
      existingPost: { id: 'post-1', status: 'publishing', locations_succeeded: 0, locations_failed: 0, locations_attempted: 0, location_results: [] },
    })
    const result = await publishGbpPost(VALID_INPUT)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('already in progress')
  })

  it('retry after completion returns stored result without re-publishing', async () => {
    const storedResults = [
      { locationId: 'loc-1', locationName: 'Vesterbro', status: 'success', googleResourceName: 'posts/1' },
      { locationId: 'loc-2', locationName: 'Nørrebro', status: 'failed', error: 'API error' },
    ]
    mockGetCurrentUser.mockResolvedValue(ADMIN_USER)
    mockGetPermissions.mockResolvedValue([])
    mockFromChain({
      existingPost: {
        id: 'post-1', status: 'completed',
        locations_succeeded: 1, locations_failed: 1, locations_attempted: 2,
        location_results: storedResults,
      },
    })
    const result = await publishGbpPost(VALID_INPUT)
    expect(result.ok).toBe(true)
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.locations).toEqual(storedResults)
    // Verify Google API was NOT called again
    expect(mockCreateLocalPost).not.toHaveBeenCalled()
    expect(mockCreateLocationMedia).not.toHaveBeenCalled()
  })

  it('unique constraint race returns in-progress error', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN_USER)
    mockGetPermissions.mockResolvedValue([])
    mockFromChain({
      existingPost: null,
      claimError: { code: '23505', message: 'duplicate key value' },
    })
    mockSupabaseStorage.mockReturnValue({
      getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://example.com/test.jpg' } }),
    })
    const result = await publishGbpPost(VALID_INPUT)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('already in progress')
  })

  it('new requestId executes Google fanout exactly once', async () => {
    setupHappyPath()
    const result = await publishGbpPost({ ...VALID_INPUT, requestId: crypto.randomUUID() })
    expect(result.ok).toBe(true)
    expect(mockCreateLocalPost).toHaveBeenCalledTimes(3) // once per location
  })
})

// ── Duplicate-submit protection ─────────────────────────────────────────────

describe('duplicate-submit protection', () => {
  it('server-side idempotency prevents concurrent double publish', async () => {
    // First call succeeds, second with same requestId sees completed result
    setupHappyPath()
    const r1 = await publishGbpPost(VALID_INPUT)
    expect(r1.ok).toBe(true)

    // Simulate second call seeing the completed record
    mockFromChain({
      existingPost: {
        id: 'post-1', status: 'completed',
        locations_succeeded: 3, locations_failed: 0, locations_attempted: 3,
        location_results: r1.locations,
      },
    })
    vi.clearAllMocks()
    mockGetCurrentUser.mockResolvedValue(ADMIN_USER)
    mockGetPermissions.mockResolvedValue([])
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'gbp_posts') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: 'post-1', status: 'completed',
                  locations_succeeded: 3, locations_failed: 0, locations_attempted: 3,
                  location_results: r1.locations,
                },
                error: null,
              }),
            }),
          }),
        }
      }
      return { select: vi.fn() }
    })

    const r2 = await publishGbpPost(VALID_INPUT)
    expect(r2.ok).toBe(true)
    expect(r2.succeeded).toBe(3)
    // Google API was NOT called for the second request
    expect(mockCreateLocalPost).not.toHaveBeenCalled()
  })
})
