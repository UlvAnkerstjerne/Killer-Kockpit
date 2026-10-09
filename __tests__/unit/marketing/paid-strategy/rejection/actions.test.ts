import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), permissions: vi.fn(), service: vi.fn(), client: vi.fn(), reject: vi.fn(), revalidate: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/actions/marketing/permissions', () => ({ getUserMarketingPermissions: mocks.permissions }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.service, createClient: mocks.client }))
vi.mock('@/lib/marketing/paid-strategy/implementation/service', () => ({ rejectImplementation: mocks.reject }))
vi.mock('@/lib/marketing/paid-strategy/implementation/read', () => ({ loadImplementationViews: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
import { rejectStrategyImplementation } from '@/lib/actions/marketing/paid-strategy-implementation'

const RUN = '58000000-0000-4000-8000-000000000002'
const as = (role: string, marketing_access: boolean, permissions: string[]) => { mocks.user.mockResolvedValue({ id: 'user-1', role, marketing_access }); mocks.permissions.mockResolvedValue(permissions) }
beforeEach(() => {
  vi.clearAllMocks(); mocks.user.mockResolvedValue(null); mocks.permissions.mockResolvedValue([]); mocks.service.mockReturnValue({ db: true })
  mocks.reject.mockResolvedValue({ ok: true, duplicate: false, status: 'rejected', message: 'Rejected.', budgetReleasedDkk: 0, metaObjectsExist: false })
})

describe('rejecting is authorised on the server', () => {
  it('refuses unauthenticated callers before the database exists', async () => {
    expect(await rejectStrategyImplementation(RUN, 0)).toMatchObject({ ok: false, error: 'Not authenticated' })
    expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.reject).not.toHaveBeenCalled()
  })
  it('a non-approver cannot reject: paid_manage alone, marketing access alone, no marketing access, or another permission', async () => {
    for (const [role, access, perms] of [['MEMBER', true, ['paid_manage']], ['UM', true, []], ['MEMBER', true, ['creative_manage', 'organic_manage']], ['MEMBER', false, ['paid_approve']]] as const) {
      as(role, access, [...perms])
      expect((await rejectStrategyImplementation(RUN, 0, 'no')).ok, `${role} ${access} ${perms}`).toBe(false)
    }
    expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.reject).not.toHaveBeenCalled()
  })
  it('an approver can reject; only the server-derived identity is passed, with the optional reason, and the Brain is revalidated', async () => {
    as('MEMBER', true, ['paid_approve'])
    expect(await rejectStrategyImplementation(RUN, 2, 'We do not want to advertise catering in Malmö.')).toMatchObject({ ok: true, status: 'rejected' })
    expect(mocks.reject).toHaveBeenCalledWith({ db: true }, 'user-1', RUN, 2, 'We do not want to advertise catering in Malmö.')
    expect(mocks.revalidate).toHaveBeenCalledWith('/marketing/brain')
  })
  it('works with no reason, and SUPER_ADMIN passes exactly as for approval', async () => {
    as('SUPER_ADMIN', false, [])
    expect((await rejectStrategyImplementation(RUN, 1)).ok).toBe(true)
    expect(mocks.reject).toHaveBeenCalledWith({ db: true }, 'user-1', RUN, 1, undefined)
  })
  it('has no actor parameter: the browser cannot say who is rejecting', () => { expect(rejectStrategyImplementation.length).toBe(3) })
})
