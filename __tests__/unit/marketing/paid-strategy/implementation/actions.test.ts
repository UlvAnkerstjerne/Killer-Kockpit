import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), permissions: vi.fn(), service: vi.fn(), client: vi.fn(), prepare: vi.fn(), confirm: vi.fn(), revalidate: vi.fn(), views: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/actions/marketing/permissions', () => ({ getUserMarketingPermissions: mocks.permissions }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.service, createClient: mocks.client }))
vi.mock('@/lib/marketing/paid-strategy/implementation/service', () => ({ prepareImplementation: mocks.prepare, confirmImplementation: mocks.confirm }))
vi.mock('@/lib/marketing/paid-strategy/implementation/read', () => ({ loadImplementationViews: mocks.views }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
import { confirmStrategyImplementation, getStrategyImplementations, prepareStrategyImplementation } from '@/lib/actions/marketing/paid-strategy-implementation'

const RUN = '58000000-0000-4000-8000-000000000002'
const as = (role: string, marketing_access: boolean, permissions: string[]) => {
  mocks.user.mockResolvedValue({ id: 'user-1', role, marketing_access }); mocks.permissions.mockResolvedValue(permissions)
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.user.mockResolvedValue(null); mocks.permissions.mockResolvedValue([])
  mocks.service.mockReturnValue({ from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [{ id: 'u1', display_name: 'Adam' }] }) }) }) }) })
  mocks.prepare.mockResolvedValue({ ok: true, alreadyStarted: false, preview: {}, targets: [], defaults: {} })
  mocks.confirm.mockResolvedValue({ ok: true, duplicate: false, status: 'started', message: 'ok' })
})

describe('confirmation is authorised on the server', () => {
  it('rejects unauthenticated callers before the database is created', async () => {
    expect(await confirmStrategyImplementation(RUN, 0)).toMatchObject({ ok: false, error: 'Not authenticated' })
    expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled()
  })
  it('requires paid_approve: paid_manage alone, marketing access alone, or any other permission is refused', async () => {
    for (const [role, access, perms] of [['MEMBER', true, ['paid_manage']], ['UM', true, []], ['MEMBER', true, ['creative_manage', 'organic_manage']], ['MEMBER', false, ['paid_approve']]] as const) {
      as(role, access, [...perms])
      expect((await confirmStrategyImplementation(RUN, 0)).ok, `${role} ${access} ${perms}`).toBe(false)
    }
    expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled()
  })
  it('uses the same authority check as Paid Recommendations approval: SUPER_ADMIN passes it, exactly as there', async () => {
    as('SUPER_ADMIN', false, [])
    expect((await confirmStrategyImplementation(RUN, 0)).ok).toBe(true)
  })
  it('lets an approver confirm, passing only the server-derived identity, and revalidates the Brain', async () => {
    as('MEMBER', true, ['paid_approve'])
    expect(await confirmStrategyImplementation(RUN, 2, { reserveBudgetDkk: 100 })).toMatchObject({ ok: true })
    expect(mocks.confirm).toHaveBeenCalledWith({ from: expect.any(Function) }, 'user-1', RUN, 2, { reserveBudgetDkk: 100 })
    expect(mocks.revalidate).toHaveBeenCalledWith('/marketing/brain')
  })
  it('does not trust an actor passed by the browser: the signature has no actor parameter', () => {
    expect(confirmStrategyImplementation.length).toBe(3)
    expect(prepareStrategyImplementation.length).toBe(3)
  })
})

describe('preparing needs paid_manage and shows approval only to approvers', () => {
  it('rejects users without paid_manage', async () => {
    as('MEMBER', true, ['paid_approve']); expect((await prepareStrategyImplementation(RUN, 0)).ok).toBe(false)
    as('MEMBER', false, ['paid_manage']); expect((await prepareStrategyImplementation(RUN, 0)).ok).toBe(false)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
  it('a manager can prepare but cannot confirm; an approver also gets the owner list', async () => {
    as('MEMBER', true, ['paid_manage'])
    expect(await prepareStrategyImplementation(RUN, 0)).toMatchObject({ ok: true, canConfirm: false, owners: undefined })
    as('MEMBER', true, ['paid_manage', 'paid_approve'])
    expect(await prepareStrategyImplementation(RUN, 0)).toMatchObject({ ok: true, canConfirm: true, owners: [{ id: 'u1', name: 'Adam' }] })
  })
})

describe('reading implementation state', () => {
  it('shows nothing to readers without paid_manage and only offers the button to approvers', async () => {
    as('MEMBER', true, [])
    expect(await getStrategyImplementations()).toEqual({ canApprove: false, views: [], error: null })
    expect(mocks.client).not.toHaveBeenCalled()
    as('MEMBER', true, ['paid_manage'])
    mocks.client.mockResolvedValue({ from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [{ id: RUN }], error: null }) }) }) }) }) })
    mocks.views.mockResolvedValue({ views: [{ id: 'i1' }], error: false })
    expect(await getStrategyImplementations()).toMatchObject({ canApprove: false, views: [{ id: 'i1' }], error: null })
    as('MEMBER', true, ['paid_manage', 'paid_approve'])
    expect((await getStrategyImplementations()).canApprove).toBe(true)
  })
})
