import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), permissions: vi.fn(), service: vi.fn(), client: vi.fn(), prepare: vi.fn(), confirm: vi.fn(), resume: vi.fn(), activate: vi.fn(), cancel: vi.fn(), revalidate: vi.fn(), views: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/actions/marketing/permissions', () => ({ getUserMarketingPermissions: mocks.permissions }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.service, createClient: mocks.client }))
vi.mock('@/lib/marketing/paid-strategy/implementation/service', () => ({ prepareImplementation: mocks.prepare, confirmImplementation: mocks.confirm, resumeImplementation: mocks.resume, activateImplementation: mocks.activate, cancelImplementation: mocks.cancel }))
vi.mock('@/lib/marketing/paid-strategy/implementation/read', () => ({ loadImplementationViews: mocks.views }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
import { activateStrategyImplementation, cancelStrategyImplementation, confirmStrategyImplementation, getStrategyImplementations, prepareStrategyImplementation, resumeStrategyImplementation } from '@/lib/actions/marketing/paid-strategy-implementation'

const RUN = '58000000-0000-4000-8000-000000000002'
const as = (role: string, marketing_access: boolean, permissions: string[]) => {
  mocks.user.mockResolvedValue({ id: 'user-1', role, marketing_access }); mocks.permissions.mockResolvedValue(permissions)
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.user.mockResolvedValue(null); mocks.permissions.mockResolvedValue([])
  mocks.service.mockReturnValue({ from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [{ id: 'u1', display_name: 'Adam' }] }) }) }) }) })
  mocks.prepare.mockResolvedValue({ ok: true, alreadyStarted: false, preview: {}, targets: [], defaults: {} })
  mocks.confirm.mockResolvedValue({ ok: true, duplicate: false, status: 'ready_to_activate', message: 'ok' })
  for (const m of [mocks.resume, mocks.activate, mocks.cancel]) m.mockResolvedValue({ ok: true, duplicate: false, status: 'in_motion', message: 'ok' })
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
    expect(await confirmStrategyImplementation(RUN, 2, { campaign: { dailyBudgetDkk: 100 } })).toMatchObject({ ok: true })
    expect(mocks.confirm).toHaveBeenCalledWith({ from: expect.any(Function) }, 'user-1', RUN, 2, { campaign: { dailyBudgetDkk: 100 } })
    expect(mocks.revalidate).toHaveBeenCalledWith('/marketing/brain')
  })
  it('does not trust an actor passed by the browser: the signature has no actor parameter', () => {
    expect(confirmStrategyImplementation.length).toBe(3)
    expect(prepareStrategyImplementation.length).toBe(3)
  })
})

describe('every action that changes anything needs paid_approve, enforced on the server', () => {
  const actions: [string, () => Promise<{ ok: boolean }>, ReturnType<typeof vi.fn>][] = [
    ['resume', () => resumeStrategyImplementation(RUN, 0), mocks.resume], ['activate', () => activateStrategyImplementation(RUN, 0), mocks.activate], ['cancel', () => cancelStrategyImplementation(RUN, 0), mocks.cancel],
  ]
  it.each(actions)('%s is refused for unauthenticated users, paid_manage-only users and users without marketing access, before the database exists', async (_n, call, service) => {
    expect((await call()).ok).toBe(false)
    for (const [role, access, perms] of [['MEMBER', true, ['paid_manage']], ['UM', true, []], ['MEMBER', false, ['paid_approve']]] as const) { as(role, access, [...perms]); expect((await call()).ok, `${role} ${access} ${perms}`).toBe(false) }
    expect(mocks.service).not.toHaveBeenCalled(); expect(service).not.toHaveBeenCalled()
  })
  it.each(actions)('%s runs for an approver with the server-derived identity and refreshes the Brain', async (_n, call, service) => {
    as('MEMBER', true, ['paid_approve']); expect((await call()).ok).toBe(true)
    expect(service).toHaveBeenCalledWith({ from: expect.any(Function) }, 'user-1', RUN, 0, ...(service === mocks.resume ? [undefined] : [])); expect(mocks.revalidate).toHaveBeenCalledWith('/marketing/brain')
  })
  it('none of them accept an actor from the browser', () => { expect(resumeStrategyImplementation.length).toBe(3); expect(activateStrategyImplementation.length).toBe(2); expect(cancelStrategyImplementation.length).toBe(2) })
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
