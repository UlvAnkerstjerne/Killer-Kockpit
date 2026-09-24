/**
 * Tests for IG account daily insights parsing — specifically the
 * total_value vs values[] response shape handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// We test the parseInsightsBody logic by calling fetchIgAccountDailyInsights
// with mocked fetch responses.

// Mock the auth module
vi.mock('@/lib/meta/auth', () => ({
  getMetaAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
}))

// We'll mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Import after mocking
const { fetchIgAccountDailyInsights } = await import('@/lib/meta/ig-client')

function mockResponse(body: unknown) {
  return { ok: true, json: async () => body }
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('fetchIgAccountDailyInsights parsing', () => {
  it('reads total_value.value for v26 total_value metrics', async () => {
    // Call order: 1) reach, 2) total_value metrics, 3) account object
    mockFetch
      .mockResolvedValueOnce(mockResponse({
        data: [{ name: 'reach', values: [{ value: 5000 }] }],
      }))
      .mockResolvedValueOnce(mockResponse({
        data: [
          { name: 'accounts_engaged', total_value: { value: 227 } },
          { name: 'profile_views', total_value: { value: 228 } },
        ],
      }))
      .mockResolvedValueOnce(mockResponse({ followers_count: 22000 }))

    const result = await fetchIgAccountDailyInsights('ig123', '2026-09-22')
    expect(result.reach).toBe(5000)
    expect(result.accounts_engaged).toBe(227)
    expect(result.profile_views).toBe(228)
    expect(result.followers_count).toBe(22000)
  })

  it('still reads values[0].value for legacy response shape', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({
        data: [{ name: 'reach', values: [{ value: 3000 }] }],
      }))
      .mockResolvedValueOnce(mockResponse({
        data: [
          { name: 'accounts_engaged', values: [{ value: 100 }] },
        ],
      }))
      .mockResolvedValueOnce(mockResponse({ followers_count: 20000 }))

    const result = await fetchIgAccountDailyInsights('ig123', '2026-09-22')
    expect(result.reach).toBe(3000)
    expect(result.accounts_engaged).toBe(100)
  })

  it('returns undefined for missing metrics (not zero)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ data: [] }))
      .mockResolvedValueOnce(mockResponse({ data: [] }))
      .mockResolvedValueOnce(mockResponse({}))

    const result = await fetchIgAccountDailyInsights('ig123', '2026-09-22')
    expect(result.reach).toBeUndefined()
    expect(result.accounts_engaged).toBeUndefined()
    expect(result.profile_views).toBeUndefined()
    expect(result.followers_count).toBeUndefined()
  })

  it('handles total_value request failure gracefully', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({
        data: [{ name: 'reach', values: [{ value: 5000 }] }],
      }))
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValueOnce(mockResponse({ followers_count: 22000 }))

    const result = await fetchIgAccountDailyInsights('ig123', '2026-09-22')
    expect(result.reach).toBe(5000)
    expect(result.accounts_engaged).toBeUndefined()
    expect(result.followers_count).toBe(22000)
  })
})
