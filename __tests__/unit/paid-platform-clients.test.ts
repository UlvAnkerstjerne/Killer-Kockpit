import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { updateMetaCampaignStatus, updateMetaCampaignBudget, MetaApiError } from '@/lib/meta/client'
import { updateGoogleCampaignStatus, updateGoogleCampaignBudget } from '@/lib/google/ads-client'

beforeEach(() => { vi.restoreAllMocks(); process.env.META_SYSTEM_USER_TOKEN = 'not-a-real-token'; process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'not-a-real-developer-token' })

describe('narrow paid platform clients', () => {
  it('sends explicit Meta status and budget fields', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"success":true}', { status: 200 }))
    await updateMetaCampaignStatus('123', 'PAUSED'); await updateMetaCampaignBudget('123', 24000)
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(String(fetch.mock.calls[0][1]?.body)).toBe('status=PAUSED')
    expect(String(fetch.mock.calls[1][1]?.body)).toBe('daily_budget=24000')
  })
  it('parses Meta errors without exposing credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":{"message":"denied","code":200,"type":"OAuthException"}}', { status: 400 }))
    await expect(updateMetaCampaignStatus('123', 'ACTIVE')).rejects.toBeInstanceOf(MetaApiError)
  })
  it('uses Google field masks and micros', async () => {
    const request = vi.fn().mockResolvedValue({ data: {} })
    await updateGoogleCampaignStatus({ request } as never, '1234567890', '7', 'PAUSED')
    await updateGoogleCampaignBudget({ request } as never, '1234567890', 'customers/1234567890/campaignBudgets/8', 240000000)
    expect(request.mock.calls[0][0].data.operations[0]).toMatchObject({ updateMask: 'status', update: { status: 'PAUSED' } })
    expect(request.mock.calls[1][0].data.operations[0]).toMatchObject({ updateMask: 'amount_micros', update: { amountMicros: '240000000' } })
  })
})
