/**
 * Tests for Drive Phase C1.
 *
 * Coverage:
 *  • parseDriveUrl — all supported URL formats, invalid inputs, resourceKey
 *  • getDriveFileTypeLabel — MIME type display labels
 *  • canManageDriveReferences — permission matrix across roles and meeting statuses
 *  • attachDriveFile — auth, scope, and permission guards (DB + Drive API mocked)
 *  • detachDriveFile — auth and permission guards (DB mocked)
 *
 * Strategy for pure functions (parseDriveUrl, getDriveFileTypeLabel):
 *   Imported directly from the real module — no mocking needed.
 *
 * Strategy for action tests:
 *   vi.mock uses vi.importActual so parseDriveUrl uses its real implementation.
 *   Only fetchDriveFileMeta is replaced with a vi.fn().  This means the URL
 *   parse guard tests use genuinely invalid URLs rather than mocked null returns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseDriveUrl, getDriveFileTypeLabel } from '@/lib/google/drive'
import { canManageDriveReferences } from '@/lib/permissions'

// ─── parseDriveUrl ────────────────────────────────────────────────────────────

describe('parseDriveUrl', () => {
  // ── Valid URLs ─────────────────────────────────────────────────────────────

  it('parses a Google Docs URL', () => {
    const result = parseDriveUrl(
      'https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit',
    )
    expect(result).toEqual({
      fileId:      '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
      resourceKey: null,
    })
  })

  it('parses a Google Sheets URL', () => {
    const result = parseDriveUrl(
      'https://docs.google.com/spreadsheets/d/1abc-XYZ_sheet/edit#gid=0',
    )
    expect(result).toEqual({ fileId: '1abc-XYZ_sheet', resourceKey: null })
  })

  it('parses a Google Slides URL', () => {
    const result = parseDriveUrl(
      'https://docs.google.com/presentation/d/1SlideFileId/edit',
    )
    expect(result).toEqual({ fileId: '1SlideFileId', resourceKey: null })
  })

  it('parses a Google Forms URL', () => {
    const result = parseDriveUrl(
      'https://docs.google.com/forms/d/1FormFileId/edit',
    )
    expect(result).toEqual({ fileId: '1FormFileId', resourceKey: null })
  })

  it('parses a drive.google.com file URL', () => {
    const result = parseDriveUrl(
      'https://drive.google.com/file/d/1PdfFileId/view',
    )
    expect(result).toEqual({ fileId: '1PdfFileId', resourceKey: null })
  })

  it('parses a legacy drive.google.com/open?id= URL', () => {
    const result = parseDriveUrl(
      'https://drive.google.com/open?id=1LegacyFileId',
    )
    expect(result).toEqual({ fileId: '1LegacyFileId', resourceKey: null })
  })

  it('parses a legacy drive.google.com/uc?id= URL', () => {
    const result = parseDriveUrl(
      'https://drive.google.com/uc?id=1UcFileId',
    )
    expect(result).toEqual({ fileId: '1UcFileId', resourceKey: null })
  })

  // ── resourceKey handling ───────────────────────────────────────────────────

  it('extracts resourcekey query param (lowercase)', () => {
    const result = parseDriveUrl(
      'https://drive.google.com/file/d/1SharedFileId/view?resourcekey=0-abc123XYZ',
    )
    expect(result).toEqual({
      fileId:      '1SharedFileId',
      resourceKey: '0-abc123XYZ',
    })
  })

  it('extracts resourceKey query param (mixed case)', () => {
    const result = parseDriveUrl(
      'https://docs.google.com/document/d/1DocId/edit?resourceKey=0-UPPERCASE',
    )
    expect(result).toEqual({
      fileId:      '1DocId',
      resourceKey: '0-UPPERCASE',
    })
  })

  it('trims whitespace around pasted URLs', () => {
    const result = parseDriveUrl(
      '  https://docs.google.com/document/d/1DocWithSpaces/edit  ',
    )
    expect(result).not.toBeNull()
    expect(result?.fileId).toBe('1DocWithSpaces')
  })

  // ── Invalid inputs ─────────────────────────────────────────────────────────

  it('returns null for a non-Google URL', () => {
    expect(parseDriveUrl('https://example.com/document/d/1fileId/edit')).toBeNull()
  })

  it('returns null for a Notion URL', () => {
    expect(parseDriveUrl('https://notion.so/page-1234')).toBeNull()
  })

  it('returns null for a plain string (not a URL)', () => {
    expect(parseDriveUrl('not a url at all')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseDriveUrl('')).toBeNull()
  })

  it('returns null for a Google URL with no file ID', () => {
    expect(parseDriveUrl('https://drive.google.com/')).toBeNull()
  })

  it('returns null for a file ID containing invalid characters', () => {
    // URL constructor percent-encodes angle brackets, so the resulting path
    // segment will not match the allowed character set
    expect(parseDriveUrl('https://docs.google.com/document/d/<script>/edit')).toBeNull()
  })

  it('does not enforce a minimum or maximum ID length', () => {
    // Short ID — valid characters, should parse (Drive API is the authority)
    const short = parseDriveUrl('https://drive.google.com/file/d/abc/view')
    expect(short).not.toBeNull()
    expect(short?.fileId).toBe('abc')

    // Very long ID — still valid characters, should parse
    const longId = 'a'.repeat(80)
    const long = parseDriveUrl(`https://drive.google.com/file/d/${longId}/view`)
    expect(long).not.toBeNull()
    expect(long?.fileId).toBe(longId)
  })
})

// ─── getDriveFileTypeLabel ────────────────────────────────────────────────────

describe('getDriveFileTypeLabel', () => {
  it('returns Docs for Google Docs MIME type', () => {
    expect(getDriveFileTypeLabel('application/vnd.google-apps.document')).toBe('Docs')
  })

  it('returns Sheets for Google Sheets MIME type', () => {
    expect(getDriveFileTypeLabel('application/vnd.google-apps.spreadsheet')).toBe('Sheets')
  })

  it('returns Slides for Google Slides MIME type', () => {
    expect(getDriveFileTypeLabel('application/vnd.google-apps.presentation')).toBe('Slides')
  })

  it('returns Forms for Google Forms MIME type', () => {
    expect(getDriveFileTypeLabel('application/vnd.google-apps.form')).toBe('Forms')
  })

  it('returns PDF for application/pdf', () => {
    expect(getDriveFileTypeLabel('application/pdf')).toBe('PDF')
  })

  it('returns File for unknown MIME types', () => {
    expect(getDriveFileTypeLabel('application/zip')).toBe('File')
    expect(getDriveFileTypeLabel('image/png')).toBe('File')
    expect(getDriveFileTypeLabel('')).toBe('File')
  })
})

// ─── canManageDriveReferences ─────────────────────────────────────────────────

describe('canManageDriveReferences', () => {
  const OWNER_ID = 'owner-uuid'
  const OTHER_ID = 'other-uuid'

  // ── Cancelled meetings — nobody can attach ─────────────────────────────────

  it('blocks SUPER_ADMIN on cancelled meeting', () => {
    expect(canManageDriveReferences('SUPER_ADMIN', OWNER_ID, OWNER_ID, 'cancelled')).toBe(false)
  })

  it('blocks UM on cancelled meeting', () => {
    expect(canManageDriveReferences('UM', OWNER_ID, OTHER_ID, 'cancelled')).toBe(false)
  })

  it('blocks MEMBER on cancelled meeting', () => {
    expect(canManageDriveReferences('MEMBER', OWNER_ID, OWNER_ID, 'cancelled')).toBe(false)
  })

  it('treats null status as non-cancelled — SUPER_ADMIN passes', () => {
    expect(canManageDriveReferences('SUPER_ADMIN', OWNER_ID, OWNER_ID, null)).toBe(true)
  })

  // ── Published meetings — management may still attach ──────────────────────

  it('allows SUPER_ADMIN on published meeting', () => {
    expect(canManageDriveReferences('SUPER_ADMIN', OTHER_ID, OWNER_ID, 'published')).toBe(true)
  })

  it('allows UM on published meeting (not owner)', () => {
    expect(canManageDriveReferences('UM', OTHER_ID, OTHER_ID, 'published')).toBe(true)
  })

  it('allows meeting owner (MEMBER role) on published meeting', () => {
    expect(canManageDriveReferences('MEMBER', OWNER_ID, OWNER_ID, 'published')).toBe(true)
  })

  it('blocks non-owner MEMBER on published meeting', () => {
    expect(canManageDriveReferences('MEMBER', OWNER_ID, OTHER_ID, 'published')).toBe(false)
  })

  // ── Open / scheduled / draft meetings ─────────────────────────────────────

  it('allows SUPER_ADMIN on open meeting', () => {
    expect(canManageDriveReferences('SUPER_ADMIN', OTHER_ID, OWNER_ID, 'open')).toBe(true)
  })

  it('allows UM on scheduled meeting (not owner)', () => {
    expect(canManageDriveReferences('UM', OTHER_ID, OTHER_ID, 'scheduled')).toBe(true)
  })

  it('allows owner MEMBER on draft meeting', () => {
    expect(canManageDriveReferences('MEMBER', OWNER_ID, OWNER_ID, 'draft')).toBe(true)
  })

  it('blocks non-owner MEMBER on open meeting', () => {
    expect(canManageDriveReferences('MEMBER', OWNER_ID, OTHER_ID, 'open')).toBe(false)
  })
})

// ─── Action mocks ─────────────────────────────────────────────────────────────
//
// vi.mock is hoisted to the top of the file by vitest.  We use vi.importActual
// for lib/google/drive so parseDriveUrl uses its real implementation — this lets
// the URL parse guard tests use genuine invalid URLs rather than mocked returns.
// Only fetchDriveFileMeta is replaced.

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser            = vi.fn()
  const mockGetGoogleConnectionStatus = vi.fn()
  const mockGetGoogleOAuth2Client     = vi.fn()
  const mockHasDriveScope             = vi.fn()
  const mockFetchDriveFileMeta        = vi.fn()
  const mockRevalidatePath            = vi.fn()
  const mockRecordAuditEvent          = vi.fn().mockResolvedValue({ error: null })

  // Single shared mock for .single() — used in sequential DB calls
  const mockSingle      = vi.fn()
  const mockMaybeSingle = vi.fn()
  const mockInsertSelect = vi.fn()
  const mockDeleteEq    = vi.fn().mockResolvedValue({ error: null })

  const mockServiceFrom = vi.fn().mockImplementation((_table: string) => ({
    select: vi.fn().mockReturnValue({
      eq:          vi.fn().mockReturnThis(),
      is:          vi.fn().mockReturnThis(),
      order:       vi.fn().mockReturnThis(),
      single:      mockSingle,
      maybeSingle: mockMaybeSingle,
    }),
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ single: mockInsertSelect }),
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnThis(),
    }),
    delete: vi.fn().mockReturnValue({
      eq: mockDeleteEq,
    }),
  }))

  const mockServiceClient = { from: mockServiceFrom }

  return {
    mockGetCurrentUser,
    mockGetGoogleConnectionStatus,
    mockGetGoogleOAuth2Client,
    mockHasDriveScope,
    mockFetchDriveFileMeta,
    mockRevalidatePath,
    mockRecordAuditEvent,
    mockSingle,
    mockMaybeSingle,
    mockInsertSelect,
    mockDeleteEq,
    mockServiceFrom,
    mockServiceClient,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/audit', () => ({ recordAuditEvent: mocks.mockRecordAuditEvent }))
vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn(),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))
vi.mock('@/lib/google/auth', () => ({
  getGoogleConnectionStatus: mocks.mockGetGoogleConnectionStatus,
  getGoogleOAuth2Client:     mocks.mockGetGoogleOAuth2Client,
  hasDriveScope:             mocks.mockHasDriveScope,
}))

// Use the real parseDriveUrl; only mock fetchDriveFileMeta
vi.mock('@/lib/google/drive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/google/drive')>('@/lib/google/drive')
  return {
    ...actual,
    fetchDriveFileMeta: mocks.mockFetchDriveFileMeta,
  }
})

import { attachDriveFile, detachDriveFile } from '@/lib/actions/drive'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SUPER_ADMIN = { id: 'admin-id', role: 'SUPER_ADMIN' as const, active: true, display_name: 'Admin', email: 'a@k.com' }
const UM_USER     = { id: 'um-id',    role: 'UM' as const,          active: true, display_name: 'UM',    email: 'u@k.com' }
const MEMBER_USER = { id: 'mem-id',   role: 'MEMBER' as const,      active: true, display_name: 'Mem',   email: 'm@k.com' }
const PROJECT_ID  = 'proj-uuid'
const MEETING_ID  = 'meet-uuid'

const VALID_DRIVE_URL   = 'https://drive.google.com/file/d/1ValidFileId/view'
const INVALID_DRIVE_URL = 'https://example.com/not-drive'

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── attachDriveFile — auth guard ─────────────────────────────────────────────

describe('attachDriveFile — auth guard', () => {
  it('returns error when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await attachDriveFile('project', PROJECT_ID, VALID_DRIVE_URL)
    expect(result.error).toMatch(/not authenticated/i)
  })
})

// ─── attachDriveFile — Drive scope guard ─────────────────────────────────────

describe('attachDriveFile — Drive scope guard', () => {
  beforeEach(() => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    // Permission check: project owner matches SUPER_ADMIN
    mocks.mockSingle.mockResolvedValue({ data: { owner_user_id: SUPER_ADMIN.id }, error: null })
  })

  it('returns error when Google not connected', async () => {
    mocks.mockGetGoogleConnectionStatus.mockResolvedValue({ connected: false })
    mocks.mockHasDriveScope.mockReturnValue(false)
    const result = await attachDriveFile('project', PROJECT_ID, VALID_DRIVE_URL)
    expect(result.error).toMatch(/drive.*not connected/i)
  })

  it('returns error when connected but Drive scope not granted', async () => {
    mocks.mockGetGoogleConnectionStatus.mockResolvedValue({
      connected: true, scopes: ['calendar.events'],
    })
    mocks.mockHasDriveScope.mockReturnValue(false)
    const result = await attachDriveFile('project', PROJECT_ID, VALID_DRIVE_URL)
    expect(result.error).toMatch(/drive.*not connected/i)
  })
})

// ─── attachDriveFile — URL parse guard ───────────────────────────────────────

describe('attachDriveFile — URL parse guard', () => {
  beforeEach(() => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSingle.mockResolvedValue({ data: { owner_user_id: SUPER_ADMIN.id }, error: null })
    mocks.mockGetGoogleConnectionStatus.mockResolvedValue({
      connected: true, scopes: ['drive.metadata.readonly'],
    })
    mocks.mockHasDriveScope.mockReturnValue(true)
    mocks.mockGetGoogleOAuth2Client.mockResolvedValue({})
  })

  it('returns error for a non-Google URL', async () => {
    const result = await attachDriveFile('project', PROJECT_ID, INVALID_DRIVE_URL)
    expect(result.error).toMatch(/not a valid google drive/i)
  })

  it('returns error for a plain string (not a URL)', async () => {
    const result = await attachDriveFile('project', PROJECT_ID, 'not a url')
    expect(result.error).toMatch(/not a valid google drive/i)
  })
})

// ─── attachDriveFile — Drive API error handling ───────────────────────────────

describe('attachDriveFile — Drive API error handling', () => {
  beforeEach(() => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSingle.mockResolvedValue({ data: { owner_user_id: SUPER_ADMIN.id }, error: null })
    mocks.mockGetGoogleConnectionStatus.mockResolvedValue({
      connected: true, scopes: ['drive.metadata.readonly'],
    })
    mocks.mockHasDriveScope.mockReturnValue(true)
    mocks.mockGetGoogleOAuth2Client.mockResolvedValue({})
  })

  it('returns a clear error for a 404 from Drive API', async () => {
    mocks.mockFetchDriveFileMeta.mockResolvedValue({ notFound: true })
    const result = await attachDriveFile('project', PROJECT_ID, VALID_DRIVE_URL)
    expect(result.error).toMatch(/not found/i)
  })

  it('returns a clear error for a 403 from Drive API', async () => {
    mocks.mockFetchDriveFileMeta.mockResolvedValue({ forbidden: true })
    const result = await attachDriveFile('project', PROJECT_ID, VALID_DRIVE_URL)
    expect(result.error).toMatch(/do not have access/i)
  })

  it('returns a generic retry error when Drive API throws unexpectedly', async () => {
    mocks.mockFetchDriveFileMeta.mockRejectedValue(new Error('Network error'))
    const result = await attachDriveFile('project', PROJECT_ID, VALID_DRIVE_URL)
    expect(result.error).toMatch(/could not reach/i)
  })
})

// ─── attachDriveFile — project permission guard ───────────────────────────────

describe('attachDriveFile — project permission guard', () => {
  beforeEach(() => {
    mocks.mockGetGoogleConnectionStatus.mockResolvedValue({
      connected: true, scopes: ['drive.metadata.readonly'],
    })
    mocks.mockHasDriveScope.mockReturnValue(true)
    mocks.mockGetGoogleOAuth2Client.mockResolvedValue({})
    mocks.mockFetchDriveFileMeta.mockResolvedValue({ notFound: true }) // stop after permission check
  })

  it('blocks a MEMBER who does not own the project', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSingle.mockResolvedValue({ data: { owner_user_id: 'someone-else' }, error: null })
    const result = await attachDriveFile('project', PROJECT_ID, VALID_DRIVE_URL)
    expect(result.error).toMatch(/permission/i)
  })

  it('allows a MEMBER who owns the project', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSingle.mockResolvedValue({ data: { owner_user_id: MEMBER_USER.id }, error: null })
    // Permission passes — Drive API returns notFound (file doesn't matter for this test)
    const result = await attachDriveFile('project', PROJECT_ID, VALID_DRIVE_URL)
    expect(result.error).toMatch(/not found/i) // passed permission, hit Drive API guard
  })

  it('allows SUPER_ADMIN regardless of project owner', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSingle.mockResolvedValue({ data: { owner_user_id: 'anyone' }, error: null })
    const result = await attachDriveFile('project', PROJECT_ID, VALID_DRIVE_URL)
    expect(result.error).toMatch(/not found/i) // passed permission, hit Drive API guard
  })
})

// ─── attachDriveFile — meeting permission guard ───────────────────────────────

describe('attachDriveFile — meeting permission guard', () => {
  beforeEach(() => {
    mocks.mockGetGoogleConnectionStatus.mockResolvedValue({
      connected: true, scopes: ['drive.metadata.readonly'],
    })
    mocks.mockHasDriveScope.mockReturnValue(true)
    mocks.mockGetGoogleOAuth2Client.mockResolvedValue({})
    mocks.mockFetchDriveFileMeta.mockResolvedValue({ notFound: true })
  })

  it('blocks a MEMBER who does not own the meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSingle.mockResolvedValue({
      data: { owner_user_id: 'someone-else', status: 'published' }, error: null,
    })
    const result = await attachDriveFile('meeting', MEETING_ID, VALID_DRIVE_URL)
    expect(result.error).toMatch(/permission/i)
  })

  it('allows UM on published meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSingle.mockResolvedValue({
      data: { owner_user_id: 'someone-else', status: 'published' }, error: null,
    })
    const result = await attachDriveFile('meeting', MEETING_ID, VALID_DRIVE_URL)
    expect(result.error).toMatch(/not found/i) // passed permission, hit Drive API guard
  })

  it('blocks everyone on cancelled meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSingle.mockResolvedValue({
      data: { owner_user_id: SUPER_ADMIN.id, status: 'cancelled' }, error: null,
    })
    const result = await attachDriveFile('meeting', MEETING_ID, VALID_DRIVE_URL)
    expect(result.error).toMatch(/permission/i)
  })
})

// ─── detachDriveFile — auth and permission guards ─────────────────────────────

describe('detachDriveFile — auth guard', () => {
  it('returns error when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await detachDriveFile('project', PROJECT_ID, 'es-uuid')
    expect(result.error).toMatch(/not authenticated/i)
  })
})

describe('detachDriveFile — project permission guard', () => {
  it('blocks a MEMBER who does not own the project', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSingle.mockResolvedValue({ data: { owner_user_id: 'someone-else' }, error: null })
    const result = await detachDriveFile('project', PROJECT_ID, 'es-uuid')
    expect(result.error).toMatch(/permission/i)
  })
})

describe('detachDriveFile — meeting permission guard', () => {
  it('blocks a MEMBER who does not own the meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSingle.mockResolvedValue({
      data: { owner_user_id: 'someone-else', status: 'published' }, error: null,
    })
    const result = await detachDriveFile('meeting', MEETING_ID, 'es-uuid')
    expect(result.error).toMatch(/permission/i)
  })

  it('blocks UM on a cancelled meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSingle.mockResolvedValue({
      data: { owner_user_id: 'someone-else', status: 'cancelled' }, error: null,
    })
    const result = await detachDriveFile('meeting', MEETING_ID, 'es-uuid')
    expect(result.error).toMatch(/permission/i)
  })

  it('allows owner MEMBER to detach from published meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    // Permission check passes (owner_user_id matches)
    mocks.mockSingle
      .mockResolvedValueOnce({ data: { owner_user_id: MEMBER_USER.id, status: 'published' }, error: null })
      // entity_source lookup returns the link row
      .mockResolvedValueOnce({
        data: { id: 'es-uuid', source_id: 'src-uuid', source: { external_id: 'fileid', title: 'Doc' } },
        error: null,
      })
    mocks.mockDeleteEq.mockResolvedValue({ error: null })
    const result = await detachDriveFile('meeting', MEETING_ID, 'es-uuid')
    expect(result.error).toBeUndefined()
  })
})
