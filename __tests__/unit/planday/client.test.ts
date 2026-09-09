/**
 * Tests for lib/planday/client.ts
 *
 * Verifies:
 *   - getPlandayAccessToken: happy path, non-OK response, missing token
 *   - getPortal: happy path, empty portal list
 *   - Pagination: fetchAllPlandayPages terminates when offset >= total
 *   - 429 throws PlandayRateLimitError
 *   - Non-OK responses throw PlandayApiError
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Fetch mock ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockJsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok:     status >= 200 && status < 300,
    status,
    json:   () => Promise.resolve(body),
    headers: new Headers(),
  } as Response)
}

// ── Import under test ────────────────────────────────────────────────────────

import {
  getPlandayAccessToken,
  getPortal,
  getActiveEmployeesWithBirthDate,
  getHistoricalShifts,
  PlandayApiError,
  PlandayRateLimitError,
} from '@/lib/planday/client'

// ── Tests ────────────────────────────────────────────────────────────────────

const CLIENT_ID    = 'cid-123'
const ACCESS_TOKEN = 'at-xyz'
const REFRESH_TOKEN = 'rt-abc'

describe('getPlandayAccessToken', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns access_token on success', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }))
    const token = await getPlandayAccessToken(CLIENT_ID, REFRESH_TOKEN)
    expect(token).toBe(ACCESS_TOKEN)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://id.planday.com/connect/token',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('throws PlandayApiError on non-OK response', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ error: 'invalid_grant' }, 400))
    await expect(getPlandayAccessToken(CLIENT_ID, REFRESH_TOKEN)).rejects.toBeInstanceOf(PlandayApiError)
  })

  it('throws PlandayApiError when access_token missing from response', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ token_type: 'Bearer' }))  // no access_token
    await expect(getPlandayAccessToken(CLIENT_ID, REFRESH_TOKEN)).rejects.toBeInstanceOf(PlandayApiError)
  })
})

describe('getPortal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the first portal', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({
      paging: { offset: 0, limit: 100, total: 1 },
      data: [{ id: 42, name: 'Killer Kebab HQ', subdomain: 'killerkebab' }],
    }))
    const portal = await getPortal(CLIENT_ID, ACCESS_TOKEN)
    expect(portal.id).toBe(42)
    expect(portal.name).toBe('Killer Kebab HQ')
  })

  it('throws PlandayApiError when no portals accessible', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ paging: { offset: 0, limit: 100, total: 0 }, data: [] }))
    await expect(getPortal(CLIENT_ID, ACCESS_TOKEN)).rejects.toBeInstanceOf(PlandayApiError)
  })

  it('sends correct auth headers', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({
      paging: { offset: 0, limit: 100, total: 1 },
      data: [{ id: 1, name: 'Portal', subdomain: 'p' }],
    }))
    await getPortal(CLIENT_ID, ACCESS_TOKEN)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-ClientId']).toBe(CLIENT_ID)
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)
  })
})

describe('getActiveEmployeesWithBirthDate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns all employees from a single page', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({
      paging: { offset: 0, limit: 1000, total: 2 },
      data: [
        { id: 1, firstName: 'Ronnie', lastName: 'Hansen', birthDate: null },
        { id: 2, firstName: 'Sara',   lastName: 'Jørgensen', birthDate: '1990-03-14' },
      ],
    }))
    const emps = await getActiveEmployeesWithBirthDate(CLIENT_ID, ACCESS_TOKEN)
    expect(emps).toHaveLength(2)
    expect(emps[1].birthDate).toBe('1990-03-14')
  })

  it('paginates across multiple pages', async () => {
    // Page 1: 2 employees, total 4
    mockFetch
      .mockReturnValueOnce(mockJsonResponse({
        paging: { offset: 0, limit: 2, total: 4 },
        data: [
          { id: 1, firstName: 'A', lastName: 'B', birthDate: null },
          { id: 2, firstName: 'C', lastName: 'D', birthDate: null },
        ],
      }))
      // Page 2: last 2
      .mockReturnValueOnce(mockJsonResponse({
        paging: { offset: 2, limit: 2, total: 4 },
        data: [
          { id: 3, firstName: 'E', lastName: 'F', birthDate: null },
          { id: 4, firstName: 'G', lastName: 'H', birthDate: null },
        ],
      }))

    const emps = await getActiveEmployeesWithBirthDate(CLIENT_ID, ACCESS_TOKEN)
    expect(emps).toHaveLength(4)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('throws PlandayRateLimitError on 429', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({}, 429))
    await expect(getActiveEmployeesWithBirthDate(CLIENT_ID, ACCESS_TOKEN))
      .rejects.toBeInstanceOf(PlandayRateLimitError)
  })

  it('throws PlandayApiError on other non-OK responses', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ error: 'server error' }, 500))
    await expect(getActiveEmployeesWithBirthDate(CLIENT_ID, ACCESS_TOKEN))
      .rejects.toBeInstanceOf(PlandayApiError)
  })

  it('includes BirthDate special parameter in request', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ paging: { offset: 0, limit: 1000, total: 0 }, data: [] }))
    await getActiveEmployeesWithBirthDate(CLIENT_ID, ACCESS_TOKEN)
    const [url] = mockFetch.mock.calls[0] as [string]
    expect(url).toContain('special=BirthDate')
    expect(url).toContain('/hr/v1.0/employees')
  })
})

describe('getHistoricalShifts', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses 5000 as page size', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ paging: { offset: 0, limit: 5000, total: 0 }, data: [] }))
    await getHistoricalShifts(CLIENT_ID, ACCESS_TOKEN)
    const [url] = mockFetch.mock.calls[0] as [string]
    expect(url).toContain('limit=5000')
  })

  it('defaults fromDate to 2020-01-01', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ paging: { offset: 0, limit: 5000, total: 0 }, data: [] }))
    await getHistoricalShifts(CLIENT_ID, ACCESS_TOKEN)
    const [url] = mockFetch.mock.calls[0] as [string]
    expect(url).toContain('from=2020-01-01')
  })

  it('accepts a custom fromDate', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ paging: { offset: 0, limit: 5000, total: 0 }, data: [] }))
    await getHistoricalShifts(CLIENT_ID, ACCESS_TOKEN, '2018-01-01')
    const [url] = mockFetch.mock.calls[0] as [string]
    expect(url).toContain('from=2018-01-01')
  })
})
