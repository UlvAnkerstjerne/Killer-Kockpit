import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }))
vi.mock('@/lib/weekly-impact/dispatch', () => ({ runWeeklyImpactDispatch: dispatch }))
import { GET, POST } from '@/app/api/weekly-impact/deliver/route'
const ulv = '5363b471-b4cb-4156-9e8e-3260d3ecb05e'
function request(body?: string, authorized = true) {
  return new NextRequest('https://kockpit.example/api/weekly-impact/deliver', { method: 'POST', headers: authorized ? { authorization: 'Bearer main-secret' } : {}, body })
}
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('CRON_SECRET', 'main-secret'); dispatch.mockResolvedValue({ status: 'complete', users: 1, sent: 1, skipped: 0, failed: 0 }) })
afterEach(() => vi.unstubAllEnvs())
describe('delivery endpoint', () => {
  it('requires the main app cron secret, including for tests', async () => {
    expect((await POST(request(JSON.stringify({ testUserId: ulv }), false))).status).toBe(401)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('retains the empty-body scheduled endpoint', async () => {
    expect((await POST(request())).status).toBe(200)
    expect(dispatch).toHaveBeenCalledWith(expect.any(Date), undefined)
  })
  it('passes only one validated test recipient to dispatch', async () => {
    expect((await POST(request(JSON.stringify({ testUserId: ulv })))).status).toBe(200)
    expect(dispatch).toHaveBeenCalledWith(expect.any(Date), ulv)
  })
  it.each(['{}', '{"testUserId":""}', '{"force":true}', '{"testUserId":[]}', '{"testUserId":null}', '{"testUserId":"'+ulv+'","force":true}', 'not json'])('fails closed for invalid override %s', async body => {
    expect((await POST(request(body))).status).toBe(400)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('makes failed deliveries visible to cron while preserving retryability', async () => {
    dispatch.mockResolvedValue({ status: 'complete', users: 1, sent: 0, skipped: 0, failed: 1 })
    expect((await POST(request())).status).toBe(503)
  })
  it('does not send on GET', async () => { expect((await GET()).status).toBe(405); expect(dispatch).not.toHaveBeenCalled() })
})
