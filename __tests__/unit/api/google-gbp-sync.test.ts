import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ user: vi.fn(), sync: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/gbp/sync', () => ({ runGbpSync: mocks.sync }))
import { GET, POST } from '@/app/api/google/gbp/sync/route'
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('CRON_SECRET', 'test-secret'); mocks.sync.mockResolvedValue({ ok: true }) })
describe('GBP sync authorization', () => {
  it.each([undefined, 'Bearer wrong'])('rejects cron requests without the exact secret', async authorization => {
    const response = await POST(new NextRequest('http://localhost/api/google/gbp/sync', { method: 'POST', headers: authorization ? { authorization } : {} }))
    expect(response.status).toBe(401); expect(mocks.sync).not.toHaveBeenCalled()
  })
  it('fails closed when the server secret is absent', async () => {
    vi.stubEnv('CRON_SECRET', '')
    expect((await POST(new NextRequest('http://localhost/api/google/gbp/sync', { method: 'POST' }))).status).toBe(500)
    expect(mocks.sync).not.toHaveBeenCalled()
  })
  it('allows the cron, disables response caching and returns failure HTTP status', async () => {
    mocks.sync.mockResolvedValue({ ok: false, errors: ['GBP_SCOPE_MISSING'] })
    const response = await POST(new NextRequest('http://localhost/api/google/gbp/sync', { method: 'POST', headers: { authorization: 'Bearer test-secret' } }))
    expect(response.status).toBe(502); expect(response.headers.get('cache-control')).toContain('no-store')
  })
  it.each([null, { role: 'UM' }, { role: 'MEMBER' }])('rejects unauthorized manual triggers', async user => {
    mocks.user.mockResolvedValue(user)
    expect((await GET()).status).toBe(user ? 403 : 401); expect(mocks.sync).not.toHaveBeenCalled()
  })
  it('allows the SUPER_ADMIN manual trigger', async () => {
    mocks.user.mockResolvedValue({ role: 'SUPER_ADMIN' }); expect((await GET()).status).toBe(200)
  })
  it('never returns raw unexpected OAuth errors', async () => {
    mocks.user.mockResolvedValue({ role: 'SUPER_ADMIN' }); mocks.sync.mockRejectedValue(new Error('token-secret'))
    const response = await GET(); expect(response.status).toBe(500); expect(await response.text()).not.toContain('token-secret')
  })
})
