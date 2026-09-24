import { beforeEach, describe, expect, it, vi } from 'vitest'
import { savedRun } from '../../../helpers/creative-brain'
const mocks = vi.hoisted(() => ({ user: vi.fn(), permissions: vi.fn(), client: vi.fn(), service: vi.fn(), generate: vi.fn(), revalidate: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/actions/marketing/permissions', () => ({ getUserMarketingPermissions: mocks.permissions }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client, createServiceClient: mocks.service }))
vi.mock('@/lib/marketing/brain/generate', () => ({ generateCreativeIntelligence: mocks.generate }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
import { getCreativeIntelligence, refreshCreativeIntelligence } from '@/lib/actions/marketing/creative-intelligence'

beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue(null); mocks.permissions.mockResolvedValue([]) })
describe('Creative Brain permissions and persistence reads', () => {
  it('rejects unauthenticated and non-admin refresh before any service access', async () => {
    expect((await refreshCreativeIntelligence()).ok).toBe(false)
    mocks.user.mockResolvedValue({ id: 'u', role: 'UM', marketing_access: true })
    mocks.permissions.mockResolvedValue(['paid_manage'])
    expect((await refreshCreativeIntelligence()).error).toContain('SUPER_ADMIN')
    expect(mocks.service).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })
  it('authorizes the current admin, passes its own identity and revalidates only the new route', async () => {
    mocks.user.mockResolvedValue({ id: 'current-admin', role: 'SUPER_ADMIN', marketing_access: false })
    mocks.service.mockReturnValue({ server: true }); mocks.generate.mockResolvedValue({ ok: true })
    await refreshCreativeIntelligence(true)
    expect(mocks.generate).toHaveBeenCalledWith({ server: true }, 'current-admin', { force: true })
    expect(mocks.revalidate).toHaveBeenCalledWith('/marketing/brain')
  })
  it('requires workspace access and Organic permission independently', async () => {
    for (const [marketing_access, permissions] of [[false, ['paid_manage']], [true, []]] as const) {
      mocks.user.mockResolvedValue({ id: 'u', role: 'MEMBER', marketing_access })
      mocks.permissions.mockResolvedValue(permissions)
      expect((await getCreativeIntelligence()).allowed).toBe(false)
    }
    expect(mocks.client).not.toHaveBeenCalled()
    expect(mocks.service).not.toHaveBeenCalled()
  })
  it('loads the latest persisted usable run using user JWT + RLS without AI calls', async () => {
    mocks.user.mockResolvedValue({ id: 'reader', role: 'MEMBER', marketing_access: true }); mocks.permissions.mockResolvedValue(['paid_manage'])
    const result = savedRun()
    const single = vi.fn().mockResolvedValueOnce({ data: result, error: null }).mockResolvedValueOnce({ data: { status: 'completed', error: null }, error: null })
    const chain = { select: vi.fn(), in: vi.fn(), order: vi.fn(), limit: vi.fn(), maybeSingle: single }
    for (const name of ['select', 'in', 'order', 'limit'] as const) chain[name].mockReturnValue(chain)
    mocks.client.mockResolvedValue({ from: vi.fn(() => chain) })
    const data = await getCreativeIntelligence()
    expect(data).toMatchObject({ allowed: true, canRefresh: false, run: result })
    expect(chain.in).toHaveBeenCalledWith('status', ['completed', 'partial'])
    expect(chain.order).toHaveBeenCalledWith('generated_at', { ascending: false })
    expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled()
  })
  it('distinguishes storage failure from a genuinely empty first run', async () => {
    mocks.user.mockResolvedValue({ id: 'u', role: 'SUPER_ADMIN' })
    const chain = { select: vi.fn(), in: vi.fn(), order: vi.fn(), limit: vi.fn(), maybeSingle: vi.fn(async () => ({ data: null, error: { code: '42P01' } })) }
    for (const name of ['select', 'in', 'order', 'limit'] as const) chain[name].mockReturnValue(chain)
    mocks.client.mockResolvedValue({ from: () => chain })
    expect((await getCreativeIntelligence()).error).toContain('storage is unavailable')
  })
})
