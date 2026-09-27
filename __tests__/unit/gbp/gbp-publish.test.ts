/**
 * Tests for GBP publishing: location resolution, payload construction,
 * fanout behaviour, validation, and permission checks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  createServiceClient: () => {
    const client = {
      from: mockSupabaseFrom,
      storage: { from: mockSupabaseStorage },
    }
    return client
  },
}))
vi.mock('@/lib/google/gbp-client', () => ({
  createLocalPost: (...args: unknown[]) => mockCreateLocalPost(...args),
  createLocationMedia: (...args: unknown[]) => mockCreateLocationMedia(...args),
}))
vi.mock('@/lib/gbp/review-publish', () => ({
  getGbpPublisher: () => mockGetGbpPublisher(),
}))

// Must import after mocks
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

const VALID_INPUT = {
  postType: 'local_post' as const,
  caption: 'New kebab flavour this week!',
  imageStoragePath: 'posts/abc.jpg',
  imagePublicUrl: 'https://storage.example.com/posts/abc.jpg',
  imageMimeType: 'image/jpeg',
  locationIds: ['loc-1', 'loc-2', 'loc-3'],
}

const MOCK_CLIENT = { getAccessToken: vi.fn() }

function setupHappyPath() {
  mockGetCurrentUser.mockResolvedValue(ADMIN_USER)
  mockGetPermissions.mockResolvedValue([])
  mockGetGbpPublisher.mockResolvedValue({ ok: true, client: MOCK_CLIENT })
  mockSupabaseFrom.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({ data: LOCATIONS, error: null }),
      }),
    }),
    insert: vi.fn().mockResolvedValue({ error: null }),
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
    mockSupabaseFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ data: [LOCATIONS[0]], error: null }),
        }),
      }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    })
    mockCreateLocalPost.mockResolvedValue({ ok: true, data: { name: 'posts/123' } })
    const result = await publishGbpPost({ ...VALID_INPUT, locationIds: ['loc-1'] })
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
    const result = await publishGbpPost({ ...VALID_INPUT, locationIds: [] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('location')
  })

  it('rejects missing image', async () => {
    const result = await publishGbpPost({ ...VALID_INPUT, imageStoragePath: '', imagePublicUrl: '' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Image')
  })

  it('rejects invalid image mime type', async () => {
    const result = await publishGbpPost({ ...VALID_INPUT, imageMimeType: 'image/gif' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('JPEG, PNG, or WebP')
  })

  it('rejects local_post without caption', async () => {
    const result = await publishGbpPost({ ...VALID_INPUT, caption: '' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Caption')
  })

  it('rejects caption over 1500 characters', async () => {
    const result = await publishGbpPost({ ...VALID_INPUT, caption: 'x'.repeat(1501) })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('1500')
  })

  it('allows photo without caption', async () => {
    setupHappyPath()
    // For photo mode, set up storage download mock
    mockSupabaseStorage.mockReturnValue({
      download: vi.fn().mockResolvedValue({
        data: new Blob([new Uint8Array(100)]),
        error: null,
      }),
    })
    mockCreateLocationMedia.mockResolvedValue({ ok: true, data: { name: 'media/456' } })
    const result = await publishGbpPost({
      ...VALID_INPUT,
      postType: 'photo',
      caption: undefined,
      locationIds: ['loc-1'],
    })
    expect(result.ok).toBe(true)
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

  it('resolves subset of locations', async () => {
    mockSupabaseFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ data: [LOCATIONS[0], LOCATIONS[1]], error: null }),
        }),
      }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    })
    mockCreateLocalPost.mockResolvedValue({ ok: true, data: { name: 'posts/123' } })
    const result = await publishGbpPost({ ...VALID_INPUT, locationIds: ['loc-1', 'loc-2'] })
    expect(result.total).toBe(2)
    expect(mockCreateLocalPost).toHaveBeenCalledTimes(2)
  })

  it('rejects when no valid locations found (browser-supplied IDs not in DB)', async () => {
    mockSupabaseFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    })
    const result = await publishGbpPost({ ...VALID_INPUT, locationIds: ['fake-id'] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No valid')
  })

  it('uses trusted google_account_id and google_location_id from DB rows', async () => {
    setupHappyPath()
    await publishGbpPost({ ...VALID_INPUT, locationIds: ['loc-1'] })
    expect(mockCreateLocalPost).toHaveBeenCalledWith(
      MOCK_CLIENT,
      '111',      // trusted google_account_id from DB
      '1001',     // trusted google_location_id from DB
      VALID_INPUT.caption,
      VALID_INPUT.imagePublicUrl,
    )
  })
})

// ── Fanout behaviour tests ──────────────────────────────────────────────────

describe('multi-location fanout', () => {
  beforeEach(() => {
    setupHappyPath()
  })

  it('continues after one location fails', async () => {
    mockCreateLocalPost
      .mockResolvedValueOnce({ ok: true, data: { name: 'posts/1' } })
      .mockResolvedValueOnce({ ok: false, error: 'permission denied' })
      .mockResolvedValueOnce({ ok: true, data: { name: 'posts/3' } })

    const result = await publishGbpPost(VALID_INPUT)
    expect(result.ok).toBe(true)
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.total).toBe(3)
    expect(result.locations[1].status).toBe('failed')
    expect(result.locations[1].error).toBe('permission denied')
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

  it('includes google resource name on success', async () => {
    const result = await publishGbpPost(VALID_INPUT)
    expect(result.locations[0].googleResourceName).toBe('posts/123')
  })

  it('includes location name in results', async () => {
    const result = await publishGbpPost(VALID_INPUT)
    expect(result.locations.map(l => l.locationName)).toEqual(['Vesterbro', 'Nørrebro', 'Frederiksberg'])
  })
})

// ── Post payload tests ──────────────────────────────────────────────────────

describe('post payload', () => {
  it('passes caption and image URL for local_post', async () => {
    setupHappyPath()
    await publishGbpPost({ ...VALID_INPUT, locationIds: ['loc-1'] })
    expect(mockCreateLocalPost).toHaveBeenCalledWith(
      MOCK_CLIENT, '111', '1001',
      'New kebab flavour this week!',
      'https://storage.example.com/posts/abc.jpg',
    )
  })
})

// ── Photo upload payload tests ──────────────────────────────────────────────

describe('photo upload payload', () => {
  it('downloads image from storage and passes bytes for photo mode', async () => {
    const fakeBlob = new Blob([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], { type: 'image/png' })
    mockGetCurrentUser.mockResolvedValue(ADMIN_USER)
    mockGetPermissions.mockResolvedValue([])
    mockGetGbpPublisher.mockResolvedValue({ ok: true, client: MOCK_CLIENT })
    mockSupabaseFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ data: [LOCATIONS[0]], error: null }),
        }),
      }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    })
    mockSupabaseStorage.mockReturnValue({
      download: vi.fn().mockResolvedValue({ data: fakeBlob, error: null }),
    })
    mockCreateLocationMedia.mockResolvedValue({ ok: true, data: { name: 'media/789' } })

    const result = await publishGbpPost({
      ...VALID_INPUT,
      postType: 'photo',
      caption: undefined,
      locationIds: ['loc-1'],
    })
    expect(result.ok).toBe(true)
    expect(mockCreateLocationMedia).toHaveBeenCalledTimes(1)
    // Verify it received a Buffer (image bytes)
    const callArgs = mockCreateLocationMedia.mock.calls[0]
    expect(callArgs[0]).toBe(MOCK_CLIENT)
    expect(callArgs[1]).toBe('111')
    expect(callArgs[2]).toBe('1001')
    expect(Buffer.isBuffer(callArgs[3])).toBe(true)
    expect(callArgs[4]).toBe('image/jpeg')
  })
})

// ── Duplicate-submit protection ─────────────────────────────────────────────

describe('duplicate-submit protection', () => {
  it('publishGbpPost is a server action that can be called — client-side protection is in the UI ref guard', async () => {
    // The publishingRef guard in the modal prevents duplicate calls.
    // Server-side, each call is independent and idempotent (creates a new post record).
    // This test verifies the action runs cleanly when called.
    setupHappyPath()
    const [r1, r2] = await Promise.all([
      publishGbpPost(VALID_INPUT),
      publishGbpPost(VALID_INPUT),
    ])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })
})
